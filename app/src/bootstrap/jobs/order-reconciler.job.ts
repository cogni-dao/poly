// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/order-reconciler.job`
 * Purpose: Disposable 60s scheduler that reconciles `poly_copy_trade_fills` rows
 * with current CLOB status. For each `pending` / `open` row with a non-null
 * `order_id`, calls `getOrder` and updates the ledger if the status or filled
 * amount has changed. Closes the dashboard lie: rows showing `open` that have
 * already filled or been canceled are now updated within one tick.
 * Scope: Wiring + cadence only. Does not build adapters (container injects),
 * does not own placement logic, does not touch DB directly. Exports
 * `startOrderReconciler(deps) → stop()` and the pure `runReconcileOnce` for
 * unit tests.
 * Invariants:
 *   - SCAFFOLDING_LABELED — this file is `@scaffolding` / `Deleted-in-phase: 4`.
 *     P4's Temporal-hosted WS ingester will provide real-time status updates.
 *   - SINGLE_WRITER — exactly one process runs the reconciler. Enforced by
 *     caller (POLY_ROLE=trader + replicas=1 joint invariant). Boot logs
 *     `event:poly.mirror.reconcile.singleton_claim`.
 *   - TICK_IS_SELF_HEALING — errors are caught per-row; the tick continues for
 *     remaining rows and never crashes the interval.
 *   - NO_REDEMPTION_SYNC_V0 — reconciler only syncs from `getOrder`. Position-
 *     based redemption detection is deferred (task.0329).
 *   - GETORDER_NEVER_NULL — `getOrder` returns `GetOrderResult`; null is never a
 *     valid return. Callers branch on the discriminant. (task.0328 CP1)
 *   - ABSENCE_IS_NOT_NONEXECUTION — neither age nor not_found releases a
 *     reservation. Historical accepted errors and partial orders recover by
 *     authenticated reads only; no PLACE or cancel is issued by this job.
 *   - FAIR_RECOVERY — every attempted row rotates through a timestamp-only
 *     scheduling write, including no-ID, not_found and exception outcomes.
 *   - SYNCED_AT_WRITTEN_ON_EVERY_SYNC — `markSynced` is called for every row
 *     for which `getOrder` returned a typed answer. (task.0328 CP3)
 *   - SYNC_HEALTH_IS_PUBLIC — `reconcilerLastTickAt` is stamped each tick and
 *     surfaced by the `/api/v1/poly/internal/sync-health` endpoint. (task.0328 CP4)
 * Side-effects: starts a `setInterval`, emits logs + metrics.
 * Links: work/items/task.0323 §2, docs/spec/poly-copy-trade-execution.md
 *
 * @scaffolding
 * Deleted-in-phase: 4 (replaced by Temporal-hosted WS ingester workflow; see
 *   work/items/task.0322.poly-copy-trade-phase4-design-prep.md).
 *
 * @internal
 */

// TODO(task.0329): redemption-sync will add `getOperatorPositions` back.
import type {
  LoggerPort,
  MetricsPort,
	OrderReceipt,
  OrderStatus,
} from "@cogni/poly-market-provider";

import {
  type LedgerRow,
  type LedgerStatus,
  ledgerExecutedUsdc,
  type OrderLedger,
	type UpdateStatusInput,
} from "@/features/trading";
import type { ContextualGetOrderResult } from "@/features/trading/fill-accounting";
import type { AcceptedOrderObservation } from "@/features/trading/order-ledger.types";
import { safeErrorDimensions } from "@/shared/observability/safe-error-dimensions";
import { EVENT_NAMES } from "@/shared/observability/events";

// ─────────────────────────────────────────────────────────────────────────────
// Metric names
// ─────────────────────────────────────────────────────────────────────────────

export const ORDER_RECONCILER_METRICS = {
  /** One per tick (regardless of how many rows were processed). */
  ticksTotal: "poly_mirror_reconcile_ticks_total",
  /** One per ledger row whose status was actually changed. */
  updatesTotal: "poly_mirror_reconcile_updates_total",
  /** One per `getOrder` / `updateStatus` error; tick continues for other rows. */
  errorsTotal: "poly_mirror_reconcile_errors_total",
  /**
   * One per row promoted from open/pending → canceled because CLOB returned
   * not_found beyond the grace window. A spike here signals CLOB changed its
   * order-retention / pruning behavior. Alert threshold: >5 in 10 min.
   */
  notFoundUpgradesTotal: "poly_reconciler_not_found_upgrades_total",
  /** One per unplaced row (never got an order id) promoted to canceled. */
  unplacedUpgradesTotal: "poly_reconciler_unplaced_upgrades_total",
} as const;

const RECONCILE_POLL_MS = 60_000;
const DEFAULT_OLDER_THAN_MS = 30_000;
const DEFAULT_LIMIT = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Public interface
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderReconcilerDeps {
  ledger: OrderLedger;
  /**
   * Per-tenant `getOrder`. Each ledger row is attributed to a
   * `billing_account_id`, and each tenant has its own CLOB API creds derived
   * from their Privy signer — so the reconciler must dispatch through the
   * per-tenant `PolyTradeExecutor`. The container wires this by calling
   * `polyTradeExecutorFactory.getPolyTradeExecutorFor(billing_account_id)`
   * and delegating to `executor.getOrder(order_id)`.
   *
   * GETORDER_NEVER_NULL invariant (task.0328 CP1): returns a discriminated
   * `GetOrderResult` — null is never returned.
   */
  getOrderForTenant: (
    billing_account_id: string,
    order_id: string,
		mode: "live" | "paper",
  ) => Promise<ContextualGetOrderResult>;
  logger: LoggerPort;
  metrics: MetricsPort;
  /**
	 * Retained configuration compatibility. Age is never nonexecution proof.
   */
  notFoundGraceMs: number;
  /** Wake an account-local strategy actor after a durable ledger transition. */
  onOrderChanged?: (
    row: LedgerRow,
		change: { status: LedgerStatus; reason?: string; acceptedObservation?: AcceptedOrderObservation },
  ) => void;
  /**
   * Injected clock — returns the current wall time. Defaults to `() => new Date()`
   * at production call sites. Injected in tests for deterministic age calculations.
   * Mirrors the `clock` dep pattern in `mirror-coordinator.ts`.
   */
  clock?: () => Date;
}

/** Stops the reconciler. Returned so the container can call on SIGTERM. */
export type ReconcilerStopFn = () => void;

/**
 * Handle returned by `startOrderReconciler`.
 * `stop` clears the interval; `getLastTickAt` returns the wall time of the last
 * successful tick (after `markSynced` completed), or null before the first tick.
 *
 * SYNC_HEALTH_IS_PUBLIC invariant (task.0328 CP4).
 */
export interface OrderReconcilerHandle {
  stop: ReconcilerStopFn;
  getLastTickAt: () => Date | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Receipt status → LedgerStatus map (mirrors order-ledger.ts `mapReceiptStatus`)
// ─────────────────────────────────────────────────────────────────────────────

function mapReceiptStatus(s: OrderStatus): LedgerStatus {
  switch (s) {
    case "filled":
      return "filled";
    case "partial":
      return "partial";
    case "canceled":
      return "canceled";
    case "open":
      return "open";
    default:
      // Unknown future statuses surface as `open` until CLOB extends the set.
      return "open";
  }
}

/** Paper getOrder returns direct sidecar receipts without a source marker. */
function receiptFillSource(row: LedgerRow, receipt: OrderReceipt) {
  if (receipt.attributes?.realizedFillSource === "clob_associated_trades")
    return "clob_associated_trades" as const;
  if (row.mode === "paper" &&
      (receipt.attributes?.realizedFillSource === undefined ||
        receipt.attributes?.realizedFillSource === "paper_order_receipt"))
    return "paper_order_receipt" as const;
  return undefined;
}

/** A local cancellation acknowledgement is insufficient: use the exact
 * authenticated order's final cumulative observation, with explicit evidence. */
function finalCancellationObservation(
	row: LedgerRow,
	receipt: OrderReceipt,
	observedAt: string,
): UpdateStatusInput["final_order_observation"] {
	if (receipt.status !== "canceled" || receipt.order_id !== row.order_id)
		return undefined;
	const cost = receipt.filled_size_usdc;
	if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
		return undefined;
	const matched = receipt.attributes?.sizeMatched;
	const explicitZero =
		(typeof matched === "number" ||
			(typeof matched === "string" && matched.trim() !== "")) &&
		Number.isFinite(Number(matched)) &&
		Number(matched) === 0;
	const shares = receipt.total_shares;
	const price = receipt.fill_price;
	const coherentFill =
		typeof shares === "number" &&
		Number.isFinite(shares) &&
		shares > 0 &&
		typeof price === "number" &&
		Number.isFinite(price) &&
		price > 0 &&
		cost > 0 &&
		Math.abs(shares * price - cost) <= Math.max(0.000001, cost * 0.000001);
	const evidence =
		receiptFillSource(row, receipt) === "paper_order_receipt" && (cost === 0 || coherentFill)
			? ("paper_order_receipt" as const)
			: cost === 0 && explicitZero
				? ("explicit_zero_size_matched" as const)
				: coherentFill &&
						receipt.attributes?.realizedFillSource === "clob_associated_trades"
					? ("clob_associated_trades" as const)
					: undefined;
	if (!evidence) return undefined;
	return {
		source: "venue_get_order",
		order_id: receipt.order_id,
		status: "canceled",
		filled_size_usdc: cost,
		observed_at: observedAt,
		fill_evidence: evidence,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure tick — exported for unit tests; job shim wraps it in setInterval.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run one reconcile pass. Exported for direct unit-test consumption; the
 * `startOrderReconciler` shim simply calls this inside a `setInterval`.
 *
 * @public
 */
export async function runReconcileOnce(
	deps: OrderReconcilerDeps,
): Promise<void> {
  const log = deps.logger.child({ component: "order-reconciler" });
  const clock = deps.clock ?? (() => new Date());

  const rows: LedgerRow[] = await deps.ledger.listOpenOrPending({
    olderThanMs: DEFAULT_OLDER_THAN_MS,
    limit: DEFAULT_LIMIT,
  });

  // Collect ids for which getOrder returned a typed answer (found OR not_found).
  // Rows where getOrder threw (network error) are excluded — their staleness
  // grows until we can verify. Bulk-stamped via markSynced after the loop.
  // SYNCED_AT_WRITTEN_ON_EVERY_SYNC invariant (task.0328 CP3).
  const syncedIds: string[] = [];

	const attemptedIds: string[] = [];
	let unresolvedIdentityCount = 0;
	try {
  for (const row of rows) {
			attemptedIds.push(row.client_order_id);
			// No exact venue identity exists. Retain the reservation, never guess
			// identity from target fills or infer nonacceptance from elapsed time.
    if (!row.order_id) {
				unresolvedIdentityCount++;
      continue;
    }
    // Diagnostic only: the injected read combines executor construction and wire IO.
    let reconcileStage:
      | "executor_order_read"
      | "validate_order_response"
      | "validate_cumulative_cost"
      | "prepare_status_update"
      | "persist_status"
      | "notify_order_changed"
      | "record_update_metric"
      | "log_status_updated" = "executor_order_read";
    try {
      const result = await deps.getOrderForTenant(
        row.billing_account_id,
        row.order_id,
					row.mode,
      );
      reconcileStage = "validate_order_response";
      if (!result || typeof result !== "object" ||
        (!("found" in result) && result.status !== "not_found")) {
        throw new Error("invalid_order_read_response");
      }
      if (!("found" in result)) {
        syncedIds.push(row.client_order_id);
          log.debug(
            {
              event: EVENT_NAMES.POLY_RECONCILER_NOT_FOUND,
              client_order_id: row.client_order_id,
							errorCode: "order_absence_unresolved",
            },
						"reconciler: order not found; reservation retained",
        );
        continue;
      }
      const receipt = result.found;
        if (!receipt || receipt.order_id !== row.order_id)
          throw new Error("order_identity_mismatch");
        syncedIds.push(row.client_order_id);
				// A smaller cumulative verified cost contradicts the accepted trade set,
				// even when the next receipt reports more shares. Keep it in recovery.
				reconcileStage = "validate_cumulative_cost";
				const priorCost = Number(row.attributes?.filled_size_usdc);
				if (
					(row.attributes?.realized_fill_source === "clob_associated_trades" ||
            row.attributes?.realized_fill_source === "paper_order_receipt" ||
            (row.mode === "paper" && row.attributes?.realized_fill_source === undefined &&
              typeof row.attributes?.submitted_at === "string" && row.attributes.submitted_at.trim() !== "")) &&
					Number.isFinite(priorCost) &&
					priorCost > 0 &&
					typeof receipt.filled_size_usdc === "number" &&
					Number.isFinite(receipt.filled_size_usdc) &&
					receipt.filled_size_usdc < priorCost
				) {
					throw new Error("verified_cumulative_cost_regression");
				}
      reconcileStage = "prepare_status_update";
      const newStatus = mapReceiptStatus(receipt.status);
				const finalObservation = finalCancellationObservation(
					row,
					receipt,
					clock().toISOString(),
				);
      const filledChanged =
        receipt.filled_size_usdc !== undefined &&
        receipt.filled_size_usdc !== ledgerExecutedUsdc(row);
      const realizedFillSource = receiptFillSource(row, receipt);
      const sourceChanged = realizedFillSource !== undefined &&
        row.attributes?.realized_fill_source !== realizedFillSource;
      // Selected paper rows always reach the locked decoder: semantic equality
      // does not prove that the saved envelope/clock is valid. The writer keeps
      // an identical valid proof and its original observation clock unchanged.
				if (
					row.mode !== "paper" &&
					newStatus === row.status &&
					!filledChanged &&
					!sourceChanged &&
					!finalObservation
				)
        continue;
      reconcileStage = "persist_status";
      const accepted = await deps.ledger.updateStatus({
        client_order_id: row.client_order_id,
					order_id: row.order_id,
        status: newStatus,
        ...(row.mode === "paper" ? { paper_receipt: receipt } : {}),
					...(receipt.filled_size_usdc !== undefined
						? { filled_size_usdc: receipt.filled_size_usdc }
						: {}),
        ...(receipt.fill_price !== undefined
          ? { fill_price: receipt.fill_price }
          : {}),
        ...(receipt.total_shares !== undefined
          ? { total_shares: receipt.total_shares }
          : {}),
        ...(receipt.fees_usdc !== undefined
          ? { fees_usdc: receipt.fees_usdc }
          : {}),
					...(realizedFillSource
          ? { realized_fill_source: realizedFillSource }
						: {}),
					...(finalObservation
						? { final_order_observation: finalObservation }
          : {}),
      });
      reconcileStage = "notify_order_changed";
      let acceptedStatus = newStatus;
      if (accepted) acceptedStatus = accepted.status;
      deps.onOrderChanged?.(row, { status: acceptedStatus,
        ...(accepted ? { acceptedObservation: accepted } : {}) });
      if (accepted && !accepted.accepted) {
        log.warn(
          {
            event: EVENT_NAMES.POLY_MIRROR_RECONCILE_TICK_ERROR,
            errorCode: "order_observation_rejected",
          },
          "reconciler: authenticated order observation rejected",
        );
        continue;
      }
      reconcileStage = "record_update_metric";
      deps.metrics.incr(ORDER_RECONCILER_METRICS.updatesTotal, {
        from: row.status,
        to: acceptedStatus,
      });
      reconcileStage = "log_status_updated";
      log.info(
        {
          event: EVENT_NAMES.POLY_RECONCILER_STATUS_UPDATED,
          client_order_id: row.client_order_id,
          order_id: row.order_id,
          from: row.status,
          to: acceptedStatus,
						final_execution_proven: finalObservation !== undefined,
          realized_fill_fields_observed:
            typeof receipt.fill_price === "number" &&
            typeof receipt.total_shares === "number",
        },
					"reconciler: authenticated order observation persisted",
      );
			} catch (err: unknown) {
      const { err_class, err_code, cause_class, cause_code } = safeErrorDimensions(err);
      deps.metrics.incr(ORDER_RECONCILER_METRICS.errorsTotal, {});
      log.error(
        {
          event: EVENT_NAMES.POLY_MIRROR_RECONCILE_TICK_ERROR,
          errorCode:
            err instanceof Error && err.message === "verified_cumulative_cost_regression"
              ? "verified_cumulative_cost_regression"
              : "reconcile_row_error",
          client_order_id: row.client_order_id,
          order_id: row.order_id,
          billing_account_id: row.billing_account_id,
          mode: row.mode === "live" || row.mode === "paper" ? row.mode : "unknown",
          reconcile_stage: reconcileStage,
          err_class,
          err_code,
          cause_class,
          cause_code,
        },
          "reconciler: row processing failed",
      );
    }
		}
	} finally {
		// Fair scheduling is independent of execution state and venue freshness.
		await deps.ledger.markReconcileAttempted(attemptedIds);
	}

	if (unresolvedIdentityCount > 0) {
		log.warn(
			{
				event: EVENT_NAMES.POLY_MIRROR_RECONCILE_TICK_ERROR,
				errorCode: "unidentified_execution_reservations",
				unresolved_count: unresolvedIdentityCount,
			},
			"reconciler: exact order identity unavailable; reservations retained",
		);
  }

  // Bulk-stamp synced_at for all rows that got a typed CLOB response this tick.
  // One UPDATE vs N — correct and efficient.
  await deps.ledger.markSynced(syncedIds);

  deps.metrics.incr(ORDER_RECONCILER_METRICS.ticksTotal, {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Job shim — singleton claim + setInterval wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start the 60s reconciler poll. Emits
 * `poly.mirror.reconcile.singleton_claim` at boot. Returns an
 * `OrderReconcilerHandle` with `stop` + `getLastTickAt`.
 *
 * @public
 */
export function startOrderReconciler(
	deps: OrderReconcilerDeps,
): OrderReconcilerHandle {
  const log = deps.logger.child({
    component: "order-reconciler-job",
  });

  log.info(
    {
      event: EVENT_NAMES.POLY_MIRROR_RECONCILE_SINGLETON_CLAIM,
      poll_ms: RECONCILE_POLL_MS,
    },
		"order reconciler starting (SINGLE_WRITER — alert on duplicate pods running this; dispatches getOrder per tenant via billing_account_id)",
  );

  // In-memory last-tick timestamp. Updated at the END of each successful tick
  // (after markSynced completes). Null before first tick completes.
  // SYNC_HEALTH_IS_PUBLIC invariant (task.0328 CP4).
  let lastTickAt: Date | null = null;

  async function tick(): Promise<void> {
    try {
      await runReconcileOnce(deps);
      // Stamp AFTER the full tick (including markSynced) succeeds.
      lastTickAt = new Date();
    } catch (err: unknown) {
      // Belt-and-suspenders: `runReconcileOnce` already catches per-row errors.
      // Anything escaping here is a structural bug (e.g. ledger query threw).
      deps.metrics.incr(ORDER_RECONCILER_METRICS.errorsTotal, {});
      log.error(
        {
          event: EVENT_NAMES.POLY_MIRROR_RECONCILE_TICK_ERROR,
          errorCode: "tick_escaped_handler",
          err: err instanceof Error ? err.message : String(err),
        },
				"order reconciler: tick threw (continuing)",
      );
    }
  }

  // First tick fires immediately.
  void tick();

  const intervalHandle = setInterval(() => {
    void tick();
  }, RECONCILE_POLL_MS);

  return {
    stop() {
      clearInterval(intervalHandle);
      log.info(
        { event: EVENT_NAMES.POLY_MIRROR_RECONCILE_STOPPED },
				"order reconciler stopped",
      );
    },
    getLastTickAt() {
      return lastTickAt;
    },
  };
}

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
 *   - GRACE_WINDOW_IS_CONFIG — not_found rows older than `notFoundGraceMs` are
 *     promoted to `canceled`; value sourced from `POLY_CLOB_NOT_FOUND_GRACE_MS`
 *     env var (default 900 000 ms). (task.0328 CP2)
 *   - UNPLACED_ROWS_TERMINALIZE — a row with no `order_id` past
 *     `UNPLACED_GRACE_MS` (24h, deliberately NOT the not_found grace) is
 *     promoted to `error` with reason `never_placed`. Without this such rows
 *     stay `pending` forever and permanently block wallet reset, which treats
 *     pending|open as unsettled. Residual risk, accepted and logged at warn:
 *     if placement DID reach the venue and the process died before
 *     `markOrderId`, the real order is no longer represented by this row. 24h
 *     makes that window implausible; dedup is unaffected because
 *     `snapshotState.cidRows` does not filter on status.
 *   - UPGRADE_IS_METERED — each not_found-to-canceled promotion increments
 *     `poly_reconciler_not_found_upgrades_total`. (task.0328 CP2)
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
  GetOrderResult,
  LoggerPort,
  MetricsPort,
  OrderStatus,
} from "@cogni/poly-market-provider";

import {
  type LedgerRow,
  type LedgerStatus,
  ledgerExecutedUsdc,
  type OrderLedger,
} from "@/features/trading";
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
/**
 * Grace before a row that never received an `order_id` is terminalized.
 *
 * Deliberately NOT `notFoundGraceMs`. That window answers "the CLOB is slow to
 * index an order we know exists" and 15 minutes is generous for it. This branch
 * asserts the opposite — that no order exists — and it can be wrong: per
 * INSERT_BEFORE_PLACE (`mirror-pipeline.ts`), a crash after the venue accepts
 * but before `markOrderId` leaves a real resting order with no id in the
 * ledger. 24h makes that window implausible while still clearing rows that
 * have been stuck for months.
 */
const UNPLACED_GRACE_MS = 24 * 60 * 60 * 1000;
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
    order_id: string
  ) => Promise<GetOrderResult>;
  logger: LoggerPort;
  metrics: MetricsPort;
  /**
   * Grace window (ms) before a not_found row is promoted to canceled.
   * GRACE_WINDOW_IS_CONFIG invariant (task.0328 CP2): read from
   * `POLY_CLOB_NOT_FOUND_GRACE_MS` via server-env; default 900 000 (15 min).
   */
  notFoundGraceMs: number;
  /** Wake an account-local strategy actor after a durable ledger transition. */
  onOrderChanged?: (
    row: LedgerRow,
    change: { status: LedgerStatus; reason?: string }
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
  deps: OrderReconcilerDeps
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

  for (const row of rows) {
    if (!row.order_id) {
      // No CLOB order id. Within grace this is a placement still in flight —
      // markOrderId will stamp it. Past UNPLACED_GRACE_MS nothing ever will:
      // `listOpenOrPending` keeps returning the row and this branch used to
      // skip it unconditionally, so it stayed `pending` for months and
      // permanently blocked wallet reset (which counts pending|open as
      // unsettled). Reason `never_placed` is distinct from the not_found
      // branch's `clob_not_found` so forensics can tell "never reached the
      // venue" apart from "reached it, then the venue pruned it".
      //
      // Side effect, intended: leaving pending|open also releases this row's
      // slot in the partial unique index `one_open_per_market`, which the
      // stuck row had been holding against new mirror orders for that market.
      const unplacedAgeMs = clock().getTime() - row.created_at.getTime();
      if (unplacedAgeMs < UNPLACED_GRACE_MS) continue;

      // `error`, not `canceled`. We never saw a venue response for this row,
      // so claiming it was canceled asserts state we cannot verify. `error`
      // says what is actually known: the placement never recorded an id.
      // Both are outside UNSETTLED_ORDER_STATUSES, so either unblocks wallet
      // reset — but only one of them is honest.
      await deps.ledger.updateStatus({
        client_order_id: row.client_order_id,
        status: "error",
        reason: "never_placed",
      });
      deps.onOrderChanged?.(row, {
        status: "error",
        reason: "never_placed",
      });
      // NOT pushed to syncedIds: `synced_at` records a typed CLOB response,
      // and this row never produced one. The row leaves `listOpenOrPending`
      // on the next tick anyway, so its staleness stops growing regardless.
      deps.metrics.incr(ORDER_RECONCILER_METRICS.unplacedUpgradesTotal, {});
      log.warn(
        {
          event: EVENT_NAMES.POLY_RECONCILER_UNPLACED_UPGRADE,
          client_order_id: row.client_order_id,
          billing_account_id: row.billing_account_id,
          ageMs: unplacedAgeMs,
        },
        "reconciler: terminalizing row that never recorded a CLOB order id — if placement did reach the venue, this row stops representing it"
      );
      continue;
    }

    try {
      const result = await deps.getOrderForTenant(
        row.billing_account_id,
        row.order_id
      );
      // getOrder returned a typed response — mark as synced regardless of branch.
      syncedIds.push(row.client_order_id);

      if (!("found" in result)) {
        const ageMs = clock().getTime() - row.created_at.getTime();
        if (ageMs < deps.notFoundGraceMs) {
          // Still within grace — assume CLOB is just slow to index.
          log.debug(
            {
              event: EVENT_NAMES.POLY_RECONCILER_NOT_FOUND,
              client_order_id: row.client_order_id,
              ageMs,
            },
            "CLOB getOrder returned not_found (within grace window)"
          );
          continue;
        }
        // Beyond grace — CLOB has pruned or the order was canceled and we
        // missed the transition. Promote to canceled with a distinct reason
        // so forensics can tell this apart from a normal user/market cancel.
        await deps.ledger.updateStatus({
          client_order_id: row.client_order_id,
          status: "canceled",
          reason: "clob_not_found",
        });
        deps.onOrderChanged?.(row, {
          status: "canceled",
          reason: "clob_not_found",
        });
        deps.metrics.incr(ORDER_RECONCILER_METRICS.notFoundUpgradesTotal, {});
        log.info(
          {
            event: EVENT_NAMES.POLY_RECONCILER_NOT_FOUND_UPGRADE,
            client_order_id: row.client_order_id,
            order_id: row.order_id,
            ageMs,
          },
          "reconciler: promoting stuck row to canceled (CLOB not_found > grace)"
        );
        continue;
      }
      const receipt = result.found;

      const newStatus = mapReceiptStatus(receipt.status);
      const filledChanged =
        receipt.filled_size_usdc !== undefined &&
        receipt.filled_size_usdc !== ledgerExecutedUsdc(row);
      const sourceChanged =
        receipt.attributes?.realizedFillSource === "clob_associated_trades" &&
        row.attributes?.realized_fill_source !== "clob_associated_trades";
      if (newStatus === row.status && !filledChanged && !sourceChanged) {
        // Nothing changed — avoid a gratuitous UPDATE + updated_at churn.
        continue;
      }

      await deps.ledger.updateStatus({
        client_order_id: row.client_order_id,
        status: newStatus,
        filled_size_usdc: receipt.filled_size_usdc ?? undefined,
        ...(receipt.fill_price !== undefined
          ? { fill_price: receipt.fill_price }
          : {}),
        ...(receipt.total_shares !== undefined
          ? { total_shares: receipt.total_shares }
          : {}),
        ...(receipt.fees_usdc !== undefined
          ? { fees_usdc: receipt.fees_usdc }
          : {}),
        ...(receipt.attributes?.realizedFillSource === "clob_associated_trades"
          ? { realized_fill_source: "clob_associated_trades" as const }
          : {}),
      });
      deps.onOrderChanged?.(row, { status: newStatus });

      deps.metrics.incr(ORDER_RECONCILER_METRICS.updatesTotal, {
        from: row.status,
        to: newStatus,
      });

      log.info(
        {
          event: EVENT_NAMES.POLY_RECONCILER_STATUS_UPDATED,
          client_order_id: row.client_order_id,
          order_id: row.order_id,
          from: row.status,
          to: newStatus,
          realized_fill_fields_observed:
            typeof receipt.fill_price === "number" &&
            typeof receipt.total_shares === "number",
        },
        "reconciler: status updated"
      );
    } catch (err: unknown) {
      // getOrder threw — do NOT add to syncedIds; row staleness grows.
      deps.metrics.incr(ORDER_RECONCILER_METRICS.errorsTotal, {});
      log.error(
        {
          event: EVENT_NAMES.POLY_MIRROR_RECONCILE_TICK_ERROR,
          errorCode: "reconcile_row_error",
          client_order_id: row.client_order_id,
          order_id: row.order_id,
          err: err instanceof Error ? err.message : String(err),
        },
        "reconciler: row error (continuing)"
      );
    }
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
  deps: OrderReconcilerDeps
): OrderReconcilerHandle {
  const log = deps.logger.child({
    component: "order-reconciler-job",
  });

  log.info(
    {
      event: EVENT_NAMES.POLY_MIRROR_RECONCILE_SINGLETON_CLAIM,
      poll_ms: RECONCILE_POLL_MS,
    },
    "order reconciler starting (SINGLE_WRITER — alert on duplicate pods running this; dispatches getOrder per tenant via billing_account_id)"
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
        "order reconciler: tick threw (continuing)"
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
        "order reconciler stopped"
      );
    },
    getLastTickAt() {
      return lastTickAt;
    },
  };
}

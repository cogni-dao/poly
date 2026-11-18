// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/poly-mirror-resting-sweep`
 * Purpose: Per-process TTL sweeper. Cancels resting mirror orders older than
 *   `MIRROR_RESTING_TTL_MINUTES` (default 2). Bounds dust accumulation AND
 *   stale-fill risk when the target never sends a SELL signal. The prior 20
 *   minute default was tuned for political-style markets where prices move
 *   slowly; for live sports markets a single goal can move price 10pp+ in
 *   seconds, so a 20-min stale window leaves us exposed to filling at the
 *   target's entry price long after that price has become unattractive.
 *   Worst-case stale window with 2-min TTL + 60s sweep interval ≈ 3 min.
 * Scope: setInterval cadence + per-tenant cancel dispatch.
 * Invariants:
 *   - Single global `findStaleOpen` query → app-side groupBy on durable
 *     `(billing_account_id, mode)`. No N+1 and no venue re-resolution.
 *   - Cancel routes through the per-tenant executor (404-idempotent).
 *   - Pending rows (no `order_id` yet) are skipped — race with in-flight
 *     placement is acceptable for v0.
 *   - SINGLE_SWEEP_PER_PROCESS (bug.5057): at most one interval is live per
 *     process. A second `startRestingSweep` (leader re-acquire racing a stop,
 *     duplicate container/module instance) stops the previous sweep first, and
 *     a stop fn only stops its own sweep. Ticks never overlap (a slow cancel
 *     batch cannot be re-entered by the next interval).
 * Side-effects: setInterval, HTTPS to Polymarket CLOB (cancel), Postgres UPDATE.
 * Links: work/items/task.5001
 * @public
 */

import { EVENT_NAMES } from "@cogni/node-shared/observability/events";
import type {
  GetOrderResult,
  LoggerPort,
  MetricsPort,
  OrderReceipt,
} from "@cogni/poly-market-provider";

import type { OrderLedger } from "@/features/trading";

export const MIRROR_RESTING_SWEEP_METRICS = {
  /** Counter — one increment per row whose CLOB cancel + ledger mark succeeded. */
  sweptTotal: "poly_mirror_resting_swept_total",
} as const;

export interface RestingSweepDeps {
  ledger: OrderLedger;
  cancelOrderFor: (
    billing_account_id: string,
    mode: "live" | "paper"
  ) => Promise<(order_id: string) => Promise<void>>;
  /**
   * bug.5060 — per-tenant authenticated order read (same executor read the
   * reconciler uses). The sweep reads fill state BEFORE canceling so an order
   * that already matched is recorded as filled, never marked canceled.
   * Optional for back-compat; when absent or when the read fails the sweep
   * keeps its prior cancel-and-mark behavior (the reconciler still recovers
   * canceled rows via authenticated reads).
   */
  getOrderFor?: (
    billing_account_id: string,
    mode: "live" | "paper"
  ) => Promise<(order_id: string) => Promise<GetOrderResult>>;
  logger: LoggerPort;
  metrics: MetricsPort;
  /** Sweep cadence (ms). Default 60_000 (1 min). */
  intervalMs?: number;
  /** Max age (minutes) for an open mirror order. Default 2. */
  ttlMinutes?: number;
}

export type RestingSweepStopFn = () => void;

const DEFAULT_INTERVAL_MS = 60_000;

function hasExecution(receipt: OrderReceipt): boolean {
  return (
    receipt.status === "filled" ||
    receipt.status === "partial" ||
    (typeof receipt.filled_size_usdc === "number" &&
      receipt.filled_size_usdc > 0)
  );
}
const DEFAULT_TTL_MINUTES = 2;

/**
 * Process-wide registry of the live sweep. Keyed on `globalThis` (not a module
 * variable) so duplicate bundled copies of this module still share one slot.
 */
const ACTIVE_SWEEP_KEY = Symbol.for("cogni.poly.mirror-resting-sweep.active");
type ActiveSweep = { stop: () => void };
function activeSweepSlot(): { current: ActiveSweep | null } {
  const g = globalThis as unknown as Record<
    symbol,
    { current: ActiveSweep | null } | undefined
  >;
  let slot = g[ACTIVE_SWEEP_KEY];
  if (!slot) {
    slot = { current: null };
    g[ACTIVE_SWEEP_KEY] = slot;
  }
  return slot;
}

/**
 * Start the TTL sweep. Returns a stop fn.
 *
 * @public
 */
export function startRestingSweep(deps: RestingSweepDeps): RestingSweepStopFn {
  const slot = activeSweepSlot();
  if (slot.current) {
    const previous = slot.current;
    slot.current = null;
    deps.logger.warn(
      { job: "mirror-resting-sweep" },
      "mirror resting-sweep already running in this process — replacing it (bug.5057)"
    );
    previous.stop();
  }
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const ttlMinutes = deps.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const log = deps.logger.child({
    component: "mirror-resting-sweep",
    interval_ms: intervalMs,
    ttl_minutes: ttlMinutes,
  });

  log.info(
    {
      event: EVENT_NAMES.POLY_MIRROR_POLL_SINGLETON_CLAIM,
      job: "mirror-resting-sweep",
    },
    "mirror resting-sweep starting"
  );

  let stopped = false;
  let ticking = false;

  async function tick(): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      await runTick();
    } finally {
      ticking = false;
    }
  }

  async function runTick(): Promise<void> {
    let rows: Awaited<ReturnType<typeof deps.ledger.findStaleOpen>>;
    try {
      rows = await deps.ledger.findStaleOpen({ max_age_minutes: ttlMinutes });
    } catch (err: unknown) {
      log.error(
        {
          event: EVENT_NAMES.POLY_MIRROR_DECISION,
          phase: "sweep_tick_error",
          err: err instanceof Error ? err.message : String(err),
        },
        "mirror resting-sweep: findStaleOpen failed; skipping tick"
      );
      return;
    }
    if (rows.length === 0) return;

    const byTenantVenue = new Map<
      string,
      {
        billingAccountId: string;
        mode: "live" | "paper";
        rows: typeof rows;
      }
    >();
    for (const r of rows) {
      const key = `${r.billing_account_id}\u0000${r.mode}`;
      const group = byTenantVenue.get(key) ?? {
        billingAccountId: r.billing_account_id,
        mode: r.mode,
        rows: [],
      };
      group.rows.push(r);
      byTenantVenue.set(key, group);
    }

    for (const {
      billingAccountId,
      mode,
      rows: tenantRows,
    } of byTenantVenue.values()) {
      let cancel: (order_id: string) => Promise<void>;
      try {
        cancel = await deps.cancelOrderFor(billingAccountId, mode);
      } catch (err: unknown) {
        log.error(
          {
            event: EVENT_NAMES.POLY_MIRROR_DECISION,
            phase: "executor_resolve_failed",
            billing_account_id: billingAccountId,
            execution_mode: mode,
            err: err instanceof Error ? err.message : String(err),
          },
          "mirror resting-sweep: failed to resolve tenant executor"
        );
        continue;
      }

      let readOrder: ((order_id: string) => Promise<GetOrderResult>) | undefined;
      if (deps.getOrderFor) {
        try {
          readOrder = await deps.getOrderFor(billingAccountId, mode);
        } catch (err: unknown) {
          log.warn(
            {
              event: EVENT_NAMES.POLY_MIRROR_DECISION,
              phase: "sweep_read_unavailable",
              billing_account_id: billingAccountId,
              err: err instanceof Error ? err.message : String(err),
            },
            "mirror resting-sweep: order read unavailable; canceling without fill check"
          );
        }
      }

      for (const row of tenantRows) {
        if (row.order_id === null) continue;
        try {
          // bug.5060 — read fill state first; record executions, never cancel
          // (or mark canceled) a fully matched order.
          let executed: OrderReceipt | undefined;
          if (readOrder) {
            try {
              const result = await readOrder(row.order_id);
              if (
                "found" in result &&
                result.found &&
                result.found.order_id === row.order_id &&
                hasExecution(result.found)
              ) {
                executed = result.found;
              }
            } catch (err: unknown) {
              log.warn(
                {
                  event: EVENT_NAMES.POLY_MIRROR_DECISION,
                  phase: "sweep_read_failed",
                  client_order_id: row.client_order_id,
                  order_id: row.order_id,
                  err: err instanceof Error ? err.message : String(err),
                },
                "mirror resting-sweep: order read failed; canceling without fill check"
              );
            }
          }
          if (executed) {
            await deps.ledger.updateStatus({
              client_order_id: row.client_order_id,
              order_id: row.order_id,
              status: executed.status === "filled" ? "filled" : "partial",
              filled_size_usdc: executed.filled_size_usdc,
              ...(executed.fill_price !== undefined
                ? { fill_price: executed.fill_price }
                : {}),
              ...(executed.total_shares !== undefined
                ? { total_shares: executed.total_shares }
                : {}),
              ...(executed.fees_usdc !== undefined
                ? { fees_usdc: executed.fees_usdc }
                : {}),
              ...(executed.attributes?.realizedFillSource ===
              "clob_associated_trades"
                ? { realized_fill_source: "clob_associated_trades" as const }
                : {}),
            });
            log.info(
              {
                event: EVENT_NAMES.POLY_MIRROR_DECISION,
                phase: "sweep_recorded_fill",
                client_order_id: row.client_order_id,
                order_id: row.order_id,
                market_id: row.market_id,
                venue_status: executed.status,
                filled_size_usdc: executed.filled_size_usdc,
              },
              "mirror resting-sweep: order has fills; recorded instead of canceling"
            );
            if (executed.status === "filled") continue;
          }
          await cancel(row.order_id);
          // Partially filled: fills were recorded above (attributes/shares kept);
          // only the unfilled remainder is canceled.
          await deps.ledger.markCanceled({
            client_order_id: row.client_order_id,
            reason: "ttl_expired",
          });
          deps.metrics.incr(MIRROR_RESTING_SWEEP_METRICS.sweptTotal, {
            reason: "ttl_expired",
          });
          log.info(
            {
              event: EVENT_NAMES.POLY_MIRROR_DECISION,
              phase: "swept",
              client_order_id: row.client_order_id,
              order_id: row.order_id,
              market_id: row.market_id,
            },
            "mirror resting-sweep: canceled stale resting order"
          );
        } catch (err: unknown) {
          log.error(
            {
              event: EVENT_NAMES.POLY_MIRROR_DECISION,
              phase: "sweep_cancel_failed",
              client_order_id: row.client_order_id,
              order_id: row.order_id,
              err: err instanceof Error ? err.message : String(err),
            },
            "mirror resting-sweep: cancel failed; row stays open for next tick"
          );
        }
      }
    }
  }

  void tick();
  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  const stop = (): void => {
    stopped = true;
    clearInterval(handle);
    if (slot.current === active) slot.current = null;
  };
  const active: ActiveSweep = { stop };
  slot.current = active;
  return stop;
}

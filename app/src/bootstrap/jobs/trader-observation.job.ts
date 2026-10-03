// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/trader-observation.job`
 * Purpose: Process-local scheduler for live-forward observed trader wallet collection (fills + current positions + optional user-pnl ingest).
 * Scope: Wiring + cadence only. Caller injects DB/clients/logger/metrics; the feature service owns the tick body.
 * Invariants:
 *   - LIVE_FORWARD_COLLECTION: every tick observes configured `active_for_research` wallets from current watermarks.
 *   - TICK_IS_SELF_HEALING: escaped errors are logged and the interval continues.
 *   - TICK_TIMEOUT_IS_REAL_CANCELLATION (task.5015): the tick timeout aborts an AbortSignal threaded through the tick into per-wallet work and Polymarket fetches. The aborted tick settles cooperatively (logged as `tick_timeout` with wallets completed/remaining); only if it still hasn't settled after a short grace window is the promise abandoned — and even then its writers are signal-stopped, so no orphan writes past the next tick start.
 *   - USER_PNL_OPTIONAL: `userPnlClient` is optional; when omitted (e.g. in component tests), the tick skips the user-pnl read model writer and prune entirely.
 *   - RETENTION_PRUNE_CADENCE (prod EXPLAIN 2026-10-01): the two retention prunes run at most once per RETENTION_PRUNE_INTERVAL_MS (via `runRetentionPrune`), never every poll, and never on the boot tick — prod EXPLAIN showed the snapshot prune burning 30-72s of disk I/O per tick to delete zero rows on a bloated heap.
 * Side-effects: starts a timer, performs IO through injected deps.
 * Links: docs/spec/poly-copy-trade-execution.md, work/items/task.5005, work/items/task.5012, work/items/task.5015
 * @internal
 */

import type { LoggerPort, MetricsPort } from "@cogni/poly-market-provider";
import type {
  PolymarketDataApiClient,
  PolymarketUserPnlClient,
} from "@cogni/poly-market-provider/adapters/polymarket";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createPolygonPositionBalanceBatchReader } from "@/features/wallet-analysis/server/position-balance-authority";
import {
  runTraderObservationTick,
  type PositionBalanceBatchReader,
  type TenantTradingAddressReader,
  type TraderObservationStage,
} from "@/features/wallet-analysis/server/trader-observation-service";
import { serverEnv } from "@/shared/env/server-env";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

const OBSERVATION_POLL_MS = 30_000;
// Cancel the in-flight tick after this many ms: abort the tick's AbortSignal
// (task.5015) so per-wallet work and in-flight Polymarket fetches stop, then
// await the tick's cooperative settle before releasing the `running` lock.
const TICK_TIMEOUT_MS = 120_000;
// After aborting, wait at most this long for the tick promise to settle.
// Cooperative cancellation stops between pages/wallets and aborts in-flight
// fetches, so settle is normally near-instant; this bounds a pathological
// stall (e.g. a wedged DB write) so `running` still releases well before the
// next 30s tick.
const TICK_ABORT_SETTLE_GRACE_MS = 5_000;
// RETENTION_PRUNE_INTERVAL_MS (prod EXPLAIN 2026-10-01) — the two retention prunes run at most
// this often, NOT every OBSERVATION_POLL_MS tick. A 35-day retention window is
// indifferent to a 30s vs 30-min cadence, and prod EXPLAIN (2026-10-01) showed
// the snapshot prune spending 30-72s of disk I/O per tick to delete ZERO rows
// on a bloated heap. Gating the cadence removes ~60x of that wasted load. The
// first prune fires one interval AFTER boot (not on boot) so a crash-looping
// pod never piles prune load onto an already-stressed DB at restart.
const RETENTION_PRUNE_INTERVAL_MS = 30 * 60_000;

export type TraderObservationJobStopFn = () => void;

export interface TraderObservationJobDeps {
  db: Db;
  client: PolymarketDataApiClient;
  userPnlClient?: PolymarketUserPnlClient;
  /**
   * Bound to `PolyTraderWalletPort.listActiveTradingAddresses` by the
   * container — see OBSERVE_WHAT_THE_EXECUTOR_SIGNS_FROM in the service.
   */
  listActiveTradingAddresses: TenantTradingAddressReader;
  /** Polygon CTF batch authority for omitted current positions. */
  readPositionBalances?: PositionBalanceBatchReader;
  /** Off-render Polygon reads persisted for DB-only dashboard GETs. */
  refreshBalanceFacts?: () => Promise<void>;
  logger: LoggerPort;
  metrics: MetricsPort;
  pollMs?: number;
}

export function startTraderObservationJob(
  deps: TraderObservationJobDeps
): TraderObservationJobStopFn {
  const readPositionBalances =
    deps.readPositionBalances ??
    (() => {
      const rpcUrl = serverEnv().POLYGON_RPC_URL;
      return rpcUrl
        ? createPolygonPositionBalanceBatchReader({ rpcUrl })
        : undefined;
    })();
  const pollMs = deps.pollMs ?? OBSERVATION_POLL_MS;
  const log = deps.logger.child({ component: "trader-observation-job" });
  let running = false;
  let balanceRefreshRunning = false;
  // prod EXPLAIN 2026-10-01 — seed to "now" so the first prune fires one full interval after
  // boot, never on the boot tick itself (see RETENTION_PRUNE_INTERVAL_MS).
  let lastRetentionPruneAt = Date.now();

  log.info(
    {
      event: "poly.trader.observe",
      phase: "job_start",
      poll_ms: pollMs,
    },
    "trader observation job starting"
  );

  async function tick(): Promise<void> {
    if (running) {
      log.warn(
        { event: "poly.trader.observe", phase: "tick_skipped_running" },
        "trader observation tick skipped; previous tick still running"
      );
      return;
    }
    running = true;
    if (deps.refreshBalanceFacts && !balanceRefreshRunning) {
      balanceRefreshRunning = true;
      void deps
        .refreshBalanceFacts()
        .catch((err) => {
          log.error(
            {
              event: "poly.wallet.balance.observe",
              phase: "error",
              err: err instanceof Error ? err.message : String(err),
            },
            "wallet balance snapshot refresh failed"
          );
        })
        .finally(() => {
          balanceRefreshRunning = false;
        });
    }
    const tickStartedAt = Date.now();
    // prod EXPLAIN 2026-10-01 — run the retention prunes at most once per
    // RETENTION_PRUNE_INTERVAL_MS. Stamp the clock at the decision point (not
    // on completion) so a prune that is cancelled or is a no-op still backs
    // off a full interval instead of re-firing next tick.
    const runRetentionPrune =
      tickStartedAt - lastRetentionPruneAt >= RETENTION_PRUNE_INTERVAL_MS;
    if (runRetentionPrune) lastRetentionPruneAt = tickStartedAt;
    // bug.5297 — set when an abandoned tick keeps the guard so the `finally`
    // below must NOT clear it; the late-settle handler owns the release.
    let guardHeld = false;
    const controller = new AbortController();
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const TIMED_OUT = Symbol("tick-timed-out");
    // STAGE_SURVIVES_A_HUNG_TICK (bug.5273) — held OUTSIDE the race below. The
    // timeout log's `wallets*` fields all come from the tick's return value, so
    // a tick that never settles reported nothing but nulls and the stall was
    // undiagnosable (prod 51bd530: `settled_after_abort: false`, every field
    // null). A plain mutable variable is the only thing guaranteed readable
    // when the promise itself is abandoned.
    let lastStage: TraderObservationStage | "not_started" = "not_started";
    const tickPromise = runTraderObservationTick({
      ...deps,
      ...(readPositionBalances === undefined ? {} : { readPositionBalances }),
      runRetentionPrune,
      signal: controller.signal,
      onStage: (next) => {
        lastStage = next;
      },
    });
    try {
      const raced = await Promise.race([
        tickPromise,
        new Promise<typeof TIMED_OUT>((resolve) => {
          timeoutTimer = setTimeout(() => {
            controller.abort(
              new Error(`trader observation tick exceeded ${TICK_TIMEOUT_MS}ms`)
            );
            resolve(TIMED_OUT);
          }, TICK_TIMEOUT_MS);
          timeoutTimer.unref?.();
        }),
      ]);
      // `signal.aborted` (not just the race winner) decides: a cooperative
      // tick can settle in the same turn the abort fires, beating the
      // sentinel to the race — it still timed out.
      if (raced === TIMED_OUT || controller.signal.aborted) {
        // Signal is aborted; the tick settles cooperatively. Await it (bounded
        // by a short grace window) so we can report completed/remaining and so
        // `running` releases only after writers have stopped.
        const settled = await Promise.race([
          tickPromise.then(
            (result) => ({ settled: true as const, result }),
            () => ({ settled: true as const, result: undefined })
          ),
          new Promise<{ settled: false; result: undefined }>((resolve) => {
            graceTimer = setTimeout(() => {
              resolve({ settled: false, result: undefined });
            }, TICK_ABORT_SETTLE_GRACE_MS);
            graceTimer.unref?.();
          }),
        ]);
          if (!settled.settled) {
          // GUARD_HELD_UNTIL_WRITERS_SETTLE (bug.5297) — an abandoned tick's
          // DB writes DO NOT STOP. drizzle/postgres-js take no AbortSignal, so
          // aborting the signal ends our *waiting*, not the INSERT. Releasing
          // `running` here let the next poll stack MORE concurrent writes on
          // top of the still-running ones, with nothing bounding the pile-up.
          //
          // Measured on the prod VM 2026-09-28: 12x INSERT into
          // poly_trader_current_positions at 589s, 6x into
          // poly_trader_position_snapshots at 729s, autovacuum wedged 1240s,
          // 28 active poly connections, swap 2G/2G full, load 38-42, 80-85%
          // iowait. Ticks never overlapped logically — the guard worked — but
          // their WRITERS did, unboundedly.
          //
          // So we keep the guard HELD and release it only when the promise
          // truly settles. A skipped tick is free; an unbounded write pile-up
          // took down a shared box. `guardHeld` makes the finally below
          // conditional instead of unconditional.
          guardHeld = true;
          void tickPromise
            .catch(() => undefined)
            .finally(() => {
              running = false;
              log.warn(
                {
                  event: "poly.trader.observe",
                  phase: "tick_released_late",
                  tick_ms: Date.now() - tickStartedAt,
                },
                "trader observation tick finally settled; guard released — ticks were skipped until now by design"
              );
            });
        }
        log.error(
          {
            event: "poly.trader.observe",
            phase: "tick_timeout",
            timeout_ms: TICK_TIMEOUT_MS,
            tick_ms: Date.now() - tickStartedAt,
            settled_after_abort: settled.settled,
            // bug.5273 — the stage is authoritative even when `settled.result`
            // is undefined. `sync_tenant_wallets` / `select_wallets` here means
            // the tick hung in a pre-loop DB call, which takes no AbortSignal.
            stage: lastStage,
            wallets: settled.result?.wallets ?? null,
            wallets_completed: settled.result?.walletsProcessed ?? null,
            wallets_remaining: settled.result?.walletsAborted ?? null,
          },
          "trader observation tick timed out; aborted in-flight work"
        );
      }
    } catch (err: unknown) {
      log.error(
        {
          event: "poly.trader.observe",
          phase: "tick_error",
          err: err instanceof Error ? err.message : String(err),
          timeout_ms: TICK_TIMEOUT_MS,
          aborted: controller.signal.aborted,
        },
        "trader observation tick escaped"
      );
    } finally {
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      // bug.5297 — do NOT release while an abandoned tick's writers may still
      // be in flight; its late-settle handler releases instead.
      if (!guardHeld) running = false;
    }
  }

  void tick();
  const handle = setInterval(() => {
    void tick();
  }, pollMs);
  handle.unref?.();

  return function stop() {
    clearInterval(handle);
    log.info(
      { event: "poly.trader.observe", phase: "job_stop" },
      "trader observation job stopped"
    );
  };
}

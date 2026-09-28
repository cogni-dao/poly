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
import {
  runTraderObservationTick,
  type TraderObservationStage,
} from "@/features/wallet-analysis/server/trader-observation-service";

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

export type TraderObservationJobStopFn = () => void;

export interface TraderObservationJobDeps {
  db: Db;
  client: PolymarketDataApiClient;
  userPnlClient?: PolymarketUserPnlClient;
  logger: LoggerPort;
  metrics: MetricsPort;
  pollMs?: number;
}

export function startTraderObservationJob(
  deps: TraderObservationJobDeps
): TraderObservationJobStopFn {
  const pollMs = deps.pollMs ?? OBSERVATION_POLL_MS;
  const log = deps.logger.child({ component: "trader-observation-job" });
  let running = false;

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
    const tickStartedAt = Date.now();
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
          // Abandoned-but-aborted: swallow the eventual settle so an
          // unhandled rejection can't crash the process.
          tickPromise.catch(() => undefined);
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
      running = false;
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

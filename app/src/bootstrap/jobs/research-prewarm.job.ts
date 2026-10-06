// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/research-prewarm.job`
 * Purpose: Prewarm of the SWR-cached research aggregates
 *   (`research-read-cache.ts`) for the two primary research wallets: a
 *   ONE-SHOT boot pass over snapshot/benchmark/target-overlap, plus a small
 *   RECURRING tick (fix/comparison-per-wallet-cache) that keeps the two fixed
 *   comparison targets (RN1, swisstony) warm at the research board's default
 *   interval (1W). With the per-wallet comparison cache, any user's page load
 *   is then 2 warm targets + their own (small) wallet.
 * Scope: Wiring + sequencing only. Caller injects DB + logger; the cached
 *   wrappers own keys/freshness; the services own the SQL.
 * Invariants:
 *   - RECURRING_COMPARISON_PREWARM: the comparison targets are re-warmed every
 *     `COMPARISON_PREWARM_POLL_MS` (4min, deliberately < the cache's 5min
 *     freshMs so the per-wallet entries never age past the serve-stale horizon
 *     and the SWR background refresh fires promptly after freshness lapses —
 *     page loads never pay the RN1-class 5-8s cold aggregate). Exactly the two
 *     PREWARM_WALLETS at COMPARISON_DEFAULT_INTERVAL; per-user wallets and
 *     non-default intervals stay demand-driven.
 *   - BACKGROUND_BUDGET (fix/prewarm-budget-split): comparison warms run on
 *     the background budget lane (`POLY_RESEARCH_PREWARM_BUDGET_MS`, 45s) —
 *     NOT the 8s request budget. Prod 4ceff2e1 proved the single-budget loop
 *     self-defeating: cold target computes burned the request budget, degraded
 *     results are never cached, so the prewarm could never populate the cache
 *     it exists to fill.
 *   - ONE_SHOT_BOOT_REST: snapshot/benchmark/target-overlap are warmed once at
 *     boot only (rollup-backed and fast; SWR refreshes take over on traffic).
 *   - SERIALIZED_PLIMIT_1: boot entries AND tick entries share one pLimit(1),
 *     so the prewarm never stacks multiple aggregates on Postgres.
 *   - TICK_NO_OVERLAP: a tick that is still running when the next interval
 *     fires is skipped (running guard), same pattern as top-wallet-stats.
 *   - LEADER_ONLY_SEAM: started through the task.5016 jobs seam, so only the
 *     job-leader pod prewarms. The coalesce cache is per-replica; on a
 *     multi-replica deploy non-leader pods stay cold (hit-rate concern only,
 *     and prod is single-replica today).
 *   - BEST_EFFORT: a failed prewarm entry logs and moves on — page loads just
 *     pay the cold aggregate as before. Failures/degraded results are never
 *     cached (FAILED_FETCH_NOT_CACHED / DEGRADED_NOT_PINNED in the cache layer).
 * Side-effects: kicks DB aggregate reads through the research cache; starts an
 *   interval timer (unref'd); logs.
 * Links: src/features/wallet-analysis/server/research-read-cache.ts,
 *   src/bootstrap/jobs/job-leader-elector.ts, work/items/task.5016
 * @internal
 */

import type { LoggerPort } from "@cogni/poly-market-provider";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import pLimit from "p-limit";
import {
  getBenchmarkSliceCached,
  getComparisonWalletCached,
  getSnapshotSliceCached,
  getTargetOverlapSliceCached,
} from "@/features/wallet-analysis/server/research-read-cache";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

/** The two primary research wallets (mirrors PRIMARY_RESEARCH_WALLETS in the research view). */
export const PREWARM_WALLETS = [
  { label: "RN1", address: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" },
  { label: "swisstony", address: "0x204f72f35326db932158cba6adff0b9a1da95e14" },
] as const;

/** Research-board default interval (research view boots on "1W"). */
export const COMPARISON_DEFAULT_INTERVAL = "1W" as const;
/** Wallet-analysis slice default interval (use-wallet-analysis defaults to "ALL"). */
const BENCHMARK_DEFAULT_INTERVAL = "ALL" as const;

/**
 * Comparison re-warm cadence. MUST stay below `RESEARCH_READ_FRESH_MS` (5min)
 * so a prewarmed per-wallet entry is always either fresh or within one tick of
 * a background refresh — asserted by a unit test.
 */
export const COMPARISON_PREWARM_POLL_MS = 4 * 60 * 1000;

export type ResearchPrewarmStopFn = () => void;

export interface ResearchPrewarmDeps {
  db: Db;
  logger: LoggerPort;
  /** Test seam: overrides the comparison re-warm cadence. */
  comparisonPollMs?: number;
}

/**
 * Fire the boot prewarm in the background and start the recurring
 * comparison-target re-warm. The returned stop fn clears the interval and
 * prevents not-yet-started entries from running (in-flight SQL is not
 * cancelable); a task.5016 leadership loss stops both.
 */
export function startResearchPrewarm(
  deps: ResearchPrewarmDeps
): ResearchPrewarmStopFn {
  const log = deps.logger.child({ component: "research-prewarm-job" });
  const limit = pLimit(1);
  const pollMs = deps.comparisonPollMs ?? COMPARISON_PREWARM_POLL_MS;
  let stopped = false;
  let tickRunning = false;

  /** Run one named entry through the shared limiter; log outcome; never throw. */
  async function runEntry(
    name: string,
    run: () => Promise<unknown>
  ): Promise<boolean> {
    return limit(async () => {
      if (stopped) return false;
      const entryStartedAt = Date.now();
      try {
        await run();
        log.info(
          {
            event: "poly.research-prewarm.entry_ok",
            entry: name,
            duration_ms: Date.now() - entryStartedAt,
          },
          "research prewarm entry complete"
        );
        return true;
      } catch (err: unknown) {
        log.error(
          {
            event: "poly.research-prewarm.entry_failed",
            entry: name,
            duration_ms: Date.now() - entryStartedAt,
            err: err instanceof Error ? err.message : String(err),
          },
          "research prewarm entry failed — page loads pay the cold aggregate"
        );
        return false;
      }
    });
  }

  /**
   * Warm exactly the two fixed comparison targets at the board default
   * interval, on the BACKGROUND budget lane (fix/prewarm-budget-split):
   * prewarm computes must COMPLETE un-degraded to populate the per-wallet
   * cache — on the request-lane 8s budget a cold RN1-class aggregate burned
   * every tick and (DEGRADED_NOT_PINNED) nothing was ever cached.
   */
  async function warmComparisonTargets(): Promise<boolean[]> {
    return Promise.all(
      PREWARM_WALLETS.map((w) =>
        runEntry(`comparison-wallet:${w.label}`, () =>
          getComparisonWalletCached(
            deps.db,
            w.address,
            COMPARISON_DEFAULT_INTERVAL,
            { lane: "background" }
          )
        )
      )
    );
  }

  const bootEntries: readonly { name: string; run: () => Promise<unknown> }[] = [
    {
      name: "target-overlap",
      run: () => getTargetOverlapSliceCached(deps.db, COMPARISON_DEFAULT_INTERVAL),
    },
    ...PREWARM_WALLETS.flatMap((w) => [
      {
        name: `snapshot:${w.label}`,
        run: () => getSnapshotSliceCached(deps.db, w.address),
      },
      {
        // comparisonWalletAddress=null warms the no-connected-wallet variant;
        // per-user comparison variants stay cold (keyed per user input).
        name: `benchmark:${w.label}`,
        run: () =>
          getBenchmarkSliceCached(deps.db, w.address, BENCHMARK_DEFAULT_INTERVAL, {
            comparisonWalletAddress: null,
          }),
      },
    ]),
  ];

  log.info(
    {
      event: "poly.research-prewarm.start",
      boot_entry_count: bootEntries.length + PREWARM_WALLETS.length,
      comparison_poll_ms: pollMs,
    },
    "research prewarm starting (one-shot boot + recurring comparison re-warm)"
  );

  void (async () => {
    const startedAt = Date.now();
    const [comparisonOks, bootOks] = await Promise.all([
      // First tick runs at boot so the targets are warm before the interval's
      // first fire; the shared pLimit(1) serializes it with the boot entries.
      warmComparisonTargets(),
      Promise.all(bootEntries.map((entry) => runEntry(entry.name, entry.run))),
    ]);
    const outcomes = [...comparisonOks, ...bootOks];
    const ok = outcomes.filter(Boolean).length;
    log.info(
      {
        event: "poly.research-prewarm.complete",
        ok,
        failed: outcomes.length - ok,
        stopped,
        duration_ms: Date.now() - startedAt,
      },
      "research prewarm boot pass finished"
    );
  })();

  const handle = setInterval(() => {
    if (stopped) return;
    if (tickRunning) {
      log.warn(
        { event: "poly.research-prewarm.tick_skipped_running" },
        "comparison prewarm tick skipped; previous tick still running"
      );
      return;
    }
    tickRunning = true;
    const tickStartedAt = Date.now();
    void warmComparisonTargets()
      .then((oks) => {
        // fix/prewarm-budget-split — explicit per-tick completion event. The
        // tick previously logged only per-entry events (entry_ok/entry_failed,
        // shared with the boot pass), so prod Loki had NO tick-scoped signal to
        // prove the recurring loop was alive, let alone effective.
        const ok = oks.filter(Boolean).length;
        log.info(
          {
            event: "poly.research-prewarm.tick_complete",
            ok,
            failed: oks.length - ok,
            duration_ms: Date.now() - tickStartedAt,
          },
          "comparison prewarm tick finished"
        );
      })
      .finally(() => {
        tickRunning = false;
      });
  }, pollMs);
  handle.unref?.();

  return () => {
    stopped = true;
    clearInterval(handle);
    log.info(
      { event: "poly.research-prewarm.job_stop" },
      "research prewarm stopped"
    );
  };
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/research-prewarm.job`
 * Purpose: ONE-SHOT boot prewarm of the SWR-cached research aggregates
 *   (`research-read-cache.ts`) for the two primary research wallets, so first
 *   views after a deploy don't pay the 25-31s cold aggregate (prod-measured
 *   2026-09-28, build 08cedd2). Interim mitigation only — the real fix is
 *   tick-written rollup tables (separate design).
 * Scope: Wiring + sequencing only. Caller injects DB + logger; the cached
 *   wrappers own keys/freshness; the services own the SQL.
 * Invariants:
 *   - ONE_SHOT_NO_LOOP: fires exactly once at start; no recurring refresh in
 *     this job (SWR background refreshes take over on request traffic).
 *   - SERIALIZED_PLIMIT_1: the six computes run strictly one-at-a-time so the
 *     prewarm never stacks multiple full-history scans on Postgres at boot.
 *   - LEADER_ONLY_SEAM: started through the task.5016 jobs seam, so only the
 *     job-leader pod prewarms. The coalesce cache is per-replica; on a
 *     multi-replica deploy non-leader pods stay cold (hit-rate concern only,
 *     and prod is single-replica today).
 *   - BEST_EFFORT: a failed prewarm entry logs and moves on — page loads just
 *     pay the cold aggregate as before. Failures are never cached
 *     (FAILED_FETCH_NOT_CACHED / DEGRADED_NOT_PINNED in the cache layer).
 * Side-effects: kicks DB aggregate reads through the research cache; logs.
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
  getSnapshotSliceCached,
  getTargetOverlapSliceCached,
  getTraderComparisonCached,
} from "@/features/wallet-analysis/server/research-read-cache";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

/** The two primary research wallets (mirrors PRIMARY_RESEARCH_WALLETS in the research view). */
const PREWARM_WALLETS = [
  { label: "RN1", address: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" },
  { label: "swisstony", address: "0x204f72f35326db932158cba6adff0b9a1da95e14" },
] as const;

/** Research-board default interval (research view boots on "1W"). */
const COMPARISON_DEFAULT_INTERVAL = "1W" as const;
/** Wallet-analysis slice default interval (use-wallet-analysis defaults to "ALL"). */
const BENCHMARK_DEFAULT_INTERVAL = "ALL" as const;

export type ResearchPrewarmStopFn = () => void;

export interface ResearchPrewarmDeps {
  db: Db;
  logger: LoggerPort;
}

/**
 * Fire the one-shot prewarm in the background. The returned stop fn only
 * prevents not-yet-started entries from running (in-flight SQL is not
 * cancelable); it exists so a task.5016 leadership loss mid-boot stops the
 * remainder of the sequence.
 */
export function startResearchPrewarm(
  deps: ResearchPrewarmDeps
): ResearchPrewarmStopFn {
  const log = deps.logger.child({ component: "research-prewarm-job" });
  const limit = pLimit(1);
  let stopped = false;

  const entries: readonly { name: string; run: () => Promise<unknown> }[] = [
    {
      name: "trader-comparison",
      run: () =>
        getTraderComparisonCached(
          deps.db,
          PREWARM_WALLETS.map((w) => ({ address: w.address, label: w.label })),
          COMPARISON_DEFAULT_INTERVAL
        ),
    },
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
    { event: "poly.research-prewarm.start", entry_count: entries.length },
    "research prewarm starting (one-shot, serialized)"
  );

  void (async () => {
    const startedAt = Date.now();
    let ok = 0;
    let failed = 0;
    await Promise.all(
      entries.map((entry) =>
        limit(async () => {
          if (stopped) return;
          const entryStartedAt = Date.now();
          try {
            await entry.run();
            ok += 1;
            log.info(
              {
                event: "poly.research-prewarm.entry_ok",
                entry: entry.name,
                duration_ms: Date.now() - entryStartedAt,
              },
              "research prewarm entry complete"
            );
          } catch (err: unknown) {
            failed += 1;
            log.error(
              {
                event: "poly.research-prewarm.entry_failed",
                entry: entry.name,
                duration_ms: Date.now() - entryStartedAt,
                err: err instanceof Error ? err.message : String(err),
              },
              "research prewarm entry failed — page loads pay the cold aggregate"
            );
          }
        })
      )
    );
    log.info(
      {
        event: "poly.research-prewarm.complete",
        ok,
        failed,
        stopped,
        duration_ms: Date.now() - startedAt,
      },
      "research prewarm finished"
    );
  })();

  return () => {
    stopped = true;
  };
}

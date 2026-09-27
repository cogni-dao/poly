// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/top-wallet-stats.job`
 * Purpose: Process-local scheduler for the Polymarket leaderboard mirror that
 *          backs the Top Wallets dashboard/research card. Sibling of
 *          `price-history.job.ts` / `market-outcome.job.ts`.
 * Scope: Wiring + cadence only. Caller injects DB/client/logger/metrics; the
 *        feature service owns the tick body.
 * Invariants:
 *   - PAGE_LOAD_DB_ONLY (bug.5017): this job is the only Polymarket caller for
 *     top-wallet data. Page-load reads go through `readTopTradersFromDb`.
 *   - TICK_IS_SELF_HEALING: escaped errors are logged and the interval continues.
 *   - DEFAULT_15_MIN_CADENCE: the leaderboard moves slowly; 8 board fetches +
 *     one /trades call per unique wallet at `pLimit(4)` completes well inside
 *     the window.
 * Side-effects: starts a timer, performs IO through injected deps.
 * Links: src/features/wallet-analysis/server/top-wallet-stats-service.ts,
 *        work/items/bug.5017
 * @internal
 */

import type { LoggerPort, MetricsPort } from "@cogni/poly-market-provider";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  runTopWalletStatsTick,
  type TopWalletStatsDataApi,
} from "@/features/wallet-analysis/server/top-wallet-stats-service";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

const DEFAULT_POLL_MS = 15 * 60 * 1000;

export type TopWalletStatsJobStopFn = () => void;

export interface TopWalletStatsJobDeps {
  db: Db;
  dataApiClient: TopWalletStatsDataApi;
  logger: LoggerPort;
  metrics: MetricsPort;
  pollMs?: number;
}

export function startTopWalletStatsJob(
  deps: TopWalletStatsJobDeps
): TopWalletStatsJobStopFn {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const log = deps.logger.child({ component: "top-wallet-stats-job" });
  let running = false;

  log.info(
    {
      event: "poly.top-wallet-stats.job_start",
      poll_ms: pollMs,
    },
    "top-wallet-stats job starting"
  );

  async function tick(): Promise<void> {
    if (running) {
      log.warn(
        { event: "poly.top-wallet-stats.tick_skipped_running" },
        "top-wallet-stats tick skipped; previous tick still running"
      );
      return;
    }
    running = true;
    try {
      await runTopWalletStatsTick(deps);
    } catch (err: unknown) {
      log.error(
        {
          event: "poly.top-wallet-stats.tick_error",
          err: err instanceof Error ? err.message : String(err),
        },
        "top-wallet-stats tick escaped"
      );
    } finally {
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
      { event: "poly.top-wallet-stats.job_stop" },
      "top-wallet-stats job stopped"
    );
  };
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/fill-rollup-backfill.job`
 * Purpose: ONE-SHOT boot walker that drains historical `poly_trader_fills`
 *   into `poly_trader_fill_rollups_daily` (task.research-rollup-read-models).
 *   After the first complete run this is a cheap no-op per boot (one bounded
 *   probe per wallet); steady-state freshness is owned by the observation
 *   tick's per-wallet accumulate.
 * Scope: Wiring + sequencing only; `backfillFillRollups` owns the SQL.
 * Invariants:
 *   - ONE_SHOT_NO_LOOP: fires once at start; no recurring schedule.
 *   - SERIALIZED_PLIMIT_1: the walker folds one wallet-batch at a time so the
 *     backfill never stacks concurrent full-history scans on Postgres.
 *   - RESUMABLE: every batch advances the per-wallet watermark atomically; a
 *     stop/crash resumes exactly where it left off on next boot.
 *   - LEADER_ONLY_SEAM: started through the task.5016 jobs seam. Safe even if
 *     it were to race the tick (cursor row lock; tick yields via NOWAIT).
 *   - DB_ONLY: no Polymarket calls — the Data-API limiter is untouched.
 * Side-effects: DB reads/writes; logs.
 * Links: src/features/wallet-analysis/server/fill-rollup-service.ts,
 *   work/items/task.research-rollup-read-models.md
 * @internal
 */

import type { LoggerPort } from "@cogni/poly-market-provider";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { backfillFillRollups } from "@/features/wallet-analysis/server/fill-rollup-service";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

export type FillRollupBackfillStopFn = () => void;

export interface FillRollupBackfillDeps {
  db: Db;
  logger: LoggerPort;
}

/**
 * Fire the one-shot backfill in the background. The stop fn aborts between
 * batches (in-flight SQL statements are not cancelable); progress persists at
 * the watermark, so stopping loses nothing.
 */
export function startFillRollupBackfill(
  deps: FillRollupBackfillDeps
): FillRollupBackfillStopFn {
  const log = deps.logger.child({ component: "fill-rollup-backfill-job" });
  const controller = new AbortController();

  log.info(
    { event: "poly.fill_rollup.backfill_start" },
    "fill-rollup backfill starting (one-shot, serialized)"
  );

  void (async () => {
    const startedAt = Date.now();
    try {
      const result = await backfillFillRollups(deps.db, {
        logger: deps.logger,
        signal: controller.signal,
      });
      log.info(
        {
          event: "poly.fill_rollup.backfill_complete",
          wallets: result.wallets,
          wallets_completed: result.walletsCompleted,
          fills: result.fills,
          batches: result.batches,
          completed: result.completed,
          duration_ms: Date.now() - startedAt,
        },
        "fill-rollup backfill finished"
      );
    } catch (err: unknown) {
      log.error(
        {
          event: "poly.fill_rollup.backfill_failed",
          duration_ms: Date.now() - startedAt,
          err: err instanceof Error ? err.message : String(err),
        },
        "fill-rollup backfill failed — resumable at watermark on next boot; readers serve the live tail meanwhile"
      );
    }
  })();

  return () => {
    controller.abort(new Error("fill-rollup backfill stopped"));
  };
}

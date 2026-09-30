// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/fill-rollup-backfill.job`
 * Purpose: Boot walker that drains historical `poly_trader_fills` into
 *   `poly_trader_fill_rollups_daily` (task.research-rollup-read-models).
 *   After the first complete run this is a cheap no-op per boot (one bounded
 *   probe per wallet); steady-state freshness is owned by the observation
 *   tick's per-wallet accumulate.
 * Scope: Wiring + sequencing only; `backfillFillRollups` owns the SQL.
 * Invariants:
 *   - BOUNDED_RETRY_NO_SCHEDULE: a failed run (thrown OR `completed:false`)
 *     is retried with exponential backoff (1m→2m→4m→8m→16m, 5 retries max),
 *     then gives up until next boot. No recurring schedule — a
 *     `completed:true` run ends the loop for the life of the process. This
 *     closes the boot-window resilience gap where a one-shot run died on a
 *     transient failure (DB crash loop bug.5293; migration-behind-image
 *     bug.5314) and silently forfeited the backfill until the next deploy.
 *   - RECHECK_BEFORE_RETRY: `shouldRetry` (env gate + task.5016 leader
 *     status) is re-evaluated before every retry attempt — the elector may
 *     have demoted this pod during the backoff window.
 *   - SCHEMA_MISSING_IS_OPERATOR_FAULT: a `relation ... does not exist`
 *     failure is classified as schema-behind-image (operator bug.5314) and
 *     logged as `backfill_schema_missing`; it STILL retries on schedule
 *     because a crash-recovery migration may land mid-backoff.
 *   - SERIALIZED_PLIMIT_1: the walker folds one wallet-batch at a time so the
 *     backfill never stacks concurrent full-history scans on Postgres.
 *   - RESUMABLE: every batch advances the per-wallet watermark atomically; a
 *     stop/crash/failed attempt resumes exactly where it left off.
 *   - LEADER_ONLY_SEAM: started through the task.5016 jobs seam. Safe even if
 *     it were to race the tick (cursor row lock; tick yields via NOWAIT).
 *   - TIMERS_UNREF: backoff timers never hold the process open (vitest,
 *     `next build` workers).
 *   - DB_ONLY: no Polymarket calls — the Data-API limiter is untouched.
 * Side-effects: DB reads/writes; timers; logs.
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

/** Max retry attempts after the initial run fails (6 runs total). */
export const BACKFILL_MAX_RETRIES = 5;
/** First backoff delay; doubles per retry → 1m, 2m, 4m, 8m, 16m. */
export const BACKFILL_RETRY_BASE_DELAY_MS = 60_000;

/**
 * Postgres "relation ... does not exist" (SQLSTATE 42P01) — on this job it
 * means the pod's migration lagged the image (operator bug.5314), not an app
 * fault.
 */
const SCHEMA_MISSING_RE = /relation ".*" does not exist/i;

export type FillRollupBackfillStopFn = () => void;

export interface FillRollupBackfillDeps {
  db: Db;
  logger: LoggerPort;
  /**
   * Re-checked before EVERY retry attempt: must return true only while the
   * env gate is on AND this pod still holds task.5016 job leadership.
   * Absent → retries are never abandoned (tests / single-pod setups).
   */
  shouldRetry?: () => boolean;
  /** Override for tests. Default {@link BACKFILL_MAX_RETRIES}. */
  maxRetries?: number;
  /** Override for tests. Default {@link BACKFILL_RETRY_BASE_DELAY_MS}. */
  retryBaseDelayMs?: number;
}

/**
 * Unref'd, abort-aware sleep. Resolves early (never rejects) when the signal
 * fires so a demoted/stopped pod exits its backoff window immediately.
 */
function backoffSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Fire the backfill in the background with a bounded retry loop. The stop fn
 * aborts between batches and cancels any pending backoff timer (in-flight SQL
 * statements are not cancelable); progress persists at the watermark, so
 * stopping loses nothing.
 */
export function startFillRollupBackfill(
  deps: FillRollupBackfillDeps
): FillRollupBackfillStopFn {
  const log = deps.logger.child({ component: "fill-rollup-backfill-job" });
  const controller = new AbortController();
  const maxRetries = deps.maxRetries ?? BACKFILL_MAX_RETRIES;
  const baseDelayMs = deps.retryBaseDelayMs ?? BACKFILL_RETRY_BASE_DELAY_MS;
  const shouldRetry = deps.shouldRetry ?? (() => true);

  log.info(
    { event: "poly.fill_rollup.backfill_start", max_retries: maxRetries },
    "fill-rollup backfill starting (serialized; bounded retry on failure)"
  );

  void (async () => {
    // attempt 0 = the initial run; attempts 1..maxRetries are retries.
    for (let attempt = 0; ; attempt += 1) {
      const startedAt = Date.now();
      let failure: string;
      let schemaMissing: boolean;
      try {
        const result = await backfillFillRollups(deps.db, {
          logger: deps.logger,
          signal: controller.signal,
        });
        if (result.completed) {
          log.info(
            {
              event: "poly.fill_rollup.backfill_complete",
              attempt,
              wallets: result.wallets,
              wallets_completed: result.walletsCompleted,
              fills: result.fills,
              batches: result.batches,
              completed: result.completed,
              duration_ms: Date.now() - startedAt,
            },
            "fill-rollup backfill finished"
          );
          return;
        }
        if (controller.signal.aborted) {
          // Stopped (shutdown or leader demotion) mid-run — not a failure.
          log.info(
            { event: "poly.fill_rollup.backfill_stopped", attempt },
            "fill-rollup backfill stopped mid-run — resumable at watermark"
          );
          return;
        }
        failure = `incomplete run: ${result.walletsCompleted}/${result.wallets} wallets caught up; first errors: ${result.errors.join(" | ") || "none reported"}`;
        schemaMissing = result.errors.some((msg) =>
          SCHEMA_MISSING_RE.test(msg)
        );
      } catch (err: unknown) {
        failure = err instanceof Error ? err.message : String(err);
        schemaMissing = SCHEMA_MISSING_RE.test(failure);
      }

      const durationMs = Date.now() - startedAt;
      if (schemaMissing) {
        log.error(
          {
            event: "poly.fill_rollup.backfill_schema_missing",
            attempt,
            duration_ms: durationMs,
            err: failure,
          },
          "rollup relation missing — schema behind image, operator bug.5314 (NOT an app fault; do not chase the app); retrying in case a crash-recovery migration lands"
        );
      } else {
        log.error(
          {
            event: "poly.fill_rollup.backfill_failed",
            attempt,
            duration_ms: durationMs,
            err: failure,
          },
          "fill-rollup backfill run failed — resumable at watermark; readers serve the live tail meanwhile"
        );
      }

      if (attempt >= maxRetries) {
        log.error(
          {
            event: "poly.fill_rollup.backfill_gave_up",
            attempts: attempt + 1,
            err: failure,
          },
          "fill-rollup backfill exhausted all retries — giving up until next boot; watermark preserved, readers serve the live tail"
        );
        return;
      }

      const retryAttempt = attempt + 1;
      const delayMs = baseDelayMs * 2 ** attempt;
      log.warn(
        {
          event: "poly.fill_rollup.backfill_retry",
          attempt: retryAttempt,
          max_retries: maxRetries,
          delay_ms: delayMs,
        },
        "fill-rollup backfill retry scheduled"
      );
      await backoffSleep(delayMs, controller.signal);
      if (controller.signal.aborted) {
        log.info(
          { event: "poly.fill_rollup.backfill_stopped", attempt: retryAttempt },
          "fill-rollup backfill stopped during backoff — resumable at watermark"
        );
        return;
      }
      if (!shouldRetry()) {
        log.info(
          {
            event: "poly.fill_rollup.backfill_retry_abandoned",
            attempt: retryAttempt,
          },
          "fill-rollup backfill retry abandoned — env gate off or job leadership lost; resumable at watermark on next leader boot"
        );
        return;
      }
    }
  })();

  return () => {
    controller.abort(new Error("fill-rollup backfill stopped"));
  };
}

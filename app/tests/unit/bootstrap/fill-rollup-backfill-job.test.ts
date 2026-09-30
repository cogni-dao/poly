// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/fill-rollup-backfill-job`
 * Purpose: Prove the fill-rollup backfill job's bounded retry loop
 *          (fix/backfill-retry-backoff): a failed run (thrown OR
 *          `completed:false`) retries on the exponential 1m→2m→4m→8m→16m
 *          schedule, `shouldRetry` (env gate + task.5016 leadership) is
 *          re-checked before every retry, schema-missing failures classify
 *          as operator bug.5314 yet still retry, and exhausted retries give
 *          up loudly with the watermark preserved.
 * Scope: Job wiring tests with a mocked backfill service and fake timers.
 *        No DB, no HTTP.
 * Invariants:
 *   - SUCCESS_ENDS_LOOP: a `completed:true` run schedules no retry.
 *   - BACKOFF_SCHEDULE_RESPECTED: retry N fires only after base * 2^(N-1).
 *   - RECHECK_BEFORE_RETRY: `shouldRetry() === false` at fire time abandons
 *     the loop; stop() during backoff also ends it without another run.
 *   - SCHEMA_MISSING_STILL_RETRIES: `relation ... does not exist` →
 *     `backfill_schema_missing` naming bug.5314, retry proceeds on schedule.
 *   - MAX_ATTEMPTS_GIVES_UP: 1 initial + 5 retries, then `backfill_gave_up`.
 * Side-effects: none (fake timers)
 * Links: src/bootstrap/jobs/fill-rollup-backfill.job.ts,
 *   src/features/wallet-analysis/server/fill-rollup-service.ts
 * @public
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKFILL_MAX_RETRIES,
  BACKFILL_RETRY_BASE_DELAY_MS,
  startFillRollupBackfill,
} from "@/bootstrap/jobs/fill-rollup-backfill.job";
import {
  backfillFillRollups,
  type BackfillFillRollupsResult,
} from "@/features/wallet-analysis/server/fill-rollup-service";

vi.mock("@/features/wallet-analysis/server/fill-rollup-service", () => ({
  backfillFillRollups: vi.fn(),
}));

const backfillMock = vi.mocked(backfillFillRollups);

const MINUTE = 60_000;
const SCHEMA_MISSING_MSG =
  'relation "poly_trader_fill_rollups_daily" does not exist';

function backfillResult(
  overrides: Partial<BackfillFillRollupsResult> = {}
): BackfillFillRollupsResult {
  return {
    wallets: 6,
    walletsCompleted: 6,
    fills: 100,
    batches: 2,
    completed: true,
    errors: [],
    ...overrides,
  };
}

function failedResult(
  overrides: Partial<BackfillFillRollupsResult> = {}
): BackfillFillRollupsResult {
  return backfillResult({
    walletsCompleted: 0,
    fills: 0,
    batches: 0,
    completed: false,
    ...overrides,
  });
}

function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

function makeDeps(
  logger: ReturnType<typeof makeLogger>,
  overrides: { shouldRetry?: () => boolean } = {}
) {
  return {
    db: {} as never,
    logger: logger as never,
    ...overrides,
  };
}

function logCalls(fn: ReturnType<typeof vi.fn>, event: string) {
  return fn.mock.calls.filter(
    (call) => (call[0] as { event?: string }).event === event
  );
}

describe("fill-rollup backfill bounded retry (fix/backfill-retry-backoff)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    backfillMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not retry when the first run completes", async () => {
    const logger = makeLogger();
    backfillMock.mockResolvedValue(backfillResult());

    const stop = startFillRollupBackfill(makeDeps(logger));
    await vi.advanceTimersByTimeAsync(0);
    expect(backfillMock).toHaveBeenCalledTimes(1);
    expect(logCalls(logger.info, "poly.fill_rollup.backfill_complete")).toHaveLength(1);

    // Nothing scheduled — a long fast-forward triggers no second run.
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(backfillMock).toHaveBeenCalledTimes(1);
    expect(logCalls(logger.warn, "poly.fill_rollup.backfill_retry")).toHaveLength(0);
    stop();
  });

  it("retries a failed run on the exponential backoff schedule", async () => {
    const logger = makeLogger();
    // Run 1: throws. Run 2: completed:false. Run 3: succeeds.
    backfillMock
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(failedResult({ errors: ["deadline exceeded"] }))
      .mockResolvedValueOnce(backfillResult());

    const stop = startFillRollupBackfill(makeDeps(logger));
    await vi.advanceTimersByTimeAsync(0);
    expect(backfillMock).toHaveBeenCalledTimes(1);

    // First retry waits the full 1m — not a millisecond less.
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(backfillMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(backfillMock).toHaveBeenCalledTimes(2);

    // Second retry doubles to 2m.
    await vi.advanceTimersByTimeAsync(2 * MINUTE - 1);
    expect(backfillMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(backfillMock).toHaveBeenCalledTimes(3);

    // Third run succeeded — loop over, no further runs.
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(backfillMock).toHaveBeenCalledTimes(3);

    const retries = logCalls(logger.warn, "poly.fill_rollup.backfill_retry");
    expect(retries).toHaveLength(2);
    expect(retries[0]?.[0]).toMatchObject({ attempt: 1, delay_ms: MINUTE });
    expect(retries[1]?.[0]).toMatchObject({ attempt: 2, delay_ms: 2 * MINUTE });
    expect(logCalls(logger.info, "poly.fill_rollup.backfill_complete")).toHaveLength(1);
    stop();
  });

  it("abandons retries when shouldRetry reports leadership lost", async () => {
    const logger = makeLogger();
    backfillMock.mockResolvedValue(failedResult({ errors: ["boom"] }));
    let leader = true;

    const stop = startFillRollupBackfill(
      makeDeps(logger, { shouldRetry: () => leader })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(backfillMock).toHaveBeenCalledTimes(1);

    // Demoted during the backoff window → the scheduled retry must not run.
    leader = false;
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(backfillMock).toHaveBeenCalledTimes(1);
    expect(
      logCalls(logger.info, "poly.fill_rollup.backfill_retry_abandoned")
    ).toHaveLength(1);
    stop();
  });

  it("stop() during backoff ends the loop without another run", async () => {
    const logger = makeLogger();
    backfillMock.mockResolvedValue(failedResult({ errors: ["boom"] }));

    const stop = startFillRollupBackfill(makeDeps(logger));
    await vi.advanceTimersByTimeAsync(0);
    expect(backfillMock).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(backfillMock).toHaveBeenCalledTimes(1);
    expect(logCalls(logger.info, "poly.fill_rollup.backfill_stopped")).toHaveLength(1);
    stop();
  });

  it("classifies schema-missing as operator bug.5314 and still retries", async () => {
    const logger = makeLogger();
    // The bug.5314 shape: every wallet errors on the missing relation, the
    // walker swallows per-wallet errors → completed:false, nothing thrown.
    backfillMock
      .mockResolvedValueOnce(failedResult({ errors: [SCHEMA_MISSING_MSG] }))
      .mockResolvedValueOnce(backfillResult());

    const stop = startFillRollupBackfill(makeDeps(logger));
    await vi.advanceTimersByTimeAsync(0);

    const schemaLogs = logCalls(
      logger.error,
      "poly.fill_rollup.backfill_schema_missing"
    );
    expect(schemaLogs).toHaveLength(1);
    // Triage must be pointed at the operator bug, not the app.
    expect(schemaLogs[0]?.[1]).toContain("bug.5314");
    expect(logCalls(logger.error, "poly.fill_rollup.backfill_failed")).toHaveLength(0);

    // STILL retries on schedule — a crash-recovery migration might land.
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(backfillMock).toHaveBeenCalledTimes(2);
    expect(logCalls(logger.info, "poly.fill_rollup.backfill_complete")).toHaveLength(1);
    stop();
  });

  it("classifies a thrown schema-missing error the same way", async () => {
    const logger = makeLogger();
    backfillMock
      .mockRejectedValueOnce(new Error(SCHEMA_MISSING_MSG))
      .mockResolvedValueOnce(backfillResult());

    const stop = startFillRollupBackfill(makeDeps(logger));
    await vi.advanceTimersByTimeAsync(0);
    expect(
      logCalls(logger.error, "poly.fill_rollup.backfill_schema_missing")
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(backfillMock).toHaveBeenCalledTimes(2);
    stop();
  });

  it("gives up loudly after the initial run plus five failed retries", async () => {
    const logger = makeLogger();
    backfillMock.mockRejectedValue(new Error("db down"));

    const stop = startFillRollupBackfill(makeDeps(logger));
    await vi.advanceTimersByTimeAsync(0);
    expect(backfillMock).toHaveBeenCalledTimes(1);

    // Walk the full 1m, 2m, 4m, 8m, 16m schedule.
    for (const [i, delayMin] of [1, 2, 4, 8, 16].entries()) {
      await vi.advanceTimersByTimeAsync(delayMin * MINUTE);
      expect(backfillMock).toHaveBeenCalledTimes(i + 2);
    }
    expect(backfillMock).toHaveBeenCalledTimes(1 + BACKFILL_MAX_RETRIES);

    const gaveUp = logCalls(logger.error, "poly.fill_rollup.backfill_gave_up");
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]?.[0]).toMatchObject({
      attempts: 1 + BACKFILL_MAX_RETRIES,
    });

    // Truly done — no zombie timer wakes it later.
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(backfillMock).toHaveBeenCalledTimes(1 + BACKFILL_MAX_RETRIES);
    expect(logCalls(logger.warn, "poly.fill_rollup.backfill_retry")).toHaveLength(
      BACKFILL_MAX_RETRIES
    );
    stop();
  });

  it("exports the production policy: 5 retries from a 1m base", () => {
    expect(BACKFILL_MAX_RETRIES).toBe(5);
    expect(BACKFILL_RETRY_BASE_DELAY_MS).toBe(MINUTE);
  });
});

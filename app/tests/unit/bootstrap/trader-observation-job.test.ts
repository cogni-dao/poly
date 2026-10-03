// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/trader-observation-job`
 * Purpose: Prove the trader-observation job's tick timeout is real
 *          cancellation (task.5015): it aborts the AbortSignal threaded into
 *          `runTraderObservationTick`, logs `tick_timeout` with wallets
 *          completed/remaining, releases the `running` lock, and keeps the
 *          overlapping-tick guard intact.
 * Scope: Job wiring tests with a mocked tick service and fake timers. No DB,
 *        no HTTP.
 * Invariants:
 *   - TICK_TIMEOUT_IS_REAL_CANCELLATION: timeout → signal.aborted → tick
 *     settles cooperatively → `tick_timeout` log carries completed/remaining.
 *   - OVERLAP_GUARD_KEPT: while a tick is in flight, interval fires log
 *     `tick_skipped_running` and do not start a second tick.
 *   - GRACE_BOUNDED_ABANDON: a tick that never settles after abort is
 *     abandoned after the grace window with `settled_after_abort: false`.
 * Side-effects: none (fake timers)
 * Links: work/items/task.5015, src/bootstrap/jobs/trader-observation.job.ts
 * @public
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTraderObservationJob } from "@/bootstrap/jobs/trader-observation.job";
import {
  runTraderObservationTick,
  type TraderObservationTickDeps,
  type TraderObservationTickResult,
} from "@/features/wallet-analysis/server/trader-observation-service";

vi.mock("@/features/wallet-analysis/server/trader-observation-service", () => ({
  runTraderObservationTick: vi.fn(),
}));

const tickMock = vi.mocked(runTraderObservationTick);

const TICK_TIMEOUT_MS = 120_000;
const ABORT_SETTLE_GRACE_MS = 5_000;

function tickResult(
  overrides: Partial<TraderObservationTickResult> = {}
): TraderObservationTickResult {
  return {
    wallets: 5,
    walletsProcessed: 5,
    walletsAborted: 0,
    fills: 0,
    positions: 0,
    pnlPoints: 0,
    prunedPnlPoints: 0,
    prunedPositionSnapshots: 0,
    errors: 0,
    ...overrides,
  };
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

function makeDeps(logger: ReturnType<typeof makeLogger>, pollMs: number) {
  return {
    db: {} as never,
    client: {} as never,
    listActiveTradingAddresses: async () => [],
    readPositionBalances: async () => [],
    logger: logger as never,
    metrics: {} as never,
    pollMs,
  };
}

function logCalls(fn: ReturnType<typeof vi.fn>, phase: string) {
  return fn.mock.calls.filter(
    (call) => (call[0] as { phase?: string }).phase === phase
  );
}

describe("trader-observation job cancellation (task.5015)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tickMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts the tick signal on timeout and logs tick_timeout with completed/remaining", async () => {
    const logger = makeLogger();
    let seenSignal: AbortSignal | undefined;
    // Cooperative tick: settles only when its signal aborts, reporting a
    // partially completed wallet loop.
    tickMock.mockImplementation(
      (deps: TraderObservationTickDeps) =>
        new Promise<TraderObservationTickResult>((resolve) => {
          seenSignal = deps.signal;
          deps.signal?.addEventListener(
            "abort",
            () =>
              resolve(tickResult({ walletsProcessed: 2, walletsAborted: 3 })),
            { once: true }
          );
        })
    );

    // Huge pollMs so interval fires don't interleave with this test.
    const stop = startTraderObservationJob(makeDeps(logger, 10_000_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(tickMock).toHaveBeenCalledTimes(1);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(TICK_TIMEOUT_MS);

    expect(seenSignal?.aborted).toBe(true);
    const timeoutLogs = logCalls(logger.error, "tick_timeout");
    expect(timeoutLogs).toHaveLength(1);
    expect(timeoutLogs[0]?.[0]).toMatchObject({
      event: "poly.trader.observe",
      phase: "tick_timeout",
      timeout_ms: TICK_TIMEOUT_MS,
      settled_after_abort: true,
      wallets: 5,
      wallets_completed: 2,
      wallets_remaining: 3,
    });
    stop();
  });

  it("keeps the overlapping-tick guard: interval fires skip while a tick is running", async () => {
    const logger = makeLogger();
    tickMock.mockImplementation(
      (deps: TraderObservationTickDeps) =>
        new Promise<TraderObservationTickResult>((resolve) => {
          deps.signal?.addEventListener(
            "abort",
            () =>
              resolve(tickResult({ walletsProcessed: 0, walletsAborted: 5 })),
            { once: true }
          );
        })
    );

    const stop = startTraderObservationJob(makeDeps(logger, 30_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(tickMock).toHaveBeenCalledTimes(1);

    // Three interval fires while the first tick is still in flight.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(tickMock).toHaveBeenCalledTimes(1);
    expect(
      logCalls(logger.warn, "tick_skipped_running").length
    ).toBeGreaterThanOrEqual(3);
    stop();
  });

  it("releases the running lock after a timed-out tick so the next interval tick starts", async () => {
    const logger = makeLogger();
    tickMock.mockImplementation(
      (deps: TraderObservationTickDeps) =>
        new Promise<TraderObservationTickResult>((resolve) => {
          deps.signal?.addEventListener(
            "abort",
            () =>
              resolve(tickResult({ walletsProcessed: 1, walletsAborted: 4 })),
            { once: true }
          );
        })
    );

    const stop = startTraderObservationJob(makeDeps(logger, 30_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(tickMock).toHaveBeenCalledTimes(1);

    // First tick times out at 120s and settles via its abort listener; the
    // following interval fire must start a fresh tick (lock released).
    await vi.advanceTimersByTimeAsync(TICK_TIMEOUT_MS + 30_000);
    expect(tickMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      logCalls(logger.error, "tick_timeout").length
    ).toBeGreaterThanOrEqual(1);
    stop();
  });

  it("abandons a tick that never settles after the abort grace window", async () => {
    const logger = makeLogger();
    // Pathological tick: ignores its signal entirely and never settles.
    tickMock.mockImplementation(
      () => new Promise<TraderObservationTickResult>(() => undefined)
    );

    const stop = startTraderObservationJob(makeDeps(logger, 10_000_000));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(TICK_TIMEOUT_MS + ABORT_SETTLE_GRACE_MS);

    const timeoutLogs = logCalls(logger.error, "tick_timeout");
    expect(timeoutLogs).toHaveLength(1);
    expect(timeoutLogs[0]?.[0]).toMatchObject({
      phase: "tick_timeout",
      settled_after_abort: false,
      wallets_completed: null,
      wallets_remaining: null,
    });
    stop();
  });

  it("does not log tick_timeout for a tick that completes in time", async () => {
    const logger = makeLogger();
    tickMock.mockResolvedValue(tickResult());

    const stop = startTraderObservationJob(makeDeps(logger, 30_000));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);

    // First tick + one interval tick, no timeout/error logs.
    expect(tickMock).toHaveBeenCalledTimes(2);
    expect(logCalls(logger.error, "tick_timeout")).toHaveLength(0);
    expect(logCalls(logger.error, "tick_error")).toHaveLength(0);
    stop();
  });

  // RETENTION_PRUNE_CADENCE (prod EXPLAIN 2026-10-01) — the retention prunes must not run on
  // every 30s poll. Prod EXPLAIN showed the snapshot prune burning 30-72s of
  // disk I/O per tick to delete zero rows; gating the cadence removes that.
  it("gates the retention prune: off on boot and every tick until the interval elapses, then exactly one run", async () => {
    const logger = makeLogger();
    tickMock.mockResolvedValue(tickResult());

    const stop = startTraderObservationJob(makeDeps(logger, 30_000));
    await vi.advanceTimersByTimeAsync(0);

    // Boot tick does NOT run the prune (never pile prune load onto a restart).
    expect(
      (tickMock.mock.calls[0]?.[0] as TraderObservationTickDeps)
        .runRetentionPrune
    ).toBe(false);

    // Every tick for the first 29 minutes keeps skipping the prune.
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(
      tickMock.mock.calls.every(
        (call) =>
          (call[0] as TraderObservationTickDeps).runRetentionPrune === false
      )
    ).toBe(true);

    // Crossing the 30-min retention interval triggers exactly one prune run;
    // subsequent ticks in the window back off again.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const pruneRuns = tickMock.mock.calls.filter(
      (call) =>
        (call[0] as TraderObservationTickDeps).runRetentionPrune === true
    );
    expect(pruneRuns).toHaveLength(1);
    stop();
  });
});

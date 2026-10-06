// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/research-prewarm-job`
 * Purpose: Prove the recurring comparison prewarm
 *   (fix/comparison-per-wallet-cache): each tick warms EXACTLY the two fixed
 *   research targets (RN1, swisstony) through the per-wallet comparison cache
 *   at the board-default 1W interval ON THE BACKGROUND BUDGET LANE
 *   (fix/prewarm-budget-split — prewarm computes must complete un-degraded to
 *   populate the cache); the cadence stays below the cache's fresh window;
 *   each tick logs a tick-scoped completion event (prod Loki proof); stop()
 *   halts future ticks.
 * Scope: Job wiring tests with the research-read-cache module mocked and fake
 *   timers. No DB, no HTTP.
 * Invariants under test: RECURRING_COMPARISON_PREWARM, ONE_SHOT_BOOT_REST,
 *   TICK_NO_OVERLAP cadence < RESEARCH_READ_FRESH_MS (job docstring).
 * Side-effects: none (fake timers)
 * Links: src/bootstrap/jobs/research-prewarm.job.ts,
 *        src/features/wallet-analysis/server/research-read-cache.ts
 * @internal
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPARISON_DEFAULT_INTERVAL,
  COMPARISON_PREWARM_POLL_MS,
  PREWARM_WALLETS,
  startResearchPrewarm,
} from "@/bootstrap/jobs/research-prewarm.job";
import {
  getBenchmarkSliceCached,
  getComparisonWalletCached,
  getSnapshotSliceCached,
  getTargetOverlapSliceCached,
  RESEARCH_READ_FRESH_MS,
} from "@/features/wallet-analysis/server/research-read-cache";

vi.mock("@/features/wallet-analysis/server/research-read-cache", async () => {
  const actual = await vi.importActual<
    typeof import("@/features/wallet-analysis/server/research-read-cache")
  >("@/features/wallet-analysis/server/research-read-cache");
  return {
    RESEARCH_READ_FRESH_MS: actual.RESEARCH_READ_FRESH_MS,
    getComparisonWalletCached: vi.fn(async () => ({})),
    getSnapshotSliceCached: vi.fn(async () => ({ kind: "ok", value: {} })),
    getBenchmarkSliceCached: vi.fn(async () => ({ kind: "ok", value: {} })),
    getTargetOverlapSliceCached: vi.fn(async () => ({})),
  };
});

const comparisonMock = vi.mocked(getComparisonWalletCached);
const snapshotMock = vi.mocked(getSnapshotSliceCached);
const benchmarkMock = vi.mocked(getBenchmarkSliceCached);
const overlapMock = vi.mocked(getTargetOverlapSliceCached);

const RN1 = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const SWISSTONY = "0x204f72f35326db932158cba6adff0b9a1da95e14";

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

/** The (address, interval) pairs the comparison mock was warmed with. */
function comparisonCalls(): Array<[string, string]> {
  return comparisonMock.mock.calls.map((call) => [call[1], call[2]]);
}

describe("research prewarm job: recurring comparison re-warm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cadence is below the cache fresh window, so warmed entries never expire past staleMs", () => {
    expect(COMPARISON_PREWARM_POLL_MS).toBeLessThan(RESEARCH_READ_FRESH_MS);
  });

  it("boot pass warms the two comparison targets at 1W plus the one-shot entries", async () => {
    const stop = startResearchPrewarm({
      db: {} as never,
      logger: makeLogger() as never,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(comparisonCalls().sort()).toEqual([
      [RN1, COMPARISON_DEFAULT_INTERVAL],
      [SWISSTONY, COMPARISON_DEFAULT_INTERVAL],
    ]);
    // One-shot boot entries fire once each (ONE_SHOT_BOOT_REST).
    expect(overlapMock).toHaveBeenCalledTimes(1);
    expect(snapshotMock).toHaveBeenCalledTimes(PREWARM_WALLETS.length);
    expect(benchmarkMock).toHaveBeenCalledTimes(PREWARM_WALLETS.length);
    stop();
  });

  it("each tick warms exactly the two targets again — nothing else, no other intervals", async () => {
    const stop = startResearchPrewarm({
      db: {} as never,
      logger: makeLogger() as never,
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();

    await vi.advanceTimersByTimeAsync(COMPARISON_PREWARM_POLL_MS);
    expect(comparisonCalls().sort()).toEqual([
      [RN1, COMPARISON_DEFAULT_INTERVAL],
      [SWISSTONY, COMPARISON_DEFAULT_INTERVAL],
    ]);
    // The recurring tick does NOT re-run the one-shot boot entries.
    expect(overlapMock).not.toHaveBeenCalled();
    expect(snapshotMock).not.toHaveBeenCalled();
    expect(benchmarkMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(COMPARISON_PREWARM_POLL_MS);
    expect(comparisonMock).toHaveBeenCalledTimes(4);
    expect(
      comparisonCalls().every(([, interval]) => interval === "1W")
    ).toBe(true);
    stop();
  });

  it("every comparison warm (boot and tick) runs on the background budget lane", async () => {
    const stop = startResearchPrewarm({
      db: {} as never,
      logger: makeLogger() as never,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(COMPARISON_PREWARM_POLL_MS);

    // fix/prewarm-budget-split: a request-lane warm would burn the 8s budget
    // on a cold target and (DEGRADED_NOT_PINNED) cache nothing, forever.
    expect(comparisonMock.mock.calls.length).toBeGreaterThan(0);
    expect(
      comparisonMock.mock.calls.every(
        (call) => call[3]?.lane === "background"
      )
    ).toBe(true);
    stop();
  });

  it("each tick logs a tick-scoped completion event (prod Loki proof the loop is alive)", async () => {
    const logger = makeLogger();
    const stop = startResearchPrewarm({
      db: {} as never,
      logger: logger as never,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "poly.research-prewarm.tick_complete" }),
      expect.any(String)
    );

    await vi.advanceTimersByTimeAsync(COMPARISON_PREWARM_POLL_MS);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "poly.research-prewarm.tick_complete",
        ok: PREWARM_WALLETS.length,
        failed: 0,
      }),
      expect.any(String)
    );
    stop();
  });

  it("stop() halts future ticks", async () => {
    const stop = startResearchPrewarm({
      db: {} as never,
      logger: makeLogger() as never,
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();

    stop();
    await vi.advanceTimersByTimeAsync(COMPARISON_PREWARM_POLL_MS * 3);
    expect(comparisonMock).not.toHaveBeenCalled();
  });

  it("a tick still running when the next fires is skipped (TICK_NO_OVERLAP)", async () => {
    // Make every comparison warm hang until released.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    comparisonMock.mockImplementation(async () => {
      await gate;
      return {} as never;
    });

    const logger = makeLogger();
    const stop = startResearchPrewarm({
      db: {} as never,
      logger: logger as never,
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();

    // First tick starts (hangs); second interval fire must skip, not stack.
    await vi.advanceTimersByTimeAsync(COMPARISON_PREWARM_POLL_MS * 2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "poly.research-prewarm.tick_skipped_running",
      }),
      expect.any(String)
    );
    release();
    stop();
  });
});

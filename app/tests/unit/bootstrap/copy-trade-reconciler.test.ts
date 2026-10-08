// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/copy-trade-reconciler`
 * Purpose: Prove every saved mirror-policy assignment replaces its running
 *          poll on the reconciler's next, at-most-30-second tick.
 * Scope: Pure orchestration with fake timers; no DB or network.
 * Invariants:
 *   - POLICY_CHANGE_RESTARTS: kind and every policy knob are fingerprinted.
 *   - ACTIVATION_REVISION_RESTARTS: a successful PATCH revision is sufficient.
 *   - STOP_BEFORE_START: the stale poll is stopped before its replacement.
 *   - UNCHANGED_STAYS_RUNNING: stable rows do not churn polls.
 * Side-effects: none (fake timers)
 * Links: src/bootstrap/copy-trade-reconciler.ts, story.5009
 * @public
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCopyTradeReconciler } from "@/bootstrap/copy-trade-reconciler";
import type { EnumeratedTarget } from "@/features/copy-trade/target-source";

const RECONCILE_MS = 30_000;

function target(overrides: Partial<EnumeratedTarget> = {}): EnumeratedTarget {
  return {
    billingAccountId: "billing-1",
    createdByUserId: "user-1",
    targetWallet: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
    mirrorActivatedAt: new Date("2026-10-07T03:15:40.799Z"),
    mirrorFilterPercentile: 98,
    mirrorMaxUsdcPerTrade: 5,
    sizingPolicyKind: "target_percentile_scaled",
    targetRangeMaxUsdc: null,
    mirrorMaxAllocPerConditionUsdc: null,
    mirrorCapitalBudgetUsdc: null,
    positionGapBudgetGroup: {
      positionGapTargetCount: 0,
      explicitBudgetTotalUsdc: 0,
      automaticTargetCount: 1,
      unbudgetedTargetCount: 0,
    },
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

describe("copy-trade target reconciliation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    ["algorithm kind", { sizingPolicyKind: "position_gap" as const }],
    ["filter percentile", { mirrorFilterPercentile: 97 }],
    ["per-trade cap", { mirrorMaxUsdcPerTrade: 6 }],
    ["position range", { targetRangeMaxUsdc: 20 }],
    ["position allocation", { mirrorMaxAllocPerConditionUsdc: 50 }],
    ["portfolio budget", { mirrorCapitalBudgetUsdc: 200 }],
    [
      "account budget group",
      {
        positionGapBudgetGroup: {
          positionGapTargetCount: 1,
          explicitBudgetTotalUsdc: 200,
          automaticTargetCount: 0,
          unbudgetedTargetCount: 1,
        },
      },
    ],
    [
      "activation revision",
      { mirrorActivatedAt: new Date("2026-10-07T03:15:41.000Z") },
    ],
  ])("restarts within one tick when %s changes", async (_label, change) => {
    let current = target();
    const events: string[] = [];
    const startPollForTarget = vi.fn((started: EnumeratedTarget) => {
      const marker = `${started.sizingPolicyKind}:${started.mirrorActivatedAt.toISOString()}`;
      events.push(`start:${marker}`);
      return () => events.push(`stop:${marker}`);
    });

    const stop = startCopyTradeReconciler({
      targetSource: { listAllActive: async () => [current] },
      startPollForTarget,
      logger: makeLogger() as never,
      intervalMs: RECONCILE_MS,
    });
    await vi.advanceTimersByTimeAsync(0);

    current = target(change);
    await vi.advanceTimersByTimeAsync(RECONCILE_MS - 1);
    expect(startPollForTarget).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(startPollForTarget).toHaveBeenCalledTimes(2);
    expect(events[1]).toMatch(/^stop:/);
    expect(events[2]).toMatch(/^start:/);
    stop();
  });

  it("keeps an unchanged policy on the same running poll", async () => {
    const current = target();
    const pollStop = vi.fn();
    const startPollForTarget = vi.fn(() => pollStop);
    const stop = startCopyTradeReconciler({
      targetSource: { listAllActive: async () => [current] },
      startPollForTarget,
      logger: makeLogger() as never,
      intervalMs: RECONCILE_MS,
    });

    await vi.advanceTimersByTimeAsync(RECONCILE_MS * 2);
    expect(startPollForTarget).toHaveBeenCalledTimes(1);
    expect(pollStop).not.toHaveBeenCalled();
    stop();
  });

  it("awaits the old generation shutdown before starting a changed config", async () => {
    let current = target();
    let releaseOld!: () => void;
    const oldStopped = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const events: string[] = [];
    const startPollForTarget = vi.fn((started: EnumeratedTarget) => {
      const revision = started.mirrorActivatedAt.toISOString();
      events.push(`start:${revision}`);
      if (startPollForTarget.mock.calls.length === 1) {
        return async () => {
          events.push(`stop:${revision}`);
          await oldStopped;
        };
      }
      return () => events.push(`stop:${revision}`);
    });
    const stop = startCopyTradeReconciler({
      targetSource: { listAllActive: async () => [current] },
      startPollForTarget,
      logger: makeLogger() as never,
      intervalMs: RECONCILE_MS,
    });
    await vi.advanceTimersByTimeAsync(0);

    current = target({
      mirrorActivatedAt: new Date("2026-10-07T03:15:41.000Z"),
      mirrorCapitalBudgetUsdc: 20,
    });
    await vi.advanceTimersByTimeAsync(RECONCILE_MS);
    expect(events).toEqual([
      "start:2026-10-07T03:15:40.799Z",
      "stop:2026-10-07T03:15:40.799Z",
    ]);

    releaseOld();
    await vi.advanceTimersByTimeAsync(0);
    expect(events[2]).toBe("start:2026-10-07T03:15:41.000Z");
    stop();
  });
});

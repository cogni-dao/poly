// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/research-read-cache-budget-lanes`
 * Purpose: Prove the budget split (fix/prewarm-budget-split):
 *   - BUDGET_LANES: the request lane plumbs `POLY_RESEARCH_WALLET_BUDGET_MS`
 *     into the per-wallet compute; the background lane plumbs the generous
 *     `POLY_RESEARCH_PREWARM_BUDGET_MS` instead;
 *   - BACKGROUND_HEAL: a request-lane budget burn kicks exactly ONE
 *     background-lane recompute that lands in the shared per-wallet cache, so
 *     the next request hits warm;
 *   - single-flight guard: concurrent burns while a heal is in flight do NOT
 *     stack additional background computes;
 *   - REQUEST_SETTLE_CEILING: a request that coalesces onto a hanging
 *     background compute still settles within the request budget (degraded),
 *     instead of waiting out the background budget;
 *   - a background-lane result that still burns never re-kicks (no heal loop).
 * Scope: Unit — `computeTraderComparisonWallet` mocked (budget capture +
 *   scripted results); serverEnv mocked. Real coalesce cache (cleared per
 *   test). No Postgres, no fake timers (budgets are tens of ms).
 * Invariants under test: BUDGET_LANES, BACKGROUND_HEAL,
 *   REQUEST_SETTLE_CEILING, DEGRADED_NOT_PINNED (research-read-cache
 *   docstring).
 * Side-effects: module-scope TTL cache (cleared per test).
 * Links: src/features/wallet-analysis/server/research-read-cache.ts,
 *        src/bootstrap/jobs/research-prewarm.job.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTtlCache } from "@/features/wallet-analysis/server/coalesce";
import {
  getComparisonWalletCached,
  researchComparisonHealsInFlight,
} from "@/features/wallet-analysis/server/research-read-cache";
import {
  computeTraderComparisonWallet,
  TRADER_COMPARISON_BUDGET_WARNING_CODE,
  type TraderComparisonWalletResult,
} from "@/features/wallet-analysis/server/trader-comparison-service";

const REQUEST_BUDGET_MS = 40;
const BACKGROUND_BUDGET_MS = 45_000;

vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => ({
    POLY_RESEARCH_WALLET_BUDGET_MS: 40,
    POLY_RESEARCH_PREWARM_BUDGET_MS: 45_000,
  }),
}));

vi.mock(
  "@/features/wallet-analysis/server/trader-comparison-service",
  async () => {
    const actual = await vi.importActual<
      typeof import("@/features/wallet-analysis/server/trader-comparison-service")
    >("@/features/wallet-analysis/server/trader-comparison-service");
    return { ...actual, computeTraderComparisonWallet: vi.fn() };
  }
);

const computeMock = vi.mocked(computeTraderComparisonWallet);
const db = {} as Parameters<typeof getComparisonWalletCached>[0];

const RN1 = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" as const;

function completeResult(): TraderComparisonWalletResult {
  return {
    address: RN1,
    capturedAt: new Date().toISOString(),
    trader: { address: RN1, label: "RN1" } as never,
    warnings: [],
  };
}

function degradedResult(budgetMs: number): TraderComparisonWalletResult {
  return {
    address: RN1,
    capturedAt: new Date().toISOString(),
    trader: null,
    warnings: [
      {
        wallet: RN1,
        code: TRADER_COMPARISON_BUDGET_WARNING_CODE,
        message: `exceeded the ${budgetMs}ms budget`,
      },
    ],
  };
}

/** The perWalletBudgetMs each compute invocation received, in call order. */
function budgetsPassed(): Array<number | undefined> {
  return computeMock.mock.calls.map((call) => call[3]?.perWalletBudgetMs);
}

async function healsDrained(): Promise<void> {
  await vi.waitFor(() => expect(researchComparisonHealsInFlight()).toBe(0));
}

describe("comparison budget lanes (fix/prewarm-budget-split)", () => {
  beforeEach(() => {
    clearTtlCache();
    vi.clearAllMocks();
  });

  it("request lane plumbs the env request budget into the compute", async () => {
    computeMock.mockResolvedValue(completeResult());
    const result = await getComparisonWalletCached(db, RN1, "1W");
    expect(result.trader).not.toBeNull();
    expect(budgetsPassed()).toEqual([REQUEST_BUDGET_MS]);
    expect(researchComparisonHealsInFlight()).toBe(0);
  });

  it("background lane plumbs the env background budget, and a still-degraded background result never re-kicks (no heal loop)", async () => {
    computeMock.mockResolvedValue(degradedResult(BACKGROUND_BUDGET_MS));
    const result = await getComparisonWalletCached(db, RN1, "1W", {
      lane: "background",
    });
    expect(budgetsPassed()).toEqual([BACKGROUND_BUDGET_MS]);
    expect(result.trader).toBeNull();
    await healsDrained();
    // No second (heal) compute: the background lane is terminal.
    expect(computeMock).toHaveBeenCalledTimes(1);
  });

  it("a request-lane budget burn is served degraded AND kicks one background heal that populates the cache", async () => {
    computeMock.mockImplementation(async (_db, _addr, _interval, opts) =>
      opts?.perWalletBudgetMs === BACKGROUND_BUDGET_MS
        ? completeResult()
        : degradedResult(REQUEST_BUDGET_MS)
    );

    // Burn: user sees the degraded partial fast (serve semantics unchanged)...
    const burned = await getComparisonWalletCached(db, RN1, "1W");
    expect(burned.trader).toBeNull();
    expect(burned.warnings[0]?.code).toBe(
      TRADER_COMPARISON_BUDGET_WARNING_CODE
    );

    // ...the heal recomputes at the background budget and caches the result...
    await healsDrained();
    expect(budgetsPassed()).toEqual([REQUEST_BUDGET_MS, BACKGROUND_BUDGET_MS]);

    // ...so the next request hits warm with NO further compute.
    const healed = await getComparisonWalletCached(db, RN1, "1W");
    expect(healed.trader).not.toBeNull();
    expect(healed.warnings).toEqual([]);
    expect(computeMock).toHaveBeenCalledTimes(2);
  });

  it("concurrent burns don't stack heals, and a joiner settles within the request budget (REQUEST_SETTLE_CEILING)", async () => {
    let releaseHeal: (value: TraderComparisonWalletResult) => void = () => {};
    const healGate = new Promise<TraderComparisonWalletResult>((resolve) => {
      releaseHeal = resolve;
    });
    computeMock.mockImplementation(async (_db, _addr, _interval, opts) =>
      opts?.perWalletBudgetMs === BACKGROUND_BUDGET_MS
        ? healGate
        : degradedResult(REQUEST_BUDGET_MS)
    );

    // First burn kicks the heal (which hangs on the gate).
    await getComparisonWalletCached(db, RN1, "1W");
    await vi.waitFor(() => expect(researchComparisonHealsInFlight()).toBe(1));

    // Second request coalesces onto the hanging background compute: it must
    // settle at the request budget as degraded, NOT wait out the 45s lane...
    const joiner = await getComparisonWalletCached(db, RN1, "1W");
    expect(joiner.trader).toBeNull();
    expect(joiner.warnings[0]?.code).toBe(
      TRADER_COMPARISON_BUDGET_WARNING_CODE
    );
    // ...and its own burn must NOT stack a second heal (single-flight guard).
    expect(researchComparisonHealsInFlight()).toBe(1);
    expect(
      budgetsPassed().filter((b) => b === BACKGROUND_BUDGET_MS)
    ).toHaveLength(1);

    // Heal completes → cache is warm for the next request, no new compute.
    releaseHeal(completeResult());
    await healsDrained();
    const callsBefore = computeMock.mock.calls.length;
    const healed = await getComparisonWalletCached(db, RN1, "1W");
    expect(healed.trader).not.toBeNull();
    expect(computeMock.mock.calls.length).toBe(callsBefore);
  });
});

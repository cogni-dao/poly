// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/research-read-cache-degraded`
 * Purpose: Prove DEGRADED_NOT_PINNED for the trader-comparison SWR cache
 *   (fix/comparison-flows-pushdown): a budget-degraded response (wallet
 *   omitted + `wallet_budget_exceeded` warning) is served to the caller but
 *   never cached, so the next request recomputes instead of a degraded chart
 *   being pinned fresh for 5min / served stale for an hour (the prewarm job
 *   used to pin exactly that). Complete responses stay cached.
 * Scope: Unit — fake Db objects (hanging vs fast-empty, same shapes as
 *   `trader-comparison-budget.test.ts`); serverEnv mocked. No Postgres.
 * Invariants under test: DEGRADED_NOT_PINNED (research-read-cache docstring),
 *   BALANCES_DEGRADED_NOT_CACHED pattern (dashboard-route-cache precedent).
 * Side-effects: module-scope TTL cache (cleared per test).
 * Links: src/features/wallet-analysis/server/research-read-cache.ts,
 *        src/features/wallet-analysis/server/coalesce.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTtlCache } from "@/features/wallet-analysis/server/coalesce";
import {
  getTraderComparisonCached,
  traderComparisonIsCacheable,
} from "@/features/wallet-analysis/server/research-read-cache";
import { TRADER_COMPARISON_BUDGET_WARNING_CODE } from "@/features/wallet-analysis/server/trader-comparison-service";

vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => ({ POLY_RESEARCH_WALLET_BUDGET_MS: 40 }),
}));

const RN1 = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const WALLETS = [{ address: RN1, label: "RN1" }] as const;

type FakeDb = Parameters<typeof getTraderComparisonCached>[0];

/** A Db whose aggregate queries never resolve — the prod slow-wallet shape. */
function hangingDb(): FakeDb {
  return {
    transaction: () => new Promise(() => {}),
    execute: () => new Promise(() => {}),
  } as unknown as FakeDb;
}

/** A Db that answers every aggregate instantly with zero rows. */
function fastEmptyDb(): FakeDb {
  const tx = { execute: async () => [] };
  return {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    execute: async () => [],
  } as unknown as FakeDb;
}

describe("trader-comparison SWR cache: budget-degraded responses are not pinned", () => {
  beforeEach(() => {
    clearTtlCache();
  });

  it("serves the degraded response but evicts it, so the next request recomputes", async () => {
    const degraded = await getTraderComparisonCached(hangingDb(), WALLETS, "1W");
    expect(degraded.traders).toHaveLength(0);
    expect(degraded.warnings).toContainEqual(
      expect.objectContaining({
        wallet: RN1,
        code: TRADER_COMPARISON_BUDGET_WARNING_CODE,
      })
    );

    // Same cache key (same interval + wallet list). Were the degraded payload
    // pinned, this would return it verbatim; instead the recovered backend is
    // consulted and a complete response comes back.
    const recovered = await getTraderComparisonCached(
      fastEmptyDb(),
      WALLETS,
      "1W"
    );
    expect(recovered.traders).toHaveLength(1);
    expect(
      recovered.warnings.some(
        (w) => w.code === TRADER_COMPARISON_BUDGET_WARNING_CODE
      )
    ).toBe(false);
  });

  it("complete responses stay cached (fresh hit returns the same value without recompute)", async () => {
    const first = await getTraderComparisonCached(fastEmptyDb(), WALLETS, "1W");
    // Second call passes a hanging Db: only a cache hit can answer instantly.
    const second = await getTraderComparisonCached(hangingDb(), WALLETS, "1W");
    expect(second).toBe(first);
  });

  it("traderComparisonIsCacheable keys off the budget warning code only", () => {
    const base = {
      interval: "1W" as const,
      capturedAt: new Date().toISOString(),
      traders: [],
    };
    expect(traderComparisonIsCacheable({ ...base, warnings: [] })).toBe(true);
    expect(
      traderComparisonIsCacheable({
        ...base,
        warnings: [
          {
            wallet: RN1 as `0x${string}`,
            code: "pnl_unavailable",
            message: "other warning codes do not block caching",
          },
        ],
      })
    ).toBe(true);
    expect(
      traderComparisonIsCacheable({
        ...base,
        warnings: [
          {
            wallet: RN1 as `0x${string}`,
            code: TRADER_COMPARISON_BUDGET_WARNING_CODE,
            message: "budget exceeded",
          },
        ],
      })
    ).toBe(false);
  });
});

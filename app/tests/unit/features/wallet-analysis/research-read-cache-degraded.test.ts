// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/research-read-cache-degraded`
 * Purpose: Prove the per-wallet comparison cache (fix/comparison-per-wallet-cache):
 *   - key shape is (wallet, interval) with NO label component;
 *   - labels are re-stamped at assembly, so differently-labeled requests share
 *     one cached compute;
 *   - DEGRADED_NOT_PINNED at the per-wallet layer: a budget-degraded wallet
 *     result (trader omitted + `wallet_budget_exceeded` warning) is served to
 *     the caller but never cached, so the next request recomputes instead of a
 *     degraded chart being pinned fresh for 5min / served stale for an hour;
 *   - assembly from mixed warm/cold wallets: a warm cached target answers
 *     instantly while a cold slow wallet degrades to a warning.
 * Scope: Unit — fake Db objects (hanging vs fast-empty, same shapes as
 *   `trader-comparison-budget.test.ts`); serverEnv mocked. No Postgres.
 * Invariants under test: COMPARISON_PER_WALLET_CACHE, LABELS_ARE_PRESENTATION,
 *   DEGRADED_NOT_PINNED (research-read-cache docstring),
 *   BALANCES_DEGRADED_NOT_CACHED pattern (dashboard-route-cache precedent).
 * Side-effects: module-scope TTL cache (cleared per test).
 * Links: src/features/wallet-analysis/server/research-read-cache.ts,
 *        src/features/wallet-analysis/server/coalesce.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTtlCache } from "@/features/wallet-analysis/server/coalesce";
import {
  comparisonWalletCacheKey,
  comparisonWalletIsCacheable,
  getTraderComparisonCached,
} from "@/features/wallet-analysis/server/research-read-cache";
import { TRADER_COMPARISON_BUDGET_WARNING_CODE } from "@/features/wallet-analysis/server/trader-comparison-service";

vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => ({ POLY_RESEARCH_WALLET_BUDGET_MS: 40 }),
}));

const RN1 = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const SWISSTONY = "0x204f72f35326db932158cba6adff0b9a1da95e14";
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

describe("per-wallet comparison cache key", () => {
  it("is keyed per (wallet, interval), lowercases the address, carries no label", () => {
    expect(comparisonWalletCacheKey(RN1.toUpperCase(), "1W")).toBe(
      `research:comparison-wallet:${RN1}:1W`
    );
    // Same wallet, any label context — same key. Different interval — different key.
    expect(comparisonWalletCacheKey(RN1, "1M")).toBe(
      `research:comparison-wallet:${RN1}:1M`
    );
    expect(comparisonWalletCacheKey(RN1, "1W")).not.toContain("RN1");
  });
});

describe("trader-comparison per-wallet SWR cache", () => {
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

    // Same per-wallet cache key. Were the degraded result pinned, this would
    // return it verbatim; instead the recovered backend is consulted and a
    // complete response comes back.
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

  it("complete per-wallet results stay cached (fresh hit answers without recompute)", async () => {
    const first = await getTraderComparisonCached(fastEmptyDb(), WALLETS, "1W");
    // Second call passes a hanging Db: only a per-wallet cache hit can answer
    // instantly. The response is re-assembled per request, so compare content
    // (capturedAt comes from the shared cached compute → identical).
    const second = await getTraderComparisonCached(hangingDb(), WALLETS, "1W");
    expect(second).toEqual(first);
  });

  it("labels are not in the key: a differently-labeled request hits the same cache and is re-stamped", async () => {
    const warm = await getTraderComparisonCached(fastEmptyDb(), WALLETS, "1W");
    expect(warm.traders[0]?.label).toBe("RN1");

    // hangingDb proves no recompute happened — only the cached per-wallet
    // result can answer. The requested label overrides the cached one.
    const relabeled = await getTraderComparisonCached(
      hangingDb(),
      [{ address: RN1, label: "my favorite trader" }],
      "1W"
    );
    expect(relabeled.traders).toHaveLength(1);
    expect(relabeled.traders[0]?.label).toBe("my favorite trader");

    // No label requested → falls back to the computed label (stored label or
    // short address; fastEmptyDb has no stored wallet row → short address).
    const unlabeled = await getTraderComparisonCached(
      hangingDb(),
      [{ address: RN1 }],
      "1W"
    );
    expect(unlabeled.traders[0]?.label).toBe(
      `${RN1.slice(0, 6)}...${RN1.slice(-4)}`
    );
  });

  it("assembles mixed warm/cold wallets: warm target from cache, cold slow wallet degrades", async () => {
    // Warm RN1 only.
    await getTraderComparisonCached(fastEmptyDb(), WALLETS, "1W");

    // Request RN1 + swisstony against a hanging Db: RN1 answers from cache,
    // swisstony exceeds the 40ms budget and degrades to a warning.
    const mixed = await getTraderComparisonCached(
      hangingDb(),
      [
        { address: RN1, label: "RN1" },
        { address: SWISSTONY, label: "swisstony" },
      ],
      "1W"
    );
    expect(mixed.traders.map((t) => t.address)).toEqual([RN1]);
    expect(mixed.warnings).toContainEqual(
      expect.objectContaining({
        wallet: SWISSTONY,
        code: TRADER_COMPARISON_BUDGET_WARNING_CODE,
      })
    );

    // The degraded swisstony slot was not pinned: a recovered backend fills it.
    const recovered = await getTraderComparisonCached(
      fastEmptyDb(),
      [
        { address: RN1, label: "RN1" },
        { address: SWISSTONY, label: "swisstony" },
      ],
      "1W"
    );
    expect(recovered.traders.map((t) => t.address)).toEqual([RN1, SWISSTONY]);
  });

  it("comparisonWalletIsCacheable keys off the budget warning code only", () => {
    const base = {
      address: RN1 as `0x${string}`,
      capturedAt: new Date().toISOString(),
      trader: null,
    };
    expect(comparisonWalletIsCacheable({ ...base, warnings: [] })).toBe(true);
    expect(
      comparisonWalletIsCacheable({
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
      comparisonWalletIsCacheable({
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

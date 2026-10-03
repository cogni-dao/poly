// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/trader-comparison-budget`
 * Purpose: Prove the per-wallet time budget on `getTraderComparison`
 *   (fix/research-route-caching): a wallet whose aggregate outlives the budget
 *   is omitted from `traders` and surfaced as a `wallet_budget_exceeded`
 *   warning on a contract-valid partial-failure response — the shape the route
 *   returns as a 200 instead of letting the edge 520 (~31s measured on prod
 *   2026-09-28).
 * Scope: Unit — fake Db objects (a hanging one and a fast empty one); no
 *   Postgres. The SQL itself is covered by the component parity lane.
 * Invariants under test: PER_WALLET_TIME_BUDGET (service docstring),
 *   partial-failure-returns-200-with-warnings (data-research skill §7).
 * Side-effects: none.
 * Links: src/features/wallet-analysis/server/trader-comparison-service.ts,
 *        src/app/api/v1/poly/research/trader-comparison/route.ts
 * @internal
 */

import { PolyResearchTraderComparisonResponseSchema } from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";
import {
  getTraderComparison,
  TRADER_COMPARISON_BUDGET_WARNING_CODE,
} from "@/features/wallet-analysis/server/trader-comparison-service";

const RN1 = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";

type FakeDb = Parameters<typeof getTraderComparison>[0];

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

/** A Db whose aggregate is cancelled by the matching Postgres timeout. */
function statementTimeoutDb(): FakeDb {
  let calls = 0;
  const tx = {
    execute: async () => {
      calls += 1;
      if (calls === 1) return [];
      throw Object.assign(
        new Error("canceling statement due to statement timeout"),
        { code: "57014" }
      );
    },
  };
  return {
    transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
    execute: async () => [],
  } as unknown as FakeDb;
}

describe("getTraderComparison per-wallet time budget", () => {
  it("a wallet exceeding the budget is omitted with a wallet_budget_exceeded warning (200 shape)", async () => {
    const response = await getTraderComparison(
      hangingDb(),
      [{ address: RN1, label: "RN1" }],
      "1W",
      { perWalletBudgetMs: 40 }
    );

    expect(response.traders).toHaveLength(0);
    expect(response.warnings).toHaveLength(1);
    expect(response.warnings[0]).toMatchObject({
      wallet: RN1,
      code: TRADER_COMPARISON_BUDGET_WARNING_CODE,
    });

    // The route 200s exactly this schema — a budget-degraded response must
    // stay contract-valid (partial-failure-200, never a 5xx/520).
    expect(() =>
      PolyResearchTraderComparisonResponseSchema.parse(response)
    ).not.toThrow();
  });

  it("a Postgres statement timeout follows the same partial-warning path", async () => {
    const response = await getTraderComparison(
      statementTimeoutDb(),
      [{ address: RN1, label: "RN1" }],
      "ALL",
      { perWalletBudgetMs: 5_000 }
    );

    expect(response.traders).toHaveLength(0);
    expect(response.warnings).toContainEqual(
      expect.objectContaining({
        wallet: RN1,
        code: TRADER_COMPARISON_BUDGET_WARNING_CODE,
      })
    );
    expect(() =>
      PolyResearchTraderComparisonResponseSchema.parse(response)
    ).not.toThrow();
  });

  it("a wallet inside the budget is returned and carries no budget warning", async () => {
    const response = await getTraderComparison(
      fastEmptyDb(),
      [{ address: RN1, label: "RN1" }],
      "1W",
      { perWalletBudgetMs: 5_000 }
    );

    expect(response.traders).toHaveLength(1);
    expect(response.traders[0]?.address).toBe(RN1);
    expect(
      response.warnings.some(
        (w) => w.code === TRADER_COMPARISON_BUDGET_WARNING_CODE
      )
    ).toBe(false);
    expect(() =>
      PolyResearchTraderComparisonResponseSchema.parse(response)
    ).not.toThrow();
  });

  it("a slow wallet does not block a fast one — partial results survive", async () => {
    // One shared getTraderComparison call over two wallets: the fast wallet
    // lands, the hanging wallet degrades to a warning. Each wallet now opens
    // one bounded transaction for trade aggregates and one for saved P/L.
    const fast = fastEmptyDb();
    const hang = hangingDb();
    let calls = 0;
    const mixedDb = {
      transaction: (...args: unknown[]) => {
        calls += 1;
        const target = calls <= 2 ? fast : hang;
        return (
          target as unknown as {
            transaction: (...a: unknown[]) => Promise<unknown>;
          }
        ).transaction(...args);
      },
      execute: async () => [],
    } as unknown as FakeDb;

    const other = "0x204f72f35326db932158cba6adff0b9a1da95e14";
    const response = await getTraderComparison(
      mixedDb,
      [
        { address: RN1, label: "RN1" },
        { address: other, label: "swisstony" },
      ],
      "1W",
      { perWalletBudgetMs: 60 }
    );

    expect(response.traders.map((t) => t.address)).toEqual([RN1]);
    expect(response.warnings).toContainEqual(
      expect.objectContaining({
        wallet: other,
        code: TRADER_COMPARISON_BUDGET_WARNING_CODE,
      })
    );
  });
});

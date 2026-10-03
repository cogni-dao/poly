// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `recent-trades-read-budget.test`
 * Purpose: Guard the sparse-wallet recent-trades query against a global
 *   observed-at scan and prove statement-budget failures surface as warnings.
 * Scope: Unit SQL-shape capture; no Postgres or upstream IO.
 * Invariants: WALLET_ID_INDEX_SEEK, READ_TIMEOUT_DEGRADES_TO_WARNING.
 * Side-effects: none
 * Links: src/features/wallet-analysis/server/wallet-analysis-service.ts
 * @vitest-environment node
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { RESEARCH_READ_STATEMENT_TIMEOUT_MS } from "@/features/wallet-analysis/server/fill-rollup-service";
import { getTradesSlice } from "@/features/wallet-analysis/server/wallet-analysis-service";

const WALLET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADDRESS = "0x1111111111111111111111111111111111111111";

describe("recent trades read budget", () => {
  it("seeks directly by observer wallet id without an address join", async () => {
    const captured: string[] = [];
    const tx = {
      execute: async (query: unknown) => {
        captured.push(new PgDialect().sqlToQuery(query as never).sql);
        return [];
      },
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              limit: async () => [
                {
                  walletId: WALLET_ID,
                  cursorStatus: "ok",
                  lastSuccessAt: new Date(),
                },
              ],
            }),
          }),
        }),
      }),
    };
    const db = {
      transaction: async (fn: (value: typeof tx) => Promise<unknown>) =>
        await fn(tx),
    };

    const result = await getTradesSlice(db as never, ADDRESS);

    expect(result.kind).toBe("ok");
    expect(captured[0]).toBe(
      `SET LOCAL statement_timeout = ${RESEARCH_READ_STATEMENT_TIMEOUT_MS}`
    );
    expect(captured[1]).toMatch(
      /WHERE f\.trader_wallet_id = \$\d+::uuid\s+ORDER BY f\.observed_at DESC\s+LIMIT \$\d+/
    );
    expect(captured[1]).not.toContain("poly_trader_wallets");
    expect(captured[1]).not.toContain("wallet_address");
  });

  it("returns an explicit trades warning when the statement budget expires", async () => {
    const db = {
      transaction: async () => {
        throw new Error("canceling statement due to statement timeout");
      },
    };

    const result = await getTradesSlice(db as never, ADDRESS);

    expect(result).toEqual({
      kind: "warn",
      warning: {
        slice: "trades",
        code: "upstream_failed",
        message: "canceling statement due to statement timeout",
      },
    });
  });

  it("normalizes raw Postgres timestamp strings before mapping trades", async () => {
    const observedAt = "2026-10-03T17:00:00.000Z";
    const lastSuccessAt = new Date("2026-10-03T17:01:00.000Z");
    let executeCount = 0;
    const tx = {
      execute: async () => {
        executeCount += 1;
        if (executeCount === 1) return [];
        return {
          rows: [
            {
              conditionId: "condition-1",
              tokenId: "token-1",
              side: "BUY",
              price: "0.5",
              shares: "4",
              observedAt,
              raw: null,
            },
          ],
        };
      },
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              limit: async () => [
                {
                  walletId: WALLET_ID,
                  cursorStatus: "ok",
                  lastSuccessAt,
                },
              ],
            }),
          }),
        }),
      }),
    };
    const db = {
      transaction: async (fn: (value: typeof tx) => Promise<unknown>) =>
        await fn(tx),
    };

    const result = await getTradesSlice(db as never, ADDRESS);

    expect(result).toEqual({
      kind: "ok",
      value: {
        recent: [
          {
            timestampSec: Date.parse(observedAt) / 1_000,
            side: "BUY",
            conditionId: "condition-1",
            asset: "token-1",
            size: 4,
            price: 0.5,
            marketTitle: null,
          },
        ],
        dailyCounts: expect.any(Array),
        topMarkets: [],
        computedAt: lastSuccessAt.toISOString(),
      },
    });
  });
});

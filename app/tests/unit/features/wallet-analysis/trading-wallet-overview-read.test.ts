// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `trading-wallet-overview-read.test`
 * Purpose: Prove the dashboard P/L reader distinguishes missing observation
 *   state, no persisted history, and a real zero-valued history.
 * Scope: Unit test with a fluent DB test double; no database or upstream IO.
 * Invariants: MISSING_IS_NOT_EMPTY, ZERO_IS_DATA, PAGE_LOAD_DB_ONLY.
 * Side-effects: none
 * Links: src/features/wallet-analysis/server/trading-wallet-overview-service.ts
 * @vitest-environment node
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { RESEARCH_READ_STATEMENT_TIMEOUT_MS } from "@/features/wallet-analysis/server/fill-rollup-service";
import { getPnlSlice } from "@/features/wallet-analysis/server/wallet-analysis-service";
import { getTradingWalletPnlHistoryRead } from "@/features/wallet-analysis/server/trading-wallet-overview-service";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;

function pnlReadDb(input: {
  walletRows: Array<{ id: string }>;
  pnlRows?: Array<{ ts: Date; pnlUsdc: string; observedAt: Date }>;
}) {
  let selectNumber = 0;
  const captured: string[] = [];
  const select = vi.fn(() => {
    selectNumber += 1;
    if (selectNumber === 1) {
      return {
        from: () => ({
          where: () => ({
            limit: async () => input.walletRows,
          }),
        }),
      };
    }
    return {
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => input.pnlRows ?? [] }),
        }),
      }),
    };
  });
  const tx = {
    select,
    execute: async (query: unknown) => {
      captured.push(new PgDialect().sqlToQuery(query as never).sql);
      return [];
    },
  };
  return {
    captured,
    select,
    transaction: vi.fn(
      async (fn: (value: typeof tx) => Promise<unknown>) => await fn(tx)
    ),
  };
}

describe("getTradingWalletPnlHistoryRead", () => {
  it("reports wallet_missing instead of presenting a missing observer as zero history", async () => {
    const db = pnlReadDb({ walletRows: [] });

    const result = await getTradingWalletPnlHistoryRead({
      db: db as never,
      address: ADDRESS,
      interval: "ALL",
    });

    expect(result).toEqual({ points: [], status: "wallet_missing" });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.captured).toEqual([
      `SET LOCAL statement_timeout = ${RESEARCH_READ_STATEMENT_TIMEOUT_MS}`,
    ]);
  });

  it("reports no_history without claiming observation succeeded", async () => {
    const db = pnlReadDb({ walletRows: [{ id: "wallet-1" }] });

    const result = await getTradingWalletPnlHistoryRead({
      db: db as never,
      address: ADDRESS,
      interval: "ALL",
    });

    expect(result).toEqual({ points: [], status: "no_history" });
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("treats a saved zero-valued point as available data", async () => {
    const ts = new Date("2026-10-02T12:00:00.000Z");
    const db = pnlReadDb({
      walletRows: [{ id: "wallet-1" }],
      pnlRows: [{ ts, pnlUsdc: "0", observedAt: ts }],
    });

    const result = await getTradingWalletPnlHistoryRead({
      db: db as never,
      address: ADDRESS,
      interval: "ALL",
      capturedAt: "2026-10-02T12:05:00.000Z",
    });

    expect(result).toEqual({
      points: [{ ts: ts.toISOString(), pnl: 0 }],
      status: "available",
      observedAt: ts.toISOString(),
    });
  });

  it("does not expose points whose ingestion observation is stale", async () => {
    const ts = new Date("2026-10-02T11:00:00.000Z");
    const db = pnlReadDb({
      walletRows: [{ id: "wallet-1" }],
      pnlRows: [{ ts, pnlUsdc: "4.25", observedAt: ts }],
    });

    const result = await getTradingWalletPnlHistoryRead({
      db: db as never,
      address: ADDRESS,
      interval: "ALL",
      capturedAt: "2026-10-02T12:05:00.000Z",
    });

    expect(result).toEqual({
      points: [],
      status: "stale",
      observedAt: ts.toISOString(),
    });
  });

  it("turns a P/L statement timeout into an explicit slice warning", async () => {
    const db = {
      transaction: async () => {
        throw new Error("canceling statement due to statement timeout");
      },
    };

    const result = await getPnlSlice(db as never, ADDRESS, "ALL");

    expect(result).toEqual({
      kind: "warn",
      warning: {
        slice: "pnl",
        code: "upstream_failed",
        message: "canceling statement due to statement timeout",
      },
    });
  });
});

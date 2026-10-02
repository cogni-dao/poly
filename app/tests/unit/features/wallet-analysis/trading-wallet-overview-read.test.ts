// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `trading-wallet-overview-read.test`
 * Purpose: Prove the dashboard P/L reader distinguishes missing observation
 *   state, an observed empty history, and a real zero-valued history.
 * Scope: Unit test with a fluent DB test double; no database or upstream IO.
 * Invariants: MISSING_IS_NOT_EMPTY, ZERO_IS_DATA, PAGE_LOAD_DB_ONLY.
 * Side-effects: none
 * Links: src/features/wallet-analysis/server/trading-wallet-overview-service.ts
 * @vitest-environment node
 */

import { describe, expect, it, vi } from "vitest";
import { getTradingWalletPnlHistoryRead } from "@/features/wallet-analysis/server/trading-wallet-overview-service";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;

function pnlReadDb(input: {
  walletRows: Array<{ id: string }>;
  pnlRows?: Array<{ ts: Date; pnlUsdc: string }>;
}) {
  let selectNumber = 0;
  return {
    select: vi.fn(() => {
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
            orderBy: async () => input.pnlRows ?? [],
          }),
        }),
      };
    }),
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
  });

  it("reports empty only after the wallet observer row is known", async () => {
    const db = pnlReadDb({ walletRows: [{ id: "wallet-1" }] });

    const result = await getTradingWalletPnlHistoryRead({
      db: db as never,
      address: ADDRESS,
      interval: "ALL",
    });

    expect(result).toEqual({ points: [], status: "empty" });
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("treats a saved zero-valued point as available data", async () => {
    const ts = new Date("2026-10-02T12:00:00.000Z");
    const db = pnlReadDb({
      walletRows: [{ id: "wallet-1" }],
      pnlRows: [{ ts, pnlUsdc: "0" }],
    });

    const result = await getTradingWalletPnlHistoryRead({
      db: db as never,
      address: ADDRESS,
      interval: "ALL",
    });

    expect(result).toEqual({
      points: [{ ts: ts.toISOString(), pnl: 0 }],
      status: "available",
    });
  });
});

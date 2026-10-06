// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Identity-safe realized winner overlay for dashboard closed positions. */
import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  applyRealizedPnl,
  readWalletTokenPnlMap,
} from "@/features/wallet-analysis/server/realized-pnl-service";

const WALLET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WALLET_SIBLING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WALLET = `0x${"ab".repeat(20)}`;

function fakeDb(rowCondition: string, walletIds = [WALLET_ID]) {
  const sql: string[] = [];
  let call = 0;
  return {
    sql,
    execute: async (query: unknown) => {
      sql.push(new PgDialect().sqlToQuery(query as never).sql);
      call += 1;
      if (call === 1) return walletIds.map((id) => ({ id }));
      return [
        {
          condition_id: rowCondition,
          token_id: "winner-token",
          total_buy_notional: "1",
          realized_cash: "0",
          net_shares: "2",
          current_value_usdc: "0",
          market_outcome: "winner",
        },
      ];
    },
  };
}

describe("realized P/L identity reconciliation", () => {
  it.each([
    ["saved-upper", "COND-A", "cond-a"],
    ["request-upper", "cond-b", "COND-B"],
  ])("applies a resolved winner across the %s casing schedule", async (_name, saved, requested) => {
    const db = fakeDb(saved.toLowerCase());
    const realized = await readWalletTokenPnlMap({
      db,
      walletAddress: WALLET.toUpperCase(),
      positionKeys: [{ conditionId: requested, tokenId: "winner-token" }],
    });
    const positions = [
      {
        conditionId: requested,
        asset: "winner-token",
        pnlUsd: -1,
        pnlPct: -100,
      } as WalletExecutionPosition,
    ];

    expect(applyRealizedPnl(positions, realized)[0]).toMatchObject({
      pnlUsd: 1,
      pnlPct: 100,
    });
    expect(db.sql[1]).toContain("p.trader_wallet_id IN ($1::uuid)");
    expect(db.sql[1]).toContain("lower(candidate.condition_id) = fa.condition_id");
    expect(db.sql[1]).toContain("fa.condition_id = lower(");
  });

  it("aggregates fills and dedupes marks across every canonical wallet sibling", async () => {
    const db = fakeDb("cond-a", [WALLET_ID, WALLET_SIBLING_ID]);

    await readWalletTokenPnlMap({
      db,
      walletAddress: WALLET.toUpperCase(),
      positionKeys: [{ conditionId: "COND-A", tokenId: "winner-token" }],
    });

    expect(db.sql[0]).not.toContain("LIMIT 1");
    expect(db.sql[0]).not.toContain("w.kind = 'cogni_wallet'");
    expect(db.sql[1]).toContain("p.trader_wallet_id IN ($1::uuid, $2::uuid)");
    expect(db.sql[1]).toContain(
      "PARTITION BY lower(p.condition_id), p.token_id"
    );
    expect(db.sql[1].indexOf("row_number() OVER")).toBeLessThan(
      db.sql[1].indexOf("p.active = true")
    );
  });
});

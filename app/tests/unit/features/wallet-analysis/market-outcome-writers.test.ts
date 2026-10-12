// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Canonical condition identity and monotone terminal-outcome writer proofs. */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { DrizzleMarketOutcomesAdapter } from "@/adapters/server/redeem/drizzle-market-outcomes.adapter";
import { runMarketOutcomeTick } from "@/features/wallet-analysis/server/market-outcome-service";

type WriteCapture = {
  values: Array<Record<string, unknown>>;
  set: Record<string, unknown>;
};

function captureWriteDb(executeRows: unknown[] = []) {
  const capture: WriteCapture = { values: [], set: {} };
  const db = {
    execute: async () => executeRows,
    insert: () => ({
      values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => ({
        onConflictDoUpdate: async (input: { set: Record<string, unknown> }) => {
          capture.values = Array.isArray(values) ? values : [values];
          capture.set = input.set;
        },
      }),
    }),
  };
  return { db, capture };
}

function rendered(fragment: unknown): string {
  return new PgDialect().sqlToQuery(fragment as never).sql;
}

const logger = {
  child: () => logger,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("market outcome writers", () => {
  it("CLOB writer lowercases identity, timestamps terminal facts, and cannot regress them", async () => {
    const { db, capture } = captureWriteDb([
      { condition_id: "0xABCDEF", token_id: "101" },
    ]);

    await runMarketOutcomeTick({
      db: db as never,
      clobClient: {
        getMarketResolution: async () => ({
          closed: true,
          tokens: [{ token_id: "101", winner: true }],
        }),
      },
      logger: logger as never,
      metrics: {} as never,
    });

    expect(capture.values[0]).toMatchObject({
      conditionId: "0xabcdef",
      tokenId: "101",
      outcome: "winner",
    });
    expect(capture.values[0]?.resolvedAt).toBeInstanceOf(Date);
    expect(rendered(capture.set.outcome)).toContain("IN ('winner', 'loser')");
    expect(rendered(capture.set.resolvedAt)).toContain("COALESCE");
    expect(rendered(capture.set.resolvedAt)).toContain("<> EXCLUDED.outcome");
    expect(rendered(capture.set.payout)).toContain("<> EXCLUDED.outcome");
  });

  it("chain writer lowercases identity, supplies missing resolution time, and preserves terminal consensus", async () => {
    const { db, capture } = captureWriteDb();
    const adapter = new DrizzleMarketOutcomesAdapter(db as never);

    await adapter.upsert({
      conditionId: "0xABCDEF",
      tokenId: "202",
      outcome: "loser",
      payout: "0",
      resolvedAt: null,
      raw: { source: "chain" },
    });

    expect(capture.values[0]).toMatchObject({
      conditionId: "0xabcdef",
      tokenId: "202",
      outcome: "loser",
    });
    expect(capture.values[0]?.resolvedAt).toBeInstanceOf(Date);
    expect(rendered(capture.set.outcome)).toContain("IN ('winner', 'loser')");
    expect(rendered(capture.set.payout)).toContain("EXCLUDED.outcome");
    expect(rendered(capture.set.resolvedAt)).toContain("<> EXCLUDED.outcome");
    expect(rendered(capture.set.raw)).toContain("poly_market_outcomes");
  });
});

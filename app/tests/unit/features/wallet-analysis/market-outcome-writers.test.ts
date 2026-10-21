// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Canonical condition identity and monotone terminal-outcome writer proofs. */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { DrizzleMarketOutcomesAdapter } from "@/adapters/server/redeem/drizzle-market-outcomes.adapter";
import { runMarketOutcomeTick } from "@/features/wallet-analysis/server/market-outcome-service";

type WriteCapture = {
  values: Array<Record<string, unknown>>;
  set: Record<string, unknown>;
};

function captureWriteDb(executeRows: unknown[] = []) {
  const capture: WriteCapture = { values: [], set: {} };
  const queries: unknown[] = [];
  const db = {
    execute: async (query: unknown) => {
      queries.push(query);
      return executeRows;
    },
    insert: () => ({
      values: (
        values: Record<string, unknown> | Array<Record<string, unknown>>
      ) => ({
        onConflictDoUpdate: async (input: { set: Record<string, unknown> }) => {
          capture.values = Array.isArray(values) ? values : [values];
          capture.set = input.set;
        },
      }),
    }),
  };
  return { db, capture, queries };
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
  it.each([
    [100_000, 100],
    [Number.POSITIVE_INFINITY, 100],
    [Number.NaN, 100],
    [-10, 1],
    [2.9, 2],
  ])(
    "caps the work queue for requested batch %s at %s",
    async (batchSize, expectedLimit) => {
      const { db, queries } = captureWriteDb();
      const getMarketResolution = vi.fn(async () => null);
      await runMarketOutcomeTick({
        db: db as never,
        clobClient: { getMarketResolution },
        logger: logger as never,
        metrics: {} as never,
        batchSize,
      });
      const query = new PgDialect().sqlToQuery(queries[0] as never);
      expect(query.params.at(-1)).toBe(expectedLimit);
      expect(getMarketResolution).not.toHaveBeenCalled();
    }
  );

  it("deduplicates token siblings into one market read and never exceeds four concurrent reads", async () => {
    const { db, capture } = captureWriteDb(
      Array.from({ length: 20 }, (_, index) => ({
        condition_id: `condition-${Math.floor(index / 2)}`,
        token_id: String(index),
        account_holding: true,
      }))
    );
    let active = 0;
    let maximum = 0;
    const getMarketResolution = vi.fn(async (condition: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      const firstToken = Number(condition.slice("condition-".length)) * 2;
      return {
        closed: true,
        tokens: [
          { token_id: String(firstToken), winner: true },
          { token_id: String(firstToken + 1), winner: false },
        ],
      };
    });

    const result = await runMarketOutcomeTick({
      db: db as never,
      clobClient: { getMarketResolution },
      logger: logger as never,
      metrics: {} as never,
    });

    expect(getMarketResolution).toHaveBeenCalledTimes(10);
    expect(maximum).toBe(4);
    expect(result).toMatchObject({ conditions: 20, polled: 10, upserted: 20 });
    expect(
      capture.values.filter((row) => row.outcome === "winner")
    ).toHaveLength(10);
    expect(
      capture.values.filter((row) => row.outcome === "loser")
    ).toHaveLength(10);
  });

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

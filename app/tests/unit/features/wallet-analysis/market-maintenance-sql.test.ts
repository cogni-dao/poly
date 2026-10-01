// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/market-maintenance-sql`
 * Purpose: Prevent the two production DB-amplification regressions fixed by
 *   bug.5293: market-outcome discovery must not scan raw fills, and unchanged
 *   market metadata must not be rewritten on every observation tick.
 * Scope: Unit — fake `db.execute` captures rendered SQL; no Postgres or HTTP.
 * Side-effects: none
 * Links: src/features/wallet-analysis/server/market-outcome-service.ts,
 *        src/features/wallet-analysis/server/poly-market-metadata-service.ts
 * @internal
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  accumulateFillRollups,
  RESEARCH_READ_STATEMENT_TIMEOUT_MS,
  withResearchReadTimeout,
} from "@/features/wallet-analysis/server/fill-rollup-service";
import { runMarketOutcomeTick } from "@/features/wallet-analysis/server/market-outcome-service";
import { refreshMarketMetadata } from "@/features/wallet-analysis/server/poly-market-metadata-service";

function captureDb(
  rows: unknown[],
  shape: "array" | "query-result" = "query-result"
) {
  const captured: string[] = [];
  return {
    captured,
    execute: async (query: unknown) => {
      captured.push(new PgDialect().sqlToQuery(query as never).sql);
      return shape === "array" ? rows : { rows };
    },
  };
}

const logger = {
  child: () => logger,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("market outcome condition discovery", () => {
  it("uses daily rollups and never scans raw fills in normal mode", async () => {
    const db = captureDb([], "array");

    await runMarketOutcomeTick({
      db: db as never,
      clobClient: { getMarketResolution: async () => null },
      logger: logger as never,
      metrics: {} as never,
    });

    const query = db.captured[0] ?? "";
    expect(query).toContain("FROM poly_trader_fill_rollups_daily");
    expect(query).toContain(
      "WHERE last_observed_at > now() - INTERVAL '30 days'"
    );
    expect(query).not.toContain("FROM poly_trader_fills");
  });

  it("uses the full rollup history, not raw fills, during boot backfill", async () => {
    const db = captureDb([], "array");

    await runMarketOutcomeTick({
      db: db as never,
      clobClient: { getMarketResolution: async () => null },
      logger: logger as never,
      metrics: {} as never,
      includeBackfill: true,
    });

    const query = db.captured[0] ?? "";
    expect(query).toContain("FROM poly_trader_fill_rollups_daily");
    expect(query).not.toContain("last_observed_at > now()");
    expect(query).not.toContain("FROM poly_trader_fills");
  });
});

describe("market metadata refresh", () => {
  it("reports candidates separately and writes only changed typed metadata", async () => {
    const db = captureDb([{ scanned: "14018", written: "0" }]);

    const result = await refreshMarketMetadata({
      db: db as never,
      logger,
    });

    expect(result).toEqual({ scanned: 14018, written: 0 });
    const query = db.captured[0] ?? "";
    expect(query).toContain("WITH candidates AS MATERIALIZED");
    expect(query).toContain("IS DISTINCT FROM ROW");
    expect(query).toContain("poly_market_metadata.market_title");
    expect(query).not.toMatch(
      /poly_market_metadata\.raw[\s\S]*IS DISTINCT FROM ROW/
    );
  });
});

describe("fill-rollup accumulator", () => {
  it("seeks above the cursor through a lateral index condition", async () => {
    const db = captureDb([]);

    await accumulateFillRollups(db as never, {
      traderWalletId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    const batchQuery = db.captured[1] ?? "";
    expect(batchQuery).toContain("CROSS JOIN LATERAL");
    expect(batchQuery).toMatch(
      /WHERE f\.trader_wallet_id = \$\d+::uuid\s+AND \(f\.created_at, f\.id\) > \(cur\.last_created_at, cur\.last_fill_id\)/
    );
    expect(batchQuery).not.toMatch(/FROM poly_trader_fills f, cur/);
  });
});

describe("research read load bound", () => {
  it("sets a transaction-local statement timeout before request-path reads", async () => {
    const captured: string[] = [];
    const tx = {
      execute: async (query: unknown) => {
        captured.push(new PgDialect().sqlToQuery(query as never).sql);
        return [];
      },
    };
    const db = {
      transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
    };

    const result = await withResearchReadTimeout(
      db as never,
      async () => "bounded"
    );

    expect(result).toBe("bounded");
    expect(captured).toEqual([
      `SET LOCAL statement_timeout = ${RESEARCH_READ_STATEMENT_TIMEOUT_MS}`,
    ]);
  });
});

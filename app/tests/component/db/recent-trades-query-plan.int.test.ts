// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/recent-trades-query-plan.int.test`
 * Purpose: Prove the production recent-trades query remains an index-bounded
 *   sparse-wallet read under a materially skewed global fill corpus.
 * Scope: Real Postgres plan proof in the standard component testcontainer.
 * Invariants:
 *   - EXACT_QUERY: EXPLAIN wraps the same SQL object production executes.
 *   - COMPOSITE_INDEX_SEEK: the plan uses
 *     `poly_trader_fills_trader_observed_idx` for the sparse wallet.
 *   - NO_GLOBAL_SCAN_OR_SORT: no fills Seq Scan or Sort can hide behind LIMIT.
 *   - BOUNDED_EXECUTION: analyzed execution stays below a CI-safe ceiling.
 * Side-effects: IO (database seed, ANALYZE, EXPLAIN, cleanup via testcontainer)
 * Links: src/features/wallet-analysis/server/wallet-analysis-service.ts
 * @public
 */

import { polyTraderWallets } from "@cogni/poly-db-schema/trader-activity";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAppDb } from "@/adapters/server/db/client";
import { recentTradesSelect } from "@/features/wallet-analysis/server/wallet-analysis-service";

const TARGET_ADDR = `0x${"d1".repeat(20)}`;
const BACKGROUND_ADDR = `0x${"e2".repeat(20)}`;
const BACKGROUND_FILL_COUNT = 30_000;
const TARGET_FILL_COUNT = 83;
const PLAN_EXECUTION_BUDGET_MS = 500;

type ExplainNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Scan Direction"?: string;
  "Actual Rows"?: number;
  Plans?: ExplainNode[];
};

type ExplainDocument = {
  Plan: ExplainNode;
  "Execution Time": number;
};

function flattenPlan(node: ExplainNode): ExplainNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

function readExplainDocument(result: unknown): ExplainDocument {
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] }).rows ?? []);
  const raw = (rows[0] as Record<string, unknown> | undefined)?.["QUERY PLAN"];
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Expected one JSON EXPLAIN document");
  }
  return parsed[0] as ExplainDocument;
}

describe("recent trades sparse-wallet query plan", () => {
  const ownerDb = getAppDb();
  const seedDb = getSeedDb();
  let targetWalletId = "";
  let backgroundWalletId = "";

  beforeAll(async () => {
    const wallets = await seedDb
      .insert(polyTraderWallets)
      .values([
        {
          walletAddress: TARGET_ADDR,
          kind: "cogni_wallet",
          label: "plan-target",
        },
        {
          walletAddress: BACKGROUND_ADDR,
          kind: "copy_target",
          label: "plan-background",
        },
      ])
      .returning({
        id: polyTraderWallets.id,
        walletAddress: polyTraderWallets.walletAddress,
      });
    const ids = new Map(wallets.map((wallet) => [wallet.walletAddress, wallet.id]));
    targetWalletId = ids.get(TARGET_ADDR) as string;
    backgroundWalletId = ids.get(BACKGROUND_ADDR) as string;

    // One set-based statement creates a corpus where a global observed_at walk
    // would inspect every newer background row before reaching the sparse
    // target, which has fewer rows than the production LIMIT 500.
    await seedDb.execute(sql`
      INSERT INTO poly_trader_fills (
        trader_wallet_id,
        source,
        native_id,
        condition_id,
        token_id,
        side,
        price,
        shares,
        size_usdc,
        observed_at
      )
      SELECT
        ${backgroundWalletId}::uuid,
        'data-api',
        'plan-background-' || n,
        'plan-condition-' || (n % 200),
        'plan-token-' || (n % 400),
        'BUY',
        0.5,
        1,
        0.5,
        TIMESTAMPTZ '2026-10-01 00:00:00+00' + n * INTERVAL '1 second'
      FROM generate_series(1, ${BACKGROUND_FILL_COUNT}) AS n
      UNION ALL
      SELECT
        ${targetWalletId}::uuid,
        'data-api',
        'plan-target-' || n,
        'target-condition-' || (n % 20),
        'target-token-' || (n % 40),
        'BUY',
        0.5,
        1,
        0.5,
        TIMESTAMPTZ '2025-01-01 00:00:00+00' + n * INTERVAL '1 second'
      FROM generate_series(1, ${TARGET_FILL_COUNT}) AS n
    `);

    // app_user owns migrated tables; ANALYZE must use the owner connection so
    // the skew is reflected in planner statistics rather than silently skipped.
    await ownerDb.execute(sql`ANALYZE poly_trader_fills`);
  }, 30_000);

  afterAll(async () => {
    await seedDb
      .delete(polyTraderWallets)
      .where(inArray(polyTraderWallets.walletAddress, [TARGET_ADDR, BACKGROUND_ADDR]));
  }, 30_000);

  it("uses the wallet+observed index without a global fills scan or sort", async () => {
    // Product reads use app_service through the isolated service-read pool, so
    // EXPLAIN under the same role after the owner has refreshed statistics.
    const explained = await seedDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = 2000`);
      return await tx.execute(sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        ${recentTradesSelect(targetWalletId)}
      `);
    });
    const document = readExplainDocument(explained);
    const nodes = flattenPlan(document.Plan);

    const compositeIndexScan = nodes.find(
      (node) =>
        node["Index Name"] === "poly_trader_fills_trader_observed_idx"
    );
    expect(compositeIndexScan).toBeDefined();
    expect(compositeIndexScan?.["Node Type"]).toBe("Index Scan");
    expect(compositeIndexScan?.["Scan Direction"]).toBe("Backward");
    expect(document.Plan["Actual Rows"]).toBe(TARGET_FILL_COUNT);

    expect(
      nodes.some(
        (node) =>
          node["Node Type"] === "Seq Scan" &&
          node["Relation Name"] === "poly_trader_fills"
      )
    ).toBe(false);
    expect(nodes.some((node) => node["Node Type"] === "Sort")).toBe(false);
    expect(document["Execution Time"]).toBeLessThan(
      PLAN_EXECUTION_BUDGET_MS
    );
  });
});

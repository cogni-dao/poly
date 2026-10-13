// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/economic-position-reliability`
 * Purpose: Pin the bounded projection shape and typed degradation telemetry
 *   introduced for bug.5036.
 * Scope: Unit — rendered SQL and pure error classification only; no DB.
 * Side-effects: none
 * Links: bug.5036, story.5022
 * @internal
 */

import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { portfolioSnapshotExtra } from "@/features/capability-plane/portfolio-snapshot";
import {
  type EconomicPositionReadDiagnostics,
  readEconomicPositionProjection,
} from "@/features/wallet-analysis/server/economic-position-read-model";
import { classifyDatabaseReadFailure } from "@/features/wallet-analysis/server/market-exposure-service";
import {
  recordEconomicProjectionPlanAfterTimeout,
  summarizeEconomicProjectionPlan,
} from "@/features/wallet-analysis/server/tenant-wallet-dashboard-service";
import { portfolioSnapshotFixture } from "../capability-plane/portfolio-snapshot.fixture";

describe("economic-position projection reliability", () => {
  it("anchors position-keyed fills before indexed sibling consensus", async () => {
    const captured: string[] = [];
    const diagnostics: EconomicPositionReadDiagnostics = {};
    const db = {
      execute: async (query: unknown) => {
        captured.push(new PgDialect().sqlToQuery(query as never).sql);
        if (captured.length === 1) {
          return [
            { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
            { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
          ];
        }
        return [];
      },
    };

    await readEconomicPositionProjection({
      db,
      billingAccountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      connectionKind: "privy_live",
      capturedAt: new Date("2026-10-12T12:00:00.000Z"),
      interval: "ALL",
      diagnostics,
    });

    const query = captured.at(-1) ?? "";
    expect(diagnostics.economicWalletIdentityCount).toBe(2);
    expect(query).toContain("ledger_candidate_refs AS MATERIALIZED");
    expect(query).toContain("SELECT DISTINCT ON (");
    expect(query).toContain("f.target_id");
    expect(query).toContain("f.fill_id");
    expect(query).toContain("FROM ledger_candidate_refs r");
    expect(query).toContain("AND f.target_id = r.target_id");
    expect(query).toContain("AND f.fill_id = r.fill_id");
    expect(query).not.toContain("ledger_source AS");
    expect(query).toContain(
      "SELECT condition_id, token_id FROM ledger_candidates"
    );
    expect(query).not.toContain("SELECT * FROM ledger_candidates");
    expect(query).not.toContain("metadata_rank");
    expect(query).not.toContain("origin_keys AS MATERIALIZED");
    expect(query).toContain("fill_identity_anchors AS MATERIALIZED");
    expect(query).toContain("fill_candidates AS MATERIALIZED");
    expect(query.match(/FROM poly_trader_fills f/g)).toHaveLength(1);
    expect(query.match(/JOIN poly_trader_fills f/g)).toHaveLength(1);
    expect(query).toContain("ON f.trader_wallet_id = w.id");
    expect(query).toContain("AND f.source = identity.source");
    expect(query).toContain("AND f.native_id = identity.native_id");
    expect(query).toContain("FROM fill_candidates f");
    expect(query).toContain("JOIN fill_candidates f ON f.id = g.chosen_id");
    expect(query).not.toContain("driven_fill_identities");
    expect(query).toContain("raw_position_flows AS MATERIALIZED");
  });

  it("uses exact rollup plus cutoff-day and unrolled-tail fills for one wallet identity", async () => {
    const captured: string[] = [];
    const diagnostics: EconomicPositionReadDiagnostics = {};
    const db = {
      execute: async (query: unknown) => {
        captured.push(new PgDialect().sqlToQuery(query as never).sql);
        return captured.length === 1
          ? [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]
          : [];
      },
    };

    await readEconomicPositionProjection({
      db,
      billingAccountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      connectionKind: "paper",
      capturedAt: new Date("2026-10-12T12:00:00.000Z"),
      interval: "ALL",
      diagnostics,
    });

    const query = captured.at(-1) ?? "";
    expect(diagnostics.economicWalletIdentityCount).toBe(1);
    expect(query).toContain("single_position_flows AS MATERIALIZED");
    expect(query).toContain("poly_trader_fill_rollups_daily");
    expect(query).toContain("poly_trader_fill_rollup_cursors");
    expect(query).toContain("effective_rollup_cursor AS MATERIALIZED");
    expect(query).toContain("single_wallet_unrolled_tail AS MATERIALIZED");
    const normalizedQuery = query.replace(/\s+/g, " ").trim();
    const drivenKeysAt = normalizedQuery.indexOf("CROSS JOIN driven_keys k");
    const lateralAt = normalizedQuery.indexOf("CROSS JOIN LATERAL");
    const canonicalKeyAt = normalizedQuery.indexOf(
      "lower(keyed.condition_id) = k.condition_id",
      lateralAt
    );
    const tokenKeyAt = normalizedQuery.indexOf(
      "keyed.token_id = k.token_id",
      canonicalKeyAt
    );
    const cutoffDayAt = normalizedQuery.indexOf(
      "keyed.observed_at < date_trunc(",
      tokenKeyAt
    );
    const capturedAtCutoffAt = normalizedQuery.indexOf(
      "keyed.observed_at <=",
      cutoffDayAt
    );
    const pullupFenceAt = normalizedQuery.indexOf("OFFSET 0", capturedAtCutoffAt);
    const lateralFence = normalizedQuery.slice(lateralAt, pullupFenceAt);
    const cursorAt = normalizedQuery.indexOf(
      "(f.created_at, f.id) > (cursor.last_created_at, cursor.last_fill_id)",
      pullupFenceAt
    );
    expect(drivenKeysAt).toBeGreaterThan(-1);
    expect(lateralAt).toBeGreaterThan(drivenKeysAt);
    expect(canonicalKeyAt).toBeGreaterThan(lateralAt);
    expect(tokenKeyAt).toBeGreaterThan(canonicalKeyAt);
    expect(cutoffDayAt).toBeGreaterThan(tokenKeyAt);
    expect(capturedAtCutoffAt).toBeGreaterThan(cutoffDayAt);
    expect(pullupFenceAt).toBeGreaterThan(capturedAtCutoffAt);
    expect(cursorAt).toBeGreaterThan(pullupFenceAt);
    expect(lateralFence).not.toContain("ORDER BY");
    expect(query).toContain("FROM single_wallet_unrolled_tail f");
    expect(query).not.toContain("fill_identity_anchors AS MATERIALIZED");
    expect(query).toContain("AT TIME ZONE 'UTC'");
    expect(query).toContain("f.observed_at <=");
    expect(query).toContain("ORDER BY f.observed_at DESC, f.id");
  });

  it("classifies a nested Postgres statement timeout without logging raw error text", () => {
    expect(
      classifyDatabaseReadFailure({
        code: "DRIZZLE_QUERY_FAILED",
        message: "query failed",
        cause: { code: "57014", detail: "sensitive database detail" },
      })
    ).toBe("statement_timeout");
    expect(classifyDatabaseReadFailure({ code: "40001" })).toBe(
      "database_error"
    );
    expect(classifyDatabaseReadFailure(new Error("boom"))).toBe(
      "unexpected_error"
    );
  });

  it("reduces EXPLAIN JSON to bounded planner evidence", () => {
    const summary = summarizeEconomicProjectionPlan([
      {
        "QUERY PLAN": [
          {
            Plan: {
              "Node Type": "Nested Loop",
              "Total Cost": 9001.25,
              "Plan Rows": 30,
              Plans: [
                {
                  "Node Type": "Index Scan",
                  "Subplan Name": "CTE single_wallet_unrolled_tail",
                  "Relation Name": "poly_trader_fills",
                  "Index Name":
                    "poly_trader_fills_wallet_condition_token_observed_lower_idx",
                  "Total Cost": 8000.5,
                  "Plan Rows": 1776,
                },
              ],
            },
          },
        ],
      },
    ]);

    expect(summary).toEqual({
      estimatedTotalCost: 9001.25,
      estimatedRows: 30,
      nodes: [
        "Nested Loop est_cost=9001.25 est_rows=30",
        "Index Scan subplan=CTE single_wallet_unrolled_tail rel=poly_trader_fills idx=poly_trader_fills_wallet_condition_token_observed_lower_idx est_cost=8000.5 est_rows=1776",
      ],
    });
  });

  it("explains a timed-out statement under a restored bounded timeout", async () => {
    const executed: string[] = [];
    const diagnostics = {};
    const plan = [
      {
        "QUERY PLAN": [
          {
            Plan: {
              "Node Type": "Seq Scan",
              "Relation Name": "poly_copy_trade_fills",
              "Total Cost": 42,
              "Plan Rows": 7,
            },
          },
        ],
      },
    ];
    const savepoint = {
      execute: async (query: unknown) => {
        const rendered = new PgDialect().sqlToQuery(query as never).sql;
        executed.push(rendered);
        return rendered.includes("EXPLAIN") ? plan : [];
      },
    };
    const db = {
      transaction: async (read: (tx: typeof savepoint) => Promise<unknown>) =>
        read(savepoint),
    };

    await recordEconomicProjectionPlanAfterTimeout({
      db: db as never,
      statement: sql`SELECT 1`,
      statementKind: "projection",
      diagnostics,
    });

    expect(executed).toHaveLength(3);
    expect(executed[0]).toContain("SET LOCAL statement_timeout = 1000");
    expect(executed[1]).toContain("EXPLAIN (FORMAT JSON) SELECT 1");
    expect(executed[2]).toContain("SET LOCAL statement_timeout = 8000");
    expect(diagnostics).toMatchObject({
      economicProjectionPlanStatement: "projection",
      economicProjectionPlanEstimatedTotalCost: 42,
      economicProjectionPlanEstimatedRows: 7,
      economicProjectionPlanNodes: [
        "Seq Scan rel=poly_copy_trade_fills est_cost=42 est_rows=7",
      ],
    });
  });

  it("keeps a failed timeout EXPLAIN fail-open", async () => {
    const diagnostics = {};
    const savepoint = {
      execute: async (query: unknown) => {
        const rendered = new PgDialect().sqlToQuery(query as never).sql;
        if (rendered.includes("EXPLAIN")) throw new Error("plan unavailable");
        return [];
      },
    };
    const db = {
      transaction: async (read: (tx: typeof savepoint) => Promise<unknown>) =>
        read(savepoint),
    };

    await expect(
      recordEconomicProjectionPlanAfterTimeout({
        db: db as never,
        statement: sql`SELECT 1`,
        statementKind: "projection",
        diagnostics,
      })
    ).resolves.toBeUndefined();
    expect(diagnostics).toMatchObject({
      economicProjectionPlanStatement: "projection",
      economicProjectionPlanFailureClass: "unexpected_error",
    });
  });

  it("emits bounded economic timing and the typed failure class on the terminal event", () => {
    const extra = portfolioSnapshotExtra(
      { status: "ok", data: portfolioSnapshotFixture() },
      "sha-test",
      {
        economicProjectionMs: 7_999,
        economicWalletIdentityMs: 2,
        economicWalletIdentityCount: 1,
        economicProjectionQueryMs: 7_997,
        economicProjectionFailureClass: "statement_timeout",
        economicProjectionPlanMs: 9,
        economicProjectionPlanStatement: "projection",
        economicProjectionPlanEstimatedTotalCost: 9001.25,
        economicProjectionPlanEstimatedRows: 30,
        economicProjectionPlanNodes: [
          "Nested Loop est_cost=9001.25 est_rows=30",
        ],
      }
    );

    expect(extra).toMatchObject({
      economicProjectionMs: 7_999,
      economicWalletIdentityMs: 2,
      economicWalletIdentityCount: 1,
      economicProjectionQueryMs: 7_997,
      economicProjectionFailureClass: "statement_timeout",
      economicProjectionPlanMs: 9,
      economicProjectionPlanStatement: "projection",
      economicProjectionPlanEstimatedTotalCost: 9001.25,
      economicProjectionPlanEstimatedRows: 30,
      economicProjectionPlanNodes: [
        "Nested Loop est_cost=9001.25 est_rows=30",
      ],
    });
    expect(JSON.stringify(extra)).not.toContain("sensitive database detail");
  });
});

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

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { portfolioSnapshotExtra } from "@/features/capability-plane/portfolio-snapshot";
import { readEconomicPositionProjection } from "@/features/wallet-analysis/server/economic-position-read-model";
import { classifyDatabaseReadFailure } from "@/features/wallet-analysis/server/market-exposure-service";
import { portfolioSnapshotFixture } from "../capability-plane/portfolio-snapshot.fixture";

describe("economic-position projection reliability", () => {
  it("anchors position-keyed fills before indexed sibling consensus", async () => {
    const captured: string[] = [];
    const db = {
      execute: async (query: unknown) => {
        captured.push(new PgDialect().sqlToQuery(query as never).sql);
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
    });

    const query = captured[0] ?? "";
    expect(query).toContain("SELECT DISTINCT ON (condition_id, token_id)");
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

  it("emits bounded economic timing and the typed failure class on the terminal event", () => {
    const extra = portfolioSnapshotExtra(
      { status: "ok", data: portfolioSnapshotFixture() },
      "sha-test",
      {
        economicProjectionMs: 7_999,
        economicProjectionFailureClass: "statement_timeout",
      }
    );

    expect(extra).toMatchObject({
      economicProjectionMs: 7_999,
      economicProjectionFailureClass: "statement_timeout",
    });
    expect(JSON.stringify(extra)).not.toContain("sensitive database detail");
  });
});

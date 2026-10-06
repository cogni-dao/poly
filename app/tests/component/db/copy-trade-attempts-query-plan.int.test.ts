// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/copy-trade-attempts-query-plan.int.test`
 * Purpose: Prove the account-wide attempt tape is an index-bounded keyset read
 *   rather than a full-account sort, under a decisions corpus skewed so that a
 *   global `decided_at` walk would be the wrong plan.
 * Scope: Real Postgres plan proof in the standard component testcontainer.
 * Invariants:
 *   - EXACT_QUERY — EXPLAIN wraps the very SQL object production executes, via
 *     the `copyTradeAttemptsSelect` export that exists for this purpose.
 *   - PRODUCTION_ROLE_AND_RLS — EXPLAIN runs under the app role inside
 *     `withTenantScope`, so the plan includes the same RLS policy subqueries
 *     production pays for. Explaining as the BYPASSRLS service role would
 *     measure a query the capability never runs.
 *   - TAPE_INDEX_IS_USED — the plan seeks
 *     `poly_copy_trade_decisions_account_tape_idx`, the index migration 0076
 *     adds. This test is that migration's justification: without it the
 *     closest candidate index leads with `market_id`, which cannot serve an
 *     account-wide read as a prefix.
 *   - NO_ACCOUNT_SCAN — no `Seq Scan` on `poly_copy_trade_decisions` can hide
 *     behind the LIMIT.
 *   - KEYSET_PAGES_TOO — the cursor-bearing page uses the same index, proving
 *     the row-value predicate `(decided_at, id) < (…)` is an index condition
 *     rather than a filter applied after scanning the account.
 *   - BOUNDED_ROWS — the plan returns at most `limit + 1` rows regardless of
 *     how many decisions the account has accumulated.
 *   - NO_FULL_ACCOUNT_SORT — no `Sort` node materialises more than
 *     `LARGE_SORT_ROWS` rows; see that constant for why this is asserted as a
 *     bound rather than as the absence of every `Sort`.
 * Side-effects: IO (database seed, ANALYZE, EXPLAIN, cascade cleanup)
 * Links: task.1791070959, migration 0076,
 *   app/tests/component/db/recent-trades-query-plan.int.test.ts (precedent)
 * @internal
 */

import { randomUUID } from "node:crypto";
import { toUserId, userActor } from "@cogni/ids";
import type { PolyAccountRecentAttemptsQuery } from "@cogni/poly-node-contracts";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { copyTradeAttemptsSelect } from "@/features/wallet-analysis/server/copy-trade-attempts-read";
import { billingAccounts, users } from "@/shared/db/schema";

const TAPE_INDEX = "poly_copy_trade_decisions_account_tape_idx";
/**
 * The TARGET account is the large one on purpose. The tape index earns its
 * keep by letting `LIMIT` stop early instead of sorting the account; with only
 * a handful of target rows the planner would rightly prefer the smaller
 * single-column `…_billing_account_idx` plus a trivial sort, and the test
 * would pass without demonstrating anything.
 */
const TARGET_DECISIONS = 20_000;
/** A second tenant with NEWER rows, so the tenant predicate is load-bearing. */
const BACKGROUND_DECISIONS = 5_000;
const PAGE_LIMIT = 50;
/**
 * No `Sort` node may materialise a large set. This is the direct encoding of
 * "bounded page read, not full-account sort" — far more robust than asserting
 * no `Sort` exists anywhere, which would flake on the planner's join choices
 * for the small LEFT JOINs and the mark LATERAL.
 */
const LARGE_SORT_ROWS = 1_000;
/** Generous on purpose — this asserts a plan shape, not a benchmark. */
const PLAN_EXECUTION_BUDGET_MS = 1_500;
/** Strictly after every seeded row, so the frozen cutoff excludes nothing. */
const CAPTURED_AT = "2026-11-01T00:00:00.000Z";

type ExplainNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  Plans?: ExplainNode[];
};

type ExplainDocument = { Plan: ExplainNode; "Execution Time": number };

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

function walletAddress(): string {
  return `0x${`${randomUUID()}${randomUUID()}`.replace(/-/g, "")}`.slice(0, 42);
}

describe("copy-trade attempt tape query plan", () => {
  const appDb = getAppDb();
  const seedDb = getSeedDb();

  const targetUserId = randomUUID();
  const backgroundUserId = randomUUID();
  const targetAccountId = randomUUID();
  const backgroundAccountId = randomUUID();
  const targetId = randomUUID();

  const baseQuery: PolyAccountRecentAttemptsQuery = {
    billing_account_id: targetAccountId,
    mode: "all",
    outcome: "all",
    limit: PAGE_LIMIT,
  };

  beforeAll(async () => {
    await seedDb.insert(users).values([
      {
        id: targetUserId,
        name: "tape-plan-target",
        walletAddress: walletAddress(),
      },
      {
        id: backgroundUserId,
        name: "tape-plan-background",
        walletAddress: walletAddress(),
      },
    ]);
    await seedDb.insert(billingAccounts).values([
      { id: targetAccountId, ownerUserId: targetUserId, balanceCredits: 0n },
      {
        id: backgroundAccountId,
        ownerUserId: backgroundUserId,
        balanceCredits: 0n,
      },
    ]);

    // One set-based statement. The account under test holds 20k decisions, so
    // serving one 50-row page by sorting the account would be plainly wrong;
    // the second tenant's rows are NEWER, so a plan that walked decided_at
    // globally would hit foreign rows first. Between them, only an ordered
    // seek on (billing_account_id, decided_at DESC, id DESC) is a good plan.
    await seedDb.execute(sql`
      INSERT INTO poly_copy_trade_decisions (
        billing_account_id, created_by_user_id, target_id, fill_id,
        outcome, reason, intent, decided_at, mode
      )
      SELECT
        ${backgroundAccountId},
        ${backgroundUserId},
        ${targetId}::uuid,
        'plan-background-' || n,
        CASE WHEN n % 3 = 0 THEN 'placed' ELSE 'skipped' END,
        'plan-background-reason',
        jsonb_build_object('market_id', 'plan-market-' || (n % 200), 'side', 'BUY'),
        TIMESTAMPTZ '2026-10-01 00:00:00+00' + n * INTERVAL '1 second',
        'paper'
      FROM generate_series(1, ${BACKGROUND_DECISIONS}) AS n  -- second tenant
      UNION ALL
      SELECT
        ${targetAccountId},
        ${targetUserId},
        ${targetId}::uuid,
        'plan-target-' || n,
        CASE WHEN n % 3 = 0 THEN 'placed' ELSE 'skipped' END,
        'plan-target-reason',
        jsonb_build_object('market_id', 'target-market-' || (n % 20), 'side', 'BUY'),
        TIMESTAMPTZ '2025-01-01 00:00:00+00' + n * INTERVAL '1 second',
        'paper'
      FROM generate_series(1, ${TARGET_DECISIONS}) AS n  -- account under test
    `);

    // app_user owns the migrated tables, so ANALYZE must run on the owner
    // connection for the skew to reach planner statistics.
    await appDb.execute(sql`ANALYZE poly_copy_trade_decisions`);
  }, 60_000);

  afterAll(async () => {
    // ON DELETE CASCADE from billing_accounts removes every seeded decision.
    await seedDb
      .delete(billingAccounts)
      .where(
        inArray(billingAccounts.id, [targetAccountId, backgroundAccountId])
      );
    await seedDb
      .delete(users)
      .where(inArray(users.id, [targetUserId, backgroundUserId]));
  }, 60_000);

  async function explain(statement: ReturnType<typeof copyTradeAttemptsSelect>) {
    return withTenantScope(
      appDb,
      userActor(toUserId(targetUserId)),
      async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = 10000`);
        return tx.execute(
          sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`
        );
      }
    );
  }

  const hasDecisionsSeqScan = (nodes: ExplainNode[]): boolean =>
    nodes.some(
      (node) =>
        node["Node Type"] === "Seq Scan" &&
        node["Relation Name"] === "poly_copy_trade_decisions"
    );

  /** Any Sort that materialised a large set means the account was sorted. */
  const largestSortRows = (nodes: ExplainNode[]): number =>
    nodes
      .filter((node) => node["Node Type"] === "Sort")
      .reduce((max, node) => Math.max(max, node["Actual Rows"] ?? 0), 0);

  it("seeks the tape index for the first page, with no decisions Seq Scan", async () => {
    const document = readExplainDocument(
      await explain(
        copyTradeAttemptsSelect(baseQuery, CAPTURED_AT, null, PAGE_LIMIT)
      )
    );
    const nodes = flattenPlan(document.Plan);

    const tapeScan = nodes.find((node) => node["Index Name"] === TAPE_INDEX);
    // Migration 0076's whole justification.
    expect(tapeScan).toBeDefined();
    expect(tapeScan?.["Node Type"]).toBe("Index Scan");

    expect(hasDecisionsSeqScan(nodes)).toBe(false);
    // The account holds 20k decisions; nothing may sort them to serve one page.
    expect(largestSortRows(nodes)).toBeLessThan(LARGE_SORT_ROWS);

    // Bounded: limit+1 is fetched to observe truncation, never more.
    expect(document.Plan["Actual Rows"]).toBeLessThanOrEqual(PAGE_LIMIT + 1);
    expect(document["Execution Time"]).toBeLessThan(PLAN_EXECUTION_BUDGET_MS);
  }, 60_000);

  it("seeks the same index for a cursor-bearing page", async () => {
    // Proves the row-value keyset predicate is an INDEX CONDITION, not a
    // filter applied after scanning the whole account.
    const cursor = {
      decidedAt: "2025-01-01T00:00:30.000Z",
      attemptId: randomUUID(),
    };
    const document = readExplainDocument(
      await explain(
        copyTradeAttemptsSelect(baseQuery, CAPTURED_AT, cursor, PAGE_LIMIT)
      )
    );
    const nodes = flattenPlan(document.Plan);

    expect(
      nodes.find((node) => node["Index Name"] === TAPE_INDEX)
    ).toBeDefined();
    expect(hasDecisionsSeqScan(nodes)).toBe(false);
    expect(largestSortRows(nodes)).toBeLessThan(LARGE_SORT_ROWS);
    expect(document.Plan["Actual Rows"]).toBeLessThanOrEqual(PAGE_LIMIT + 1);
  }, 60_000);
});

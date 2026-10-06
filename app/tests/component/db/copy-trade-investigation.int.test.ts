// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Real-Postgres proof for the bounded delegated investigation surface.
 * Proves RLS parity/isolation, frozen cursor semantics, hard page bounds, and
 * the account+JSON-market decision index used by the exact production query.
 */

import { randomUUID } from "node:crypto";
import { agentCapabilityGrants } from "@cogni/db-schema/agent-capability-grants";
import {
  polyCopyTradeDecisions,
  polyCopyTradeFills,
  polyCopyTradeTargets,
} from "@cogni/poly-db-schema/copy-trade";
import {
  polyMarketMetadata,
  polyMarketOutcomes,
  polyMarketPriceHistory,
  polyTraderPositionSnapshots,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { toUserId, userActor } from "@cogni/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/adapters/server/db/client";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { authorize } from "@/features/agent-grants/authorization";
import {
  copyTradeDecisionEvidenceSelect,
  getCopyTradeInvestigationEvidence,
  getCopyTradeInvestigationSummary,
  InvalidInvestigationCapturedAtError,
} from "@/features/wallet-analysis/server/copy-trade-investigation-service";
import { billingAccounts, users } from "@/shared/db/schema";

const CONDITION_A = `quant-a-${randomUUID()}`;
const CONDITION_B = `quant-b-${randomUUID()}`;
const CONDITION_MULTI = `quant-multi-${randomUUID()}`;
const MARKET_A = `prediction-market:polymarket:${CONDITION_A}`;
const MARKET_B = `prediction-market:polymarket:${CONDITION_B}`;
const MARKET_MULTI = `prediction-market:polymarket:${CONDITION_MULTI}`;
const TOKEN_YES = `quant-token-${randomUUID()}`;
const TARGET_WALLET = `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`.slice(0, 42);
const future = new Date("2099-01-01T00:00:00.000Z");

type Principal = { userId: string; name: string };
type Tenant = Principal & { billingAccountId: string };

function principal(name: string): Principal {
  return { userId: randomUUID(), name };
}

function tenant(name: string): Tenant {
  return { ...principal(name), billingAccountId: randomUUID() };
}

function wallet(): string {
  return `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`.slice(0, 42);
}

describe("copy-trade investigation", () => {
  const seedDb = getSeedDb();
  const ownerA = tenant("Quant owner A");
  const ownerB = tenant("Quant owner B");
  const delegate = principal("Quant delegate");
  const wrongScope = principal("Quant wrong scope");
  const revoked = principal("Quant revoked");
  const principals = [ownerA, ownerB, delegate, wrongScope, revoked];
  const fillTargetId = randomUUID();
  const targetRowId = randomUUID();
  let db: Database;
  let targetTraderWalletId = "";

  beforeAll(async () => {
    db = getAppDb();
    await seedDb.insert(users).values(
      principals.map((entry) => ({
        id: entry.userId,
        name: entry.name,
        walletAddress: wallet(),
      }))
    );
    await seedDb.insert(billingAccounts).values([
      { id: ownerA.billingAccountId, ownerUserId: ownerA.userId, balanceCredits: 0n },
      { id: ownerB.billingAccountId, ownerUserId: ownerB.userId, balanceCredits: 0n },
    ]);
    // story.5006 ALIAS PROOF: every grant below is stored under the LEGACY
    // `performance:read` name while the reads below require the canonical
    // `account:read`. This whole suite therefore exercises the expand-phase
    // compatibility path end-to-end — app-side `authorize()` overlap AND the
    // widened RLS policy bodies from migration 0074. Do not "modernize" these
    // fixtures: that would delete the regression test for the one live
    // production grant.
    await seedDb.insert(agentCapabilityGrants).values([
      {
        billingAccountId: ownerA.billingAccountId,
        granteePrincipalId: delegate.userId,
        scopes: ["performance:read"],
        expiresAt: future,
        createdByUserId: ownerA.userId,
      },
      {
        billingAccountId: ownerA.billingAccountId,
        granteePrincipalId: wrongScope.userId,
        scopes: ["research:run"],
        expiresAt: future,
        createdByUserId: ownerA.userId,
      },
      {
        billingAccountId: ownerA.billingAccountId,
        granteePrincipalId: revoked.userId,
        scopes: ["performance:read"],
        expiresAt: future,
        createdByUserId: ownerA.userId,
        revokedAt: new Date("2026-10-03T00:00:00.000Z"),
        revokedByUserId: ownerA.userId,
      },
    ]);
    const [trader] = await seedDb
      .insert(polyTraderWallets)
      .values({ walletAddress: TARGET_WALLET, kind: "copy_target", label: "Quant target" })
      .returning({ id: polyTraderWallets.id });
    targetTraderWalletId = trader?.id ?? "";
    await seedDb.insert(polyCopyTradeTargets).values({
      id: targetRowId,
      billingAccountId: ownerA.billingAccountId,
      createdByUserId: ownerA.userId,
      targetWallet: TARGET_WALLET,
      mirrorFilterPercentile: 80,
      mirrorMaxUsdcPerTrade: "12.00",
      sizingPolicyKind: "position_gap",
      targetRangeMaxUsdc: "1000.00",
      mirrorMaxAllocPerConditionUsdc: "100.00",
      mirrorActivatedAt: new Date("2026-10-03T00:00:00.000Z"),
    });
    await seedDb.insert(polyTraderPositionSnapshots).values({
      traderWalletId: targetTraderWalletId,
      conditionId: CONDITION_A,
      tokenId: TOKEN_YES,
      shares: "20.00000000",
      costBasisUsdc: "8.00000000",
      currentValueUsdc: "11.00000000",
      avgPrice: "0.40000000",
      contentHash: randomUUID(),
      capturedAt: new Date("2026-10-03T12:00:00.000Z"),
      raw: { outcome: "YES" },
    });
    await seedDb.insert(polyMarketMetadata).values({
      conditionId: CONDITION_A,
      marketTitle: "Quant marker market",
      marketSlug: "quant-marker-market",
      fetchedAt: new Date("2026-10-03T12:02:00.000Z"),
    });
    await seedDb.insert(polyMarketOutcomes).values({
      conditionId: CONDITION_A,
      tokenId: TOKEN_YES,
      outcome: "unknown",
      updatedAt: new Date("2026-10-03T12:03:00.000Z"),
      raw: { label: "YES" },
    });
    await seedDb.insert(polyMarketPriceHistory).values({
      asset: TOKEN_YES,
      fidelity: "1h",
      ts: new Date("2026-10-03T12:04:00.000Z"),
      price: "0.55000000",
      observedAt: new Date("2026-10-03T12:04:00.000Z"),
    });

    await seedDb.insert(polyCopyTradeFills).values([
      ...[0, 1, 2].map((index) => ({
        billingAccountId: ownerA.billingAccountId,
        createdByUserId: ownerA.userId,
        targetId: fillTargetId,
        fillId: `data-api:quant-a-${index}`,
        marketId: MARKET_A,
        observedAt: new Date(`2026-10-03T12:0${5 + index}:00.000Z`),
        clientOrderId: `quant-a-${index}-${randomUUID()}`,
        orderId: `quant-order-${index}-${randomUUID()}`,
        status: "filled" as const,
        positionLifecycle: "open",
        mode: "paper" as const,
        price: "0.50000000",
        shares: "2.00000000",
        feesUsdc: "0.01000000",
        attributes: {
          target_wallet: TARGET_WALLET,
          token_id: TOKEN_YES,
          outcome: "YES",
          side: "BUY",
          size_usdc: "1",
          filled_size_usdc: "1",
        },
      })),
      ...[0, 1, 2, 3, 4].map((index) => ({
        billingAccountId: ownerA.billingAccountId,
        createdByUserId: ownerA.userId,
        targetId: fillTargetId,
        fillId: `data-api:quant-multi-${index}`,
        marketId: MARKET_MULTI,
        observedAt: new Date(`2026-10-03T13:0${index}:00.000Z`),
        clientOrderId: `quant-multi-${index}-${randomUUID()}`,
        status: "filled" as const,
        positionLifecycle: "open",
        mode: "paper" as const,
        price: "0.10000000",
        shares: "1.00000000",
        feesUsdc: "0.00000000",
        attributes: {
          target_wallet: TARGET_WALLET,
          token_id: `quant-multi-token-${index}`,
          outcome: `OPTION_${index}`,
          side: "BUY",
        },
      })),
      {
        billingAccountId: ownerB.billingAccountId,
        createdByUserId: ownerB.userId,
        targetId: randomUUID(),
        fillId: "data-api:quant-b-marker",
        marketId: MARKET_B,
        observedAt: new Date("2026-10-03T12:05:00.000Z"),
        clientOrderId: `quant-b-${randomUUID()}`,
        status: "filled" as const,
        mode: "paper" as const,
        attributes: { marker: "tenant-b" },
      },
    ]);
    await seedDb.insert(polyCopyTradeDecisions).values(
      [0, 1, 2].map((index) => ({
        billingAccountId: ownerA.billingAccountId,
        createdByUserId: ownerA.userId,
        targetId: fillTargetId,
        fillId: `data-api:quant-a-${index}`,
        outcome: index === 2 ? ("skipped" as const) : ("placed" as const),
        reason: index === 2 ? "below_market_min" : null,
        intent: {
          market_id: MARKET_A,
          target_wallet: TARGET_WALLET,
          token_id: TOKEN_YES,
          side: "BUY",
          limit_price: "0.5",
          size_usdc: "1",
          position_branch: "new_entry",
          target_position_usdc: "8",
        },
        decidedAt: new Date(`2026-10-03T12:0${5 + index}:30.000Z`),
        mode: "paper" as const,
      }))
    );

    // Skew forces the exact JSON-market predicate to prove its expression
    // index instead of hiding a global scan behind LIMIT.
    await seedDb.execute(sql`
      INSERT INTO poly_copy_trade_decisions (
        id, billing_account_id, created_by_user_id, target_id, fill_id,
        outcome, reason, intent, decided_at, mode
      )
      SELECT
        gen_random_uuid(), ${ownerA.billingAccountId}, ${ownerA.userId},
        ${fillTargetId}::uuid, 'background-' || n, 'skipped', 'background',
        jsonb_build_object('market_id', 'background-market', 'token_id', 'background-token'),
        TIMESTAMPTZ '2026-10-03 10:00:00+00' + n * INTERVAL '1 millisecond', 'paper'
      FROM generate_series(1, 5000) AS n
    `);
    await db.execute(sql`ANALYZE poly_copy_trade_decisions`);
  }, 30_000);

  afterAll(async () => {
    await seedDb
      .delete(polyCopyTradeDecisions)
      .where(eq(polyCopyTradeDecisions.billingAccountId, ownerA.billingAccountId));
    await seedDb
      .delete(polyCopyTradeFills)
      .where(inArray(polyCopyTradeFills.billingAccountId, [ownerA.billingAccountId, ownerB.billingAccountId]));
    await seedDb
      .delete(agentCapabilityGrants)
      .where(eq(agentCapabilityGrants.billingAccountId, ownerA.billingAccountId));
    await seedDb
      .delete(polyCopyTradeTargets)
      .where(eq(polyCopyTradeTargets.id, targetRowId));
    await seedDb
      .delete(polyMarketPriceHistory)
      .where(eq(polyMarketPriceHistory.asset, TOKEN_YES));
    await seedDb
      .delete(polyMarketOutcomes)
      .where(eq(polyMarketOutcomes.conditionId, CONDITION_A));
    await seedDb
      .delete(polyMarketMetadata)
      .where(eq(polyMarketMetadata.conditionId, CONDITION_A));
    await seedDb
      .delete(polyTraderPositionSnapshots)
      .where(eq(polyTraderPositionSnapshots.traderWalletId, targetTraderWalletId));
    await seedDb
      .delete(polyTraderWallets)
      .where(eq(polyTraderWallets.id, targetTraderWalletId));
    await seedDb
      .delete(billingAccounts)
      .where(inArray(billingAccounts.id, [ownerA.billingAccountId, ownerB.billingAccountId]));
    await seedDb
      .delete(users)
      .where(inArray(users.id, principals.map((entry) => entry.userId)));
  }, 30_000);

  async function summaryFor(principalId: string, billingAccountId: string) {
    return withTenantScope(db, userActor(toUserId(principalId)), async (tx) => {
      const access = await authorize(tx, {
        principalId,
        accountId: billingAccountId,
        requiredScope: "account:read",
      });
      if (!access) return null;
      return getCopyTradeInvestigationSummary(
        tx as unknown as Parameters<typeof getCopyTradeInvestigationSummary>[0],
        {
          billing_account_id: billingAccountId,
          condition_id: MARKET_A,
          mode: "paper",
        }
      );
    });
  }

  it("gives owner and delegate identical tenant-A facts but denies every unauthorized principal", async () => {
    const owner = await summaryFor(ownerA.userId, ownerA.billingAccountId);
    const delegated = await summaryFor(delegate.userId, ownerA.billingAccountId);

    expect(owner).not.toBeNull();
    expect(delegated).not.toBeNull();
    if (!owner || !delegated) throw new Error("Expected authorized summaries");
    expect({ ...delegated, captured_at: owner.captured_at }).toEqual(owner);
    expect(delegated.condition_id).toBe(CONDITION_A);
    expect(delegated.market).toEqual(
      expect.objectContaining({
        condition_id: CONDITION_A,
        market_title: "Quant marker market",
      })
    );
    expect(delegated.market.outcomes[0]).toEqual(
      expect.objectContaining({ token_id: TOKEN_YES, label: "YES" })
    );
    expect(delegated.targets[0]).toEqual(
      expect.objectContaining({ target_id: targetRowId, wallet_address: TARGET_WALLET.toLowerCase() })
    );
    expect(delegated.targets[0]?.legs[0]).toEqual(
      expect.objectContaining({ token_id: TOKEN_YES, shares: 20 })
    );
    expect(delegated.account_position.legs[0]).toEqual(
      expect.objectContaining({ token_id: TOKEN_YES, net_shares: 6, marked_value_usdc: 3.3 })
    );
    expect(delegated.aggregates.decisions.count).toBe(3);

    expect(await summaryFor(delegate.userId, ownerB.billingAccountId)).toBeNull();
    expect(await summaryFor(wrongScope.userId, ownerA.billingAccountId)).toBeNull();
    expect(await summaryFor(revoked.userId, ownerA.billingAccountId)).toBeNull();
  });

  it("keeps target policy writes owner-only for a performance delegate", async () => {
    const updated = await withTenantScope(
      db,
      userActor(toUserId(delegate.userId)),
      (tx) =>
        tx
          .update(polyCopyTradeTargets)
          .set({ mirrorFilterPercentile: 99 })
          .where(eq(polyCopyTradeTargets.id, targetRowId))
          .returning({ id: polyCopyTradeTargets.id })
    );
    expect(updated).toEqual([]);
    const [target] = await seedDb
      .select({ percentile: polyCopyTradeTargets.mirrorFilterPercentile })
      .from(polyCopyTradeTargets)
      .where(eq(polyCopyTradeTargets.id, targetRowId));
    expect(target?.percentile).toBe(80);
  });

  it("uses a frozen cutoff and stable cursor without exceeding the requested page size", async () => {
    const summary = await summaryFor(delegate.userId, ownerA.billingAccountId);
    expect(summary).not.toBeNull();
    if (!summary) return;

    const first = await withTenantScope(db, userActor(toUserId(delegate.userId)), (tx) =>
      getCopyTradeInvestigationEvidence(
        tx as unknown as Parameters<typeof getCopyTradeInvestigationEvidence>[0],
        {
          billing_account_id: ownerA.billingAccountId,
          condition_id: MARKET_A,
          mode: "paper",
          kind: "fills",
          captured_at: summary.captured_at,
          limit: 2,
        }
      )
    );
    expect(first?.condition_id).toBe(CONDITION_A);
    expect(first?.items).toHaveLength(2);
    expect(first?.truncated).toBe(true);
    expect(first?.next_cursor).not.toBeNull();

    const second = await withTenantScope(db, userActor(toUserId(delegate.userId)), (tx) =>
      getCopyTradeInvestigationEvidence(
        tx as unknown as Parameters<typeof getCopyTradeInvestigationEvidence>[0],
        {
          billing_account_id: ownerA.billingAccountId,
          condition_id: MARKET_A,
          mode: "paper",
          kind: "fills",
          captured_at: summary.captured_at,
          limit: 2,
          ...(first?.next_cursor ? { cursor: first.next_cursor } : {}),
        }
      )
    );
    expect(second?.items).toHaveLength(1);
    expect(second?.truncated).toBe(false);
    expect(new Set([...(first?.items ?? []), ...(second?.items ?? [])].map((item) => item.evidence_id)).size).toBe(3);
  });

  it("rejects a future evidence cutoff so page membership cannot grow after page one", async () => {
    await expect(
      withTenantScope(db, userActor(toUserId(delegate.userId)), (tx) =>
        getCopyTradeInvestigationEvidence(
          tx as unknown as Parameters<typeof getCopyTradeInvestigationEvidence>[0],
          {
            billing_account_id: ownerA.billingAccountId,
            condition_id: MARKET_A,
            mode: "paper",
            kind: "fills",
            captured_at: "2099-01-01T00:00:00.000Z",
            limit: 2,
          }
        )
      )
    ).rejects.toBeInstanceOf(InvalidInvestigationCapturedAtError);
  });

  it("fails completeness closed when account position legs exceed the response cap", async () => {
    const result = await withTenantScope(
      db,
      userActor(toUserId(delegate.userId)),
      async (tx) => {
        const access = await authorize(tx, {
          principalId: delegate.userId,
          accountId: ownerA.billingAccountId,
          requiredScope: "account:read",
        });
        if (!access) return null;
        return getCopyTradeInvestigationSummary(
          tx as unknown as Parameters<typeof getCopyTradeInvestigationSummary>[0],
          {
            billing_account_id: ownerA.billingAccountId,
            condition_id: MARKET_MULTI,
            mode: "paper",
          }
        );
      }
    );

    expect(result?.account_position.legs).toHaveLength(4);
    expect(result?.account_position.truncated).toBe(true);
    expect(result?.completeness.account_position_truncated).toBe(true);
    expect(result?.completeness.facts).toContainEqual(
      expect.objectContaining({
        source: "mirror_ledger",
        status: "partial",
        complete: false,
      })
    );
  });

  it("uses the account+market expression index for the exact decision evidence query", async () => {
    const query = copyTradeDecisionEvidenceSelect({
      billing_account_id: ownerA.billingAccountId,
      condition_id: MARKET_A,
      mode: "paper",
      kind: "decisions",
      captured_at: "2026-10-04T00:00:00.000Z",
      limit: 100,
    });
    const explained = await seedDb.execute(sql`EXPLAIN (FORMAT JSON) ${query}`);
    const nodes = flattenPlan(readPlan(explained));
    expect(
      nodes.some(
        (node) => node["Index Name"] === "poly_copy_trade_decisions_investigation_idx"
      )
    ).toBe(true);
    expect(
      nodes.some(
        (node) =>
          node["Node Type"] === "Seq Scan" &&
          node["Relation Name"] === "poly_copy_trade_decisions"
      )
    ).toBe(false);
  });
});

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
};

function readPlan(value: unknown): PlanNode {
  const rows = Array.isArray(value) ? value : ((value as { rows?: unknown[] }).rows ?? []);
  const raw = (rows[0] as Record<string, unknown> | undefined)?.["QUERY PLAN"];
  const document = typeof raw === "string" ? JSON.parse(raw) : raw;
  return (document as Array<{ Plan: PlanNode }>)[0]?.Plan as PlanNode;
}

function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

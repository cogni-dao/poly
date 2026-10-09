// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/copy-operations-delegated-rls.int.test`
 * Purpose: Prove, on real Postgres, that the two copy-operations capabilities
 *   are tenant-isolated by row-level security BEFORE the orders route stops
 *   carrying its own clamp.
 * Scope: Real Postgres app/service roles; `poly_wallet_grants` (the policy this
 *   task adds in migration 0076), `poly_copy_trade_targets`,
 *   `poly_copy_trade_decisions`, `poly_copy_trade_fills`, and the two feature
 *   reads end-to-end. Does not test HTTP transport.
 *
 * WHY THIS TEST IS THE GATE, not a formality:
 *   The route being replaced says it outright — the order ledger runs on the
 *   BYPASSRLS service connection, so omitting the route's `WHERE
 *   billing_account_id` clamp "leaks rows across tenants". Removing that clamp
 *   is only safe if RLS genuinely carries the load underneath.
 *   The failure is asymmetric and silent in BOTH directions:
 *     * Every table here has FORCE ROW LEVEL SECURITY and is owned by the app
 *       role, so a policy MISTAKE makes rows VANISH rather than raise. A test
 *       that only asserted "no cross-tenant rows" would pass just as happily
 *       against a policy that returns nothing to anybody.
 *     * So every case below asserts a NON-ZERO count for the owner AND for the
 *       delegate, and zero for the cross-tenant reader. Both halves, together.
 * Invariants:
 *   - OWNER_AND_DELEGATE_BOTH_SEE_ROWS — non-zero for both, and identical.
 *   - CROSS_TENANT_IS_ZERO — a grant on account A never exposes account B.
 *   - DELEGATED_READ_GRANTS_NO_WRITE — the new `FOR SELECT` policy on
 *     `poly_wallet_grants` must not make the table mutable by a delegate.
 *     `tenant_isolation` (FOR ALL, owner-only) still owns every write.
 *   - CAPS_ABSENT_IS_NOT_CAPS_ZERO — NO_FABRICATED_VALUES asserted at the
 *     capability level, not just the SQL level.
 * Side-effects: IO (testcontainers Postgres)
 * Links: task.1791070959, migration 0076,
 *   app/tests/component/db/agent-capability-grant-rls.int.test.ts (precedent)
 * @internal
 */

import { randomUUID } from "node:crypto";
import { agentCapabilityGrants } from "@cogni/db-schema/agent-capability-grants";
import {
  polyCopyTargetConditionBaseline,
  polyCopyTradeDecisions,
  polyCopyTradeFills,
  polyCopyTradeTargets,
} from "@cogni/db-schema/copy-trade";
import {
  polyPositionGapActions,
  polyPositionGapCohorts,
  polyPositionGapRuns,
} from "@cogni/db-schema/position-gap";
import {
  polyTraderCurrentPositions,
  polyTraderWallets,
} from "@cogni/db-schema/trader-activity";
import { polyWalletConnections } from "@cogni/db-schema/wallet-connections";
import { polyWalletGrants } from "@cogni/db-schema/wallet-grants";
import { toUserId, userActor } from "@cogni/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

import type { Database } from "@/adapters/server/db/client";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { getSessionUser } from "@/app/_lib/auth/session";
import { PATCH as updateCopyTarget } from "@/app/api/v1/poly/copy-trade/targets/[id]/route";
import type { AgentGrantTransaction } from "@/features/agent-grants/authorization";
import { targetIdFromWallet } from "@/features/copy-trade/target-id";
import { getCopySetupForAccount } from "@/features/wallet-analysis/server/copy-setup-read";
import { getRecentAttemptsForAccount } from "@/features/wallet-analysis/server/copy-trade-attempts-read";
import { listCopyTradeOrdersForAccount } from "@/features/wallet-analysis/server/copy-trade-orders-read";
import { billingAccounts, users } from "@/shared/db/schema";

type Principal = { userId: string; name: string };
type Tenant = Principal & { billingAccountId: string };

const FILL_A = "data-api:copy-ops-fill-a";
const FILL_B = "data-api:copy-ops-fill-b";

const future = new Date("2099-01-01T00:00:00.000Z");
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function principal(name: string): Principal {
  return { userId: randomUUID(), name };
}

function tenant(name: string): Tenant {
  return { ...principal(name), billingAccountId: randomUUID() };
}

function walletAddress(): string {
  const hex = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
  return `0x${hex}`.slice(0, 42);
}

describe("copy-operations delegated RLS", () => {
  let db: Database;

  const ownerA = tenant("Copy-ops owner A");
  const ownerB = tenant("Copy-ops owner B");
  const delegate = principal("Copy-ops delegate (account:read on A)");
  const strangerAgent = principal("Copy-ops stranger (no grant)");

  const principals = [ownerA, ownerB, delegate, strangerAgent];

  const targetA = randomUUID();
  const targetB = randomUUID();
  const connectionA = randomUUID();
  const connectionB = randomUUID();
  const grantA = randomUUID();
  const grantB = randomUUID();
  const decisionA = randomUUID();
  const decisionB = randomUUID();
  const positionGapRunA = randomUUID();
  const positionGapCohortA = randomUUID();
  const positionGapActionA = randomUUID();
  const traderWalletA = randomUUID();
  const titleFallbackCondition = `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  const titleFallbackToken = "copy-ops-title-token-a";

  const targetWalletA = walletAddress();
  const targetWalletB = walletAddress();
  const positionGapTargetA = targetIdFromWallet(
    targetWalletA as `0x${string}`,
  );
  const copySetupBinding = {
    resolveEffectiveKind: (
      _wallet: `0x${string}`,
      kind:
        | "auto"
        | "min_bet"
        | "target_percentile_scaled"
        | "position_gap"
        | "mirror_fill_exact",
    ) => (kind === "auto" ? ("target_percentile_scaled" as const) : kind),
    implementationRevision: {
      status: "available" as const,
      build_sha: "0123456789abcdef0123456789abcdef01234567",
    },
  };

  beforeAll(async () => {
    db = getAppDb();
    const seedDb = getSeedDb();

    await seedDb.insert(users).values(
      principals.map((entry) => ({
        id: entry.userId,
        name: entry.name,
        walletAddress: walletAddress(),
      })),
    );

    await seedDb.insert(billingAccounts).values([
      {
        id: ownerA.billingAccountId,
        ownerUserId: ownerA.userId,
        balanceCredits: 0n,
      },
      {
        id: ownerB.billingAccountId,
        ownerUserId: ownerB.userId,
        balanceCredits: 0n,
      },
    ]);

    await seedDb.insert(polyTraderWallets).values({
      id: traderWalletA,
      walletAddress: targetWalletA,
      kind: "copy_target",
      label: "Copy-ops title fallback target",
    });
    await seedDb.insert(polyTraderCurrentPositions).values({
      traderWalletId: traderWalletA,
      // Mixed case is deliberate: ledger identity is canonical lowercase and
      // the public orders read must still resolve this persisted title.
      conditionId: titleFallbackCondition.toUpperCase(),
      tokenId: titleFallbackToken,
      shares: "1",
      costBasisUsdc: "0.50",
      currentValueUsdc: "0.55",
      avgPrice: "0.50",
      contentHash: "copy-ops-title-fallback",
      raw: { title: "Will the current-position fallback resolve?" },
    });

    // The delegate holds ONLY the canonical scope name, so this also re-proves
    // that migration 0076's policy body uses the same OVERLAP predicate as 0074.
    // A policy requiring the legacy name would authorize and then read zero
    // rows — "no data" instead of "denied", the exact trap 0074 documents.
    await seedDb.insert(agentCapabilityGrants).values([
      {
        billingAccountId: ownerA.billingAccountId,
        granteePrincipalId: delegate.userId,
        scopes: ["account:read"],
        expiresAt: future,
        createdByUserId: ownerA.userId,
      },
    ]);

    await seedDb.insert(polyCopyTradeTargets).values([
      {
        id: targetA,
        billingAccountId: ownerA.billingAccountId,
        createdByUserId: ownerA.userId,
        targetWallet: targetWalletA,
        mirrorFilterPercentile: 80,
        mirrorMaxUsdcPerTrade: "7.50",
        sizingPolicyKind: "position_gap",
        mirrorCapitalBudgetUsdc: "200.00",
        mirrorActivatedAt: new Date("2026-10-04T00:00:00.000Z"),
      },
      {
        id: targetB,
        billingAccountId: ownerB.billingAccountId,
        createdByUserId: ownerB.userId,
        targetWallet: targetWalletB,
        mirrorFilterPercentile: 90,
        mirrorMaxUsdcPerTrade: "3.25",
        sizingPolicyKind: "auto",
      },
    ]);

    // `poly_wallet_grants.wallet_connection_id` is a NOT NULL FK to
    // `poly_wallet_connections`, so both connection rows must exist. The
    // ciphertext is a placeholder: this test never decrypts anything, and the
    // connections table is deliberately NOT exposed by the new policy.
    const consentAt = new Date("2026-01-01T00:00:00.000Z");
    await seedDb.insert(polyWalletConnections).values([
      {
        id: connectionA,
        billingAccountId: ownerA.billingAccountId,
        createdByUserId: ownerA.userId,
        privyWalletId: `privy-${connectionA}`,
        address: walletAddress(),
        clobApiKeyCiphertext: Buffer.from("test-ciphertext-a"),
        encryptionKeyId: "test-key",
        custodialConsentAcceptedAt: consentAt,
        custodialConsentActorKind: "user",
        custodialConsentActorId: ownerA.userId,
      },
      {
        id: connectionB,
        billingAccountId: ownerB.billingAccountId,
        createdByUserId: ownerB.userId,
        privyWalletId: `privy-${connectionB}`,
        address: walletAddress(),
        clobApiKeyCiphertext: Buffer.from("test-ciphertext-b"),
        encryptionKeyId: "test-key",
        custodialConsentAcceptedAt: consentAt,
        custodialConsentActorKind: "user",
        custodialConsentActorId: ownerB.userId,
      },
    ]);

    // THE ROWS THIS TASK'S POLICY EXISTS FOR. Distinct cap values per tenant so
    // a cross-tenant leak is visible as a wrong NUMBER, not merely a wrong count.
    await seedDb.insert(polyWalletGrants).values([
      {
        id: grantA,
        billingAccountId: ownerA.billingAccountId,
        walletConnectionId: connectionA,
        createdByUserId: ownerA.userId,
        scopes: ["poly:trade:buy", "poly:trade:sell"],
        perOrderUsdcCap: "11.00",
        dailyUsdcCap: "110.00",
        hourlyFillsCap: 7,
        expiresAt: future,
        createdAt: consentAt,
      },
      {
        id: grantB,
        billingAccountId: ownerB.billingAccountId,
        walletConnectionId: connectionB,
        createdByUserId: ownerB.userId,
        scopes: ["poly:trade:buy"],
        perOrderUsdcCap: "22.00",
        dailyUsdcCap: "220.00",
        hourlyFillsCap: 9,
        expiresAt: future,
        createdAt: consentAt,
      },
    ]);

    await seedDb.insert(polyCopyTradeFills).values([
      {
        billingAccountId: ownerA.billingAccountId,
        createdByUserId: ownerA.userId,
        targetId: targetA,
        fillId: FILL_A,
        marketId: "prediction-market:polymarket:cond-a",
        observedAt: new Date("2026-10-05T00:00:00.000Z"),
        clientOrderId: `coid-${FILL_A}`,
        status: "filled",
        mode: "paper",
        algorithmId: "poly.copy-mirror.position-gap",
        algorithmVersionId: HASH_A,
        configHash: HASH_A,
        inputSnapshotId: HASH_A,
        assignmentId: targetA,
        correlationId: `coid-${FILL_A}`,
        attributes: { target_wallet: targetWalletA, size_usdc: 5 },
      },
      {
        billingAccountId: ownerB.billingAccountId,
        createdByUserId: ownerB.userId,
        targetId: targetB,
        fillId: FILL_B,
        marketId: "prediction-market:polymarket:cond-b",
        observedAt: new Date("2026-10-05T00:01:00.000Z"),
        clientOrderId: `coid-${FILL_B}`,
        status: "filled",
        mode: "paper",
        algorithmId: "poly.copy-mirror.min-bet",
        algorithmVersionId: HASH_B,
        configHash: HASH_B,
        inputSnapshotId: HASH_B,
        assignmentId: targetB,
        correlationId: `coid-${FILL_B}`,
        attributes: { target_wallet: targetWalletB, size_usdc: 6 },
      },
    ]);

    // Account A gets a PLACED attempt correlated to its fill, plus a SKIPPED
    // attempt that has no ledger row at all — the row class the dashboard card
    // structurally cannot see, and the reason this capability exists.
    await seedDb.insert(polyCopyTradeDecisions).values([
      {
        id: decisionA,
        billingAccountId: ownerA.billingAccountId,
        createdByUserId: ownerA.userId,
        targetId: targetA,
        fillId: FILL_A,
        outcome: "placed",
        algorithmId: "poly.copy-mirror.position-gap",
        algorithmVersionId: HASH_A,
        configHash: HASH_A,
        inputSnapshotId: HASH_A,
        assignmentId: targetA,
        correlationId: `coid-${FILL_A}`,
        intent: {
          market_id: "prediction-market:polymarket:cond-a",
          side: "BUY",
          size_usdc: 5,
        },
        decidedAt: new Date("2026-10-05T00:00:00.000Z"),
        mode: "paper",
      },
      {
        id: randomUUID(),
        billingAccountId: ownerA.billingAccountId,
        createdByUserId: ownerA.userId,
        targetId: targetA,
        fillId: "data-api:copy-ops-skipped-a",
        outcome: "skipped",
        reason: "below_filter_percentile",
        algorithmId: "poly.copy-mirror.position-gap",
        algorithmVersionId: HASH_A,
        configHash: HASH_A,
        inputSnapshotId: HASH_A,
        assignmentId: targetA,
        correlationId: "skipped-a",
        intent: {
          market_id: "prediction-market:polymarket:cond-a",
          side: "BUY",
          size_usdc: 2,
          mirror_portfolio_current_value_usdc: 500,
          effective_mirror_capital_budget_usdc: 200,
          mirror_budget_allocation_status: "reserved",
          effective_budget_observed_at: "2026-10-05T00:02:00.000Z",
        },
        decidedAt: new Date("2026-10-05T00:02:00.000Z"),
        mode: "paper",
      },
      {
        id: decisionB,
        billingAccountId: ownerB.billingAccountId,
        createdByUserId: ownerB.userId,
        targetId: targetB,
        fillId: FILL_B,
        outcome: "placed",
        algorithmId: "poly.copy-mirror.min-bet",
        algorithmVersionId: HASH_B,
        configHash: HASH_B,
        inputSnapshotId: HASH_B,
        assignmentId: targetB,
        correlationId: `coid-${FILL_B}`,
        intent: {
          market_id: "prediction-market:polymarket:cond-b",
          side: "SELL",
          size_usdc: 6,
        },
        decidedAt: new Date("2026-10-05T00:03:00.000Z"),
        mode: "paper",
      },
    ]);
    await seedDb.insert(polyPositionGapRuns).values({
      id: positionGapRunA,
      billingAccountId: ownerA.billingAccountId,
      createdByUserId: ownerA.userId,
      targetId: positionGapTargetA,
      triggerReasons: ["safety_timer"],
      targetSnapshotId: "copy-ops-snapshot-a",
      targetSnapshotHash: "copy-ops-snapshot-hash-a",
      targetSnapshotAsOf: new Date("2026-10-05T00:04:00.000Z"),
      targetSnapshotExpiresAt: future,
      targetSnapshot: { complete: true },
      plannerVersion: "position-gap-v3",
      budgetUsdc: "200",
      eligibleNetNavUsdc: "500",
      scale: "0.4",
      walletCashUsdcAtStart: "250",
      status: "completed",
      plan: {
        status: "no_feasible_position",
        blockReason: null,
        eligibleNetNavUsdc: 500,
        scale: 0.4,
        sleeveBudgetUsdc: 200,
        intents: [],
        lockedOverweights: [],
        diagnostics: [{
          conditionId: "condition-a",
          tokenId: "token-a",
          cohortId: "cohort-a",
          reason: "below_market_floor",
          desiredShares: 0.4,
          heldShares: 0,
          openShares: 0,
          gapShares: 0.4,
          targetWeight: 0.01,
          limitPrice: 0.79,
          floorNotionalUsdc: 3.95,
          minimumSleeveUsdc: 53.31,
        }],
        minimumFeasibleSleeveUsdc: 53.31,
      },
      startedAt: new Date("2026-10-05T00:04:01.000Z"),
      completedAt: new Date("2026-10-05T00:04:02.000Z"),
    });
    await seedDb.insert(polyPositionGapCohorts).values({
      id: positionGapCohortA,
      billingAccountId: ownerA.billingAccountId,
      createdByUserId: ownerA.userId,
      targetId: positionGapTargetA,
      cohortKey: "copy-ops-cohort-a",
      sourceKind: "activation",
      sourceConfigRevision: "copy-ops-revision-a",
      sourceSnapshotId: "copy-ops-snapshot-a",
      sourceSnapshotHash: "copy-ops-snapshot-hash-a",
      sourceSnapshotAsOf: new Date("2026-10-05T00:04:00.000Z"),
      sourceProvenance: {},
      createdRunId: positionGapRunA,
      conditionId: "condition-a",
      tokenId: "token-a",
      marketId: "prediction-market:polymarket:condition-a",
      outcome: "Yes",
      targetDeltaShares: "9.3",
      scaleAtCreation: "1",
      allowedMirrorShares: "9.3",
      initialAllowedMirrorShares: "9.3",
      benchmarkTargetVwap: "0.001",
      acquiredShares: "9.3",
      remainingShares: "0",
      status: "exhausted",
    });
    await seedDb.insert(polyPositionGapActions).values({
      id: positionGapActionA,
      billingAccountId: ownerA.billingAccountId,
      createdByUserId: ownerA.userId,
      targetId: positionGapTargetA,
      runId: positionGapRunA,
      cohortId: positionGapCohortA,
      cohortKey: "copy-ops-cohort-a",
      actionKey: "copy-ops-action-a",
      kind: "buy",
      conditionId: "condition-a",
      tokenId: "token-a",
      marketId: "prediction-market:polymarket:condition-a",
      outcome: "Yes",
      desiredShares: "9.306",
      notionalUsdc: "3.592216",
      limitPrice: "0.386",
      filledShares: "9.3",
      filledUsdc: "0.009295",
      plannerAction: {
        fill_accounting_status: "verified",
        realized_fill_source: "data_api_activity_position",
      },
      clientOrderId: "copy-ops-client-a",
      orderId: "copy-ops-order-a",
      status: "filled",
      submitStartedAt: new Date("2026-10-05T00:04:03.000Z"),
      submittedAt: new Date("2026-10-05T00:04:04.000Z"),
      completedAt: new Date("2026-10-05T00:04:05.000Z"),
    });
    await seedDb.insert(polyCopyTradeFills).values({
      billingAccountId: ownerA.billingAccountId,
      createdByUserId: ownerA.userId,
      targetId: positionGapTargetA,
      fillId: "position-gap-v3:copy-ops-action-a",
      marketId: "prediction-market:polymarket:condition-a",
      observedAt: new Date("2026-10-05T00:04:05.000Z"),
      clientOrderId: "copy-ops-client-a",
      orderId: "copy-ops-order-a",
      status: "filled",
      mode: "live",
      price: String(0.009295 / 9.3),
      shares: "9.3",
      feesUsdc: "0.00046",
      attributes: {
        position_gap_version: "3",
        filled_size_usdc: 0.009295,
        realized_fill_source: "data_api_activity_position",
      },
    });
    await seedDb.insert(polyCopyTradeFills).values({
      billingAccountId: ownerA.billingAccountId,
      createdByUserId: ownerA.userId,
      targetId: targetA,
      fillId: "position-gap-v3:copy-ops-title-fallback",
      marketId: `prediction-market:polymarket:${titleFallbackCondition}`,
      observedAt: new Date("2026-10-05T00:05:00.000Z"),
      clientOrderId: "copy-ops-title-fallback",
      orderId: "copy-ops-title-fallback-order",
      status: "canceled",
      mode: "live",
      attributes: {
        position_gap_version: "3",
        condition_id: titleFallbackCondition,
        token_id: titleFallbackToken,
        outcome: "0",
        title: "0",
        side: "BUY",
        size_usdc: 5,
        reason: "position_gap_reconciled",
      },
    });
  });

  afterAll(async () => {
    const seedDb = getSeedDb();
    const accounts = [ownerA.billingAccountId, ownerB.billingAccountId];
    await seedDb
      .delete(polyPositionGapActions)
      .where(inArray(polyPositionGapActions.billingAccountId, accounts));
    await seedDb
      .delete(polyPositionGapCohorts)
      .where(inArray(polyPositionGapCohorts.billingAccountId, accounts));
    await seedDb
      .delete(polyPositionGapRuns)
      .where(inArray(polyPositionGapRuns.billingAccountId, accounts));
    await seedDb
      .delete(polyCopyTradeDecisions)
      .where(inArray(polyCopyTradeDecisions.billingAccountId, accounts));
    await seedDb
      .delete(polyCopyTradeFills)
      .where(inArray(polyCopyTradeFills.billingAccountId, accounts));
    await seedDb
      .delete(polyCopyTargetConditionBaseline)
      .where(
        inArray(polyCopyTargetConditionBaseline.billingAccountId, accounts),
      );
    await seedDb
      .delete(polyWalletGrants)
      .where(inArray(polyWalletGrants.billingAccountId, accounts));
    await seedDb
      .delete(polyWalletConnections)
      .where(inArray(polyWalletConnections.billingAccountId, accounts));
    await seedDb
      .delete(polyCopyTradeTargets)
      .where(inArray(polyCopyTradeTargets.billingAccountId, accounts));
    await seedDb
      .delete(polyTraderWallets)
      .where(eq(polyTraderWallets.id, traderWalletA));
    await seedDb
      .delete(agentCapabilityGrants)
      .where(
        eq(agentCapabilityGrants.billingAccountId, ownerA.billingAccountId),
      );
    await seedDb
      .delete(billingAccounts)
      .where(inArray(billingAccounts.id, accounts));
    await seedDb.delete(users).where(
      inArray(
        users.id,
        principals.map((entry) => entry.userId),
      ),
    );
  });

  /** Raw RLS visibility of `poly_wallet_grants` for one principal. */
  async function readWalletGrants(userId: string) {
    return withTenantScope(db, userActor(toUserId(userId)), (tx) =>
      tx
        .select({
          id: polyWalletGrants.id,
          billingAccountId: polyWalletGrants.billingAccountId,
          perOrderUsdcCap: polyWalletGrants.perOrderUsdcCap,
        })
        .from(polyWalletGrants)
        .where(inArray(polyWalletGrants.id, [grantA, grantB])),
    );
  }

  // -----------------------------------------------------------------------
  // The new policy: poly_wallet_grants
  // -----------------------------------------------------------------------

  it("gives the OWNER a non-zero view of its own wallet grant", async () => {
    const rows = await readWalletGrants(ownerA.userId);
    // Non-zero is the half that catches a vanished-rows policy bug.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.id)).toEqual([grantA]);
    expect(Number(rows[0]?.perOrderUsdcCap)).toBe(11);
  });

  it("gives the DELEGATE the identical non-zero view, via migration 0076", async () => {
    const owner = await readWalletGrants(ownerA.userId);
    const delegated = await readWalletGrants(delegate.userId);

    expect(delegated.length).toBeGreaterThan(0);
    expect(delegated).toEqual(owner);
    // Before 0076 this read returned ZERO rows while authorize() still allowed
    // the request — caps silently absent on a fully configured account.
    expect(Number(delegated[0]?.perOrderUsdcCap)).toBe(11);
  });

  it("never exposes tenant B's wallet grant through tenant A's grant", async () => {
    const delegated = await readWalletGrants(delegate.userId);
    expect(delegated.map((row) => row.id)).not.toContain(grantB);
    expect(
      delegated.every(
        (row) => row.billingAccountId === ownerA.billingAccountId,
      ),
    ).toBe(true);

    // And B's owner sees exactly its own — non-zero, so this case also cannot
    // pass vacuously.
    const ownerBRows = await readWalletGrants(ownerB.userId);
    expect(ownerBRows.map((row) => row.id)).toEqual([grantB]);
    expect(Number(ownerBRows[0]?.perOrderUsdcCap)).toBe(22);
  });

  it("returns zero wallet grants for a principal with no grant at all", async () => {
    expect(await readWalletGrants(strangerAgent.userId)).toEqual([]);
  });

  it("returns zero wallet grants with no tenant context set", async () => {
    const rows = await db.transaction((tx) =>
      tx
        .select({ id: polyWalletGrants.id })
        .from(polyWalletGrants)
        .where(inArray(polyWalletGrants.id, [grantA, grantB])),
    );
    expect(rows).toEqual([]);
  });

  it("does NOT let the delegate mutate wallet grants", async () => {
    // The new policy is FOR SELECT only; `tenant_isolation` (FOR ALL,
    // owner-only) still governs writes, so an UPDATE must affect no rows.
    await withTenantScope(
      db,
      userActor(toUserId(delegate.userId)),
      async (tx) => {
        await tx
          .update(polyWalletGrants)
          .set({ hourlyFillsCap: 999 })
          .where(eq(polyWalletGrants.id, grantA));
      },
    );

    const [row] = await getSeedDb()
      .select({ hourlyFillsCap: polyWalletGrants.hourlyFillsCap })
      .from(polyWalletGrants)
      .where(eq(polyWalletGrants.id, grantA));
    expect(row?.hourlyFillsCap).toBe(7);
  });

  // -----------------------------------------------------------------------
  // The capabilities end-to-end, on the same app-role tenant transaction the
  // executor opens.
  // -----------------------------------------------------------------------

  /**
   * Calls the handlers DIRECTLY, deliberately skipping `executeAccountRead` so
   * this file tests the database boundary rather than the dispatcher.
   *
   * Each call therefore passes the REQUESTED account as the authorized
   * `accountId` third argument — including the cross-tenant cases, where
   * `authorize()` would really have denied. That makes those assertions
   * strictly stronger: they ask "if authorization somehow allowed this, does
   * RLS still return nothing?" rather than merely re-testing the allow check.
   */
  const asTx = <T>(
    userId: string,
    run: (tx: AgentGrantTransaction) => Promise<T>,
  ): Promise<T> =>
    withTenantScope(db, userActor(toUserId(userId)), (tx) =>
      run(tx as AgentGrantTransaction),
    );

  it("copy-setup: owner and delegate get identical non-empty setup", async () => {
    const owner = await asTx(ownerA.userId, (tx) =>
      getCopySetupForAccount(tx, ownerA.billingAccountId, copySetupBinding),
    );
    const delegated = await asTx(delegate.userId, (tx) =>
      getCopySetupForAccount(tx, ownerA.billingAccountId, copySetupBinding),
    );

    expect(owner).not.toBeNull();
    expect(owner?.targets.length).toBeGreaterThan(0);
    expect(owner?.targets[0]?.target_wallet).toBe(targetWalletA);
    // The two sources are joined: policy from targets, caps from wallet grants.
    expect(owner?.wallet_safety.status).toBe("active");
    expect(owner?.targets[0]?.activation.status).toBe("eligible");
    expect(owner?.targets[0]?.policy.declared_kind).toBe("position_gap");
    expect(owner?.targets[0]?.policy.effective_kind).toBe("position_gap");
    expect(owner?.targets[0]?.policy.portfolio_budget).toEqual({
      configured_budget_usdc: 200,
      effective_budget_usdc: 200,
      allocation_status: "reserved",
      effective_budget_observed_at: "2026-10-05T00:02:00.000Z",
      observation_status: "observed",
    });
    expect(owner?.budget_allocation).toMatchObject({
      position_gap_target_count: 1,
      explicit_budget_total_usdc: 200,
      mirror_nav_usdc: 500,
      effective_budget_total_usdc: 200,
      observation_status: "observed",
    });
    expect(owner?.targets[0]?.policy.implementation_revision).toEqual(
      copySetupBinding.implementationRevision,
    );
    expect(owner?.targets[0]?.position_gap_runtime).toMatchObject({
      status: "observed",
      snapshot: { completeness: "complete", freshness: "fresh" },
      plan: {
        status: "no_feasible_position",
        sleeve_budget_usdc: 200,
        minimum_feasible_sleeve_usdc: 53.31,
      },
      execution: {
        submitted_order_count: 1,
        fill_accounting: {
          status: "verified",
          source: "data_api_activity_position",
          matched_order_count: 1,
          realized_shares: 9.3,
          realized_entry_notional_usdc: 0.009295,
        },
        recent_orders_truncated: false,
        recent_orders: [
          expect.objectContaining({
            action_id: positionGapActionA,
            order_id: "copy-ops-order-a",
            realized_fill_price: 0.00099946,
            fees_usdc: 0.00046,
            fill_accounting: expect.objectContaining({
              status: "verified",
              source: "data_api_activity_position",
            }),
          }),
        ],
      },
      position_count: 1,
    });

    // Parity is structural: same saved facts for both principals.
    expect(delegated?.targets).toEqual(owner?.targets);
    expect(delegated?.wallet_safety).toEqual(owner?.wallet_safety);
    expect(delegated?.budget_allocation).toEqual(owner?.budget_allocation);
  });

  it("orders: resolves a mixed-case current-position title and cancellation code", async () => {
    const orders = await asTx(ownerA.userId, (tx) =>
      listCopyTradeOrdersForAccount(
        tx,
        { limit: 200 },
        ownerA.billingAccountId,
      ),
    );
    const row = orders?.orders.find(
      (order) => order.client_order_id === "copy-ops-title-fallback",
    );

    expect(row).toMatchObject({
      market_title: "Will the current-position fallback resolve?",
      outcome: "0",
      status: "canceled",
      error: "position_gap_reconciled",
    });
  });

  it("copy-setup: a cross-tenant read is denied, not silently emptied", async () => {
    // Tenant B's owner asking for account A sees nothing at all. RLS removes
    // both the targets and the caps, so the capability reports not-found rather
    // than an account that looks unconfigured.
    const leaked = await asTx(ownerB.userId, (tx) =>
      getCopySetupForAccount(tx, ownerA.billingAccountId, copySetupBinding),
    );
    expect(leaked).toBeNull();
  });

  it("copy-setup: marks a malformed latest plan unavailable", async () => {
    const malformedRunId = randomUUID();
    await getSeedDb().insert(polyPositionGapRuns).values({
      id: malformedRunId,
      billingAccountId: ownerA.billingAccountId,
      createdByUserId: ownerA.userId,
      targetId: targetIdFromWallet(targetWalletA as `0x${string}`),
      triggerReasons: ["safety_timer"],
      targetSnapshot: { complete: true },
      budgetUsdc: "200",
      walletCashUsdcAtStart: "250",
      status: "completed",
      plan: {},
      startedAt: new Date("2098-01-01T00:00:00.000Z"),
    });
    try {
      const setup = await asTx(ownerA.userId, (tx) =>
        getCopySetupForAccount(tx, ownerA.billingAccountId, copySetupBinding),
      );
      expect(setup?.targets[0]?.position_gap_runtime).toEqual({
        status: "unavailable",
        reason: "invalid_reconciliation_record",
      });
    } finally {
      await getSeedDb()
        .delete(polyPositionGapRuns)
        .where(eq(polyPositionGapRuns.id, malformedRunId));
    }
  });

  it("copy-setup: keeps a stale safety run explicit for owner and delegate", async () => {
    const safetyRunId = randomUUID();
    await getSeedDb().insert(polyPositionGapRuns).values({
      id: safetyRunId,
      billingAccountId: ownerA.billingAccountId,
      createdByUserId: ownerA.userId,
      targetId: targetIdFromWallet(targetWalletA as `0x${string}`),
      triggerReasons: ["safety_timer"],
      targetSnapshotId: "stale-snapshot",
      targetSnapshotExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
      targetSnapshot: { complete: true },
      budgetUsdc: "200",
      eligibleNetNavUsdc: "500",
      scale: "0.4",
      walletCashUsdcAtStart: "250",
      status: "halted",
      plan: {
        status: "blocked",
        blockReason: "stale_snapshot",
        eligibleNetNavUsdc: 500,
        scale: 0.4,
        sleeveBudgetUsdc: 0,
        intents: [],
        diagnostics: [],
        lockedOverweights: [],
        minimumFeasibleSleeveUsdc: null,
      },
      startedAt: new Date("2098-01-02T00:00:00.000Z"),
    });
    try {
      const owner = await asTx(ownerA.userId, (tx) =>
        getCopySetupForAccount(tx, ownerA.billingAccountId, copySetupBinding),
      );
      const delegated = await asTx(delegate.userId, (tx) =>
        getCopySetupForAccount(tx, ownerA.billingAccountId, copySetupBinding),
      );
      expect(owner?.targets[0]?.position_gap_runtime).toMatchObject({
        status: "observed",
        snapshot: { freshness: "stale" },
        plan: { status: "blocked", block_reason: "stale_snapshot", sleeve_budget_usdc: 200 },
      });
      expect(delegated?.targets[0]?.position_gap_runtime).toEqual(
        owner?.targets[0]?.position_gap_runtime,
      );
    } finally {
      await getSeedDb()
        .delete(polyPositionGapRuns)
        .where(eq(polyPositionGapRuns.id, safetyRunId));
    }
  });

  it("copy-setup: `auto` policy uses the injected runtime resolver", async () => {
    const setup = await asTx(ownerB.userId, (tx) =>
      getCopySetupForAccount(tx, ownerB.billingAccountId, copySetupBinding),
    );
    const policy = setup?.targets[0]?.policy;
    expect(policy?.declared_kind).toBe("auto");
    expect(policy?.effective_kind).toBe("target_percentile_scaled");
    expect(policy?.resolution).toBe("auto_snapshot");
  });

  it("copy-setup: reports an account and every position-gap target as blocked when holdings attribution is ambiguous", async () => {
    const secondTargetId = randomUUID();
    await getSeedDb().insert(polyCopyTradeTargets).values({
      id: secondTargetId,
      billingAccountId: ownerA.billingAccountId,
      createdByUserId: ownerA.userId,
      targetWallet: walletAddress(),
      mirrorFilterPercentile: 80,
      mirrorMaxUsdcPerTrade: "7.50",
      sizingPolicyKind: "position_gap",
      mirrorCapitalBudgetUsdc: "100.00",
      mirrorActivatedAt: new Date("2026-10-06T00:00:00.000Z"),
    });

    try {
      const setup = await asTx(ownerA.userId, (tx) =>
        getCopySetupForAccount(tx, ownerA.billingAccountId, copySetupBinding),
      );

      expect(setup?.budget_allocation).toMatchObject({
        position_gap_target_count: 2,
        mirror_nav_usdc: null,
        effective_budget_total_usdc: null,
        observation_status: "blocked_multi_target",
      });
      expect(
        setup?.targets
          .filter((target) => target.policy.effective_kind === "position_gap")
          .map((target) => target.policy.portfolio_budget),
      ).toEqual([
        expect.objectContaining({
          effective_budget_usdc: null,
          allocation_status: "blocked_multi_target",
          observation_status: "blocked_multi_target",
        }),
        expect.objectContaining({
          effective_budget_usdc: null,
          allocation_status: "blocked_multi_target",
          observation_status: "blocked_multi_target",
        }),
      ]);
    } finally {
      await getSeedDb()
        .delete(polyCopyTradeTargets)
        .where(eq(polyCopyTradeTargets.id, secondTargetId));
    }
  });

  it("target PATCH rejects stale saves and clears the prior position-gap baseline", async () => {
    const deterministicTargetId = targetIdFromWallet(
      targetWalletA as `0x${string}`,
    );
    await getSeedDb().insert(polyCopyTargetConditionBaseline).values({
      billingAccountId: ownerA.billingAccountId,
      targetId: deterministicTargetId,
      conditionId: "condition-before-policy-change",
      baselineTargetPositionUsdc: "125.00",
      capturedAtFillId: "baseline-before-policy-change",
    });

    const [before] = await getSeedDb()
      .select({ activatedAt: polyCopyTradeTargets.mirrorActivatedAt })
      .from(polyCopyTradeTargets)
      .where(eq(polyCopyTradeTargets.id, targetA));
    expect(before).toBeDefined();

    vi.mocked(getSessionUser).mockResolvedValue({
      id: ownerA.userId,
      walletAddress: walletAddress(),
    });
    const body = {
      sizing_policy_kind: "position_gap",
      expected_mirror_activated_at: before?.activatedAt.toISOString(),
      mirror_filter_percentile: 80,
      mirror_max_usdc_per_trade: 7.5,
      target_range_max_usdc: 100,
      mirror_max_alloc_per_condition_usdc: 10,
      mirror_capital_budget_usdc: 125,
    };

    const first = await updateCopyTarget(
      new NextRequest(
        `http://localhost:3000/api/v1/poly/copy-trade/targets/${targetA}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ id: targetA }) },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      target: {
        target_id: targetA,
        sizing_policy_kind: "position_gap",
        target_range_max_usdc: 100,
        mirror_max_alloc_per_condition_usdc: 10,
        mirror_capital_budget_usdc: 125,
      },
    });

    const baselines = await getSeedDb()
      .select()
      .from(polyCopyTargetConditionBaseline)
      .where(
        eq(polyCopyTargetConditionBaseline.targetId, deterministicTargetId),
      );
    expect(baselines).toHaveLength(0);

    const stale = await updateCopyTarget(
      new NextRequest(
        `http://localhost:3000/api/v1/poly/copy-trade/targets/${targetA}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ id: targetA }) },
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale_target_policy" });
  });

  it("recent-attempts: the tape SHOWS skips, which the fills ledger cannot", async () => {
    const owner = await asTx(ownerA.userId, (tx) =>
      getRecentAttemptsForAccount(
        tx,
        {
          billing_account_id: ownerA.billingAccountId,
          mode: "all",
          outcome: "all",
          limit: 50,
        },
        ownerA.billingAccountId,
      ),
    );
    const delegated = await asTx(delegate.userId, (tx) =>
      getRecentAttemptsForAccount(
        tx,
        {
          billing_account_id: ownerA.billingAccountId,
          mode: "all",
          outcome: "all",
          limit: 50,
        },
        ownerA.billingAccountId,
      ),
    );

    expect(owner).not.toBeNull();
    expect(owner?.attempts.length).toBe(2);
    expect(delegated?.attempts).toEqual(owner?.attempts);

    const skipped = owner?.attempts.find(
      (attempt) => attempt.decision.outcome === "skipped",
    );
    // The whole point of the capability.
    expect(skipped).toBeDefined();
    expect(skipped?.decision.reason).toBe("below_filter_percentile");
    // A skip has no ledger row, and that is an EXPECTED absence.
    expect(skipped?.executed.availability).toBe("no_order_placed");
    expect(skipped?.algorithm).toEqual({
      availability: "observed",
      algorithm_id: "poly.copy-mirror.position-gap",
      algorithm_version_id: HASH_A,
      config_hash: HASH_A,
      input_snapshot_id: HASH_A,
      assignment_id: targetA,
      correlation_id: "skipped-a",
    });

    const placed = owner?.attempts.find(
      (attempt) => attempt.decision.outcome === "placed",
    );
    // Decision evidence correlated with placement/fill evidence.
    expect(placed?.executed.availability).toBe("observed");
    // Intended size survives even though the fill never realized a price.
    expect(placed?.intended.size_usdc).toBe(5);
    expect(placed?.algorithm).toMatchObject({
      availability: "observed",
      algorithm_id: "poly.copy-mirror.position-gap",
      correlation_id: `coid-${FILL_A}`,
    });
    // NO_FABRICATED_VALUES: no realized price/shares yet, so no executed size.
    if (placed?.executed.availability === "observed") {
      expect(placed.executed.filled_size_usdc).toBeNull();
    }
    expect(owner?.completeness.spine).toBe("poly_copy_trade_decisions");
  });

  it("algorithm lineage is all-or-nothing and restricted to registered IDs", async () => {
    const seedDb = getSeedDb();
    const base = {
      billingAccountId: ownerA.billingAccountId,
      createdByUserId: ownerA.userId,
      targetId: targetA,
      marketId: "prediction-market:polymarket:lineage-constraint",
      observedAt: new Date("2026-10-05T00:04:00.000Z"),
      clientOrderId: `coid-lineage-${randomUUID()}`,
      status: "pending" as const,
      mode: "paper" as const,
      attributes: {},
    };

    await expect(
      seedDb.insert(polyCopyTradeFills).values({
        ...base,
        fillId: `partial-lineage:${randomUUID()}`,
        algorithmId: "poly.copy-mirror.min-bet",
      }),
    ).rejects.toThrow();

    await expect(
      seedDb.insert(polyCopyTradeFills).values({
        ...base,
        fillId: `unknown-algorithm:${randomUUID()}`,
        algorithmId: "poly.copy-mirror.unknown",
        algorithmVersionId: HASH_A,
        configHash: HASH_A,
        inputSnapshotId: HASH_A,
        assignmentId: targetA,
        correlationId: "constraint-test",
      }),
    ).rejects.toThrow();
  });

  it("recent-attempts: ordering is newest-first and the cursor is opaque", async () => {
    const page = await asTx(ownerA.userId, (tx) =>
      getRecentAttemptsForAccount(
        tx,
        {
          billing_account_id: ownerA.billingAccountId,
          mode: "all",
          outcome: "all",
          limit: 1,
        },
        ownerA.billingAccountId,
      ),
    );
    expect(page).not.toBeNull();
    if (page === null) return;
    expect(page.attempts.length).toBe(1);
    // The skip is the most recent decision.
    expect(page.attempts[0]?.decision.outcome).toBe("skipped");
    expect(page.truncated).toBe(true);
    expect(page.next_cursor).toBeTruthy();
    const cursor = page.next_cursor;
    if (cursor === null) return;

    // Page 2 under the SAME frozen cutoff must not repeat page 1's row.
    const next = await asTx(ownerA.userId, (tx) =>
      getRecentAttemptsForAccount(
        tx,
        {
          billing_account_id: ownerA.billingAccountId,
          mode: "all",
          outcome: "all",
          limit: 1,
          captured_at: page.captured_at,
          cursor,
        },
        ownerA.billingAccountId,
      ),
    );
    expect(next?.attempts.length).toBe(1);
    expect(next?.attempts[0]?.attempt_id).not.toBe(
      page.attempts[0]?.attempt_id,
    );
    expect(next?.attempts[0]?.decision.outcome).toBe("placed");
    expect(next?.truncated).toBe(false);
    expect(next?.next_cursor).toBeNull();
  });

  it("recent-attempts: the outcome filter is a SQL predicate, not a post-LIMIT filter", async () => {
    // limit=1 with outcome=placed must return the PLACED row. The old
    // orders-route pattern (filter in JS after the SQL LIMIT) would have
    // fetched the newest row — the skip — and then filtered it away, returning
    // an empty page while a matching row existed.
    const page = await asTx(ownerA.userId, (tx) =>
      getRecentAttemptsForAccount(
        tx,
        {
          billing_account_id: ownerA.billingAccountId,
          mode: "all",
          outcome: "placed",
          limit: 1,
        },
        ownerA.billingAccountId,
      ),
    );
    expect(page?.attempts.length).toBe(1);
    expect(page?.attempts[0]?.decision.outcome).toBe("placed");
  });

  it("recent-attempts: a cross-tenant read returns no tape", async () => {
    const leaked = await asTx(ownerB.userId, (tx) =>
      getRecentAttemptsForAccount(
        tx,
        {
          billing_account_id: ownerA.billingAccountId,
          mode: "all",
          outcome: "all",
          limit: 50,
        },
        ownerA.billingAccountId,
      ),
    );
    expect(leaked).toBeNull();

    // Non-vacuous: B's own tape is non-empty.
    const own = await asTx(ownerB.userId, (tx) =>
      getRecentAttemptsForAccount(
        tx,
        {
          billing_account_id: ownerB.billingAccountId,
          mode: "all",
          outcome: "all",
          limit: 50,
        },
        ownerB.billingAccountId,
      ),
    );
    expect(own?.attempts.length).toBe(1);
    expect(own?.attempts[0]?.attempt_id).toBe(decisionB);
    expect(own?.attempts[0]?.algorithm).toMatchObject({
      availability: "observed",
      algorithm_id: "poly.copy-mirror.min-bet",
      correlation_id: `coid-${FILL_B}`,
    });
    expect(Object.keys(own?.attempts[0] ?? {}).sort()).toEqual(
      [
        "algorithm",
        "attempt_id",
        "decided_at",
        "decision",
        "executed",
        "fill_id",
        "intended",
        "mark",
        "market_id",
        "market_title",
        "mode",
        "outcome_label",
        "outcome_resolution",
        "target_id",
        "target_wallet",
      ].sort(),
    );
  });
});

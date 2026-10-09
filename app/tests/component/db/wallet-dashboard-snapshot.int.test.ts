// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real-Postgres coherence, component isolation, preview, and tenant bounds. */
import { randomUUID } from "node:crypto";
import {
  polyTraderCurrentPositions,
  polyTraderFills,
  polyTraderIngestionCursors,
  polyTraderPositionSnapshots,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  billingAccounts,
  polyCopyTradeFills,
  polyCopyTradeTargets,
  polyWalletBalanceSnapshots,
  polyWalletConnections,
  users,
} from "@/shared/db/schema";
import { readTenantWalletDashboard } from "@/features/wallet-analysis/server/tenant-wallet-dashboard-service";
import {
  buildBoundedMarketExposureWithCoverage,
  buildBoundedMarketExposureGroups,
  buildMarketExposureGroups,
} from "@/features/wallet-analysis/server/market-exposure-service";
import { readWalletBalanceFact } from "@/features/wallet-analysis/server/wallet-balance-snapshot-service";
import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";

const USER_A = `dashboard-snapshot-user-a-${randomUUID()}`;
const USER_B = `dashboard-snapshot-user-b-${randomUUID()}`;
const TENANT_A = `dashboard-snapshot-a-${randomUUID()}`;
const TENANT_B = `dashboard-snapshot-b-${randomUUID()}`;
const OUR_A = `0x${"a1".repeat(20)}`;
const OUR_B = `0x${"b1".repeat(20)}`;
const TARGET_A = `0x${"a2".repeat(20)}`;
const TARGET_B = `0x${"b2".repeat(20)}`;
const TARGET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type SeededWallet = { id: string; address: string };

async function seedConnection(input: {
  userId: string;
  billingAccountId: string;
  address: string;
}): Promise<SeededWallet> {
  const db = getSeedDb();
  await db.insert(users).values({
    id: input.userId,
    name: input.userId,
    walletAddress: input.address,
  });
  await db.insert(billingAccounts).values({
    id: input.billingAccountId,
    ownerUserId: input.userId,
    balanceCredits: 0n,
  });
  await db.insert(polyWalletConnections).values({
    billingAccountId: input.billingAccountId,
    createdByUserId: input.userId,
    privyWalletId: `privy-${input.billingAccountId}`,
    address: input.address,
    funderAddress: input.address,
    clobApiKeyCiphertext: Buffer.from("component-test"),
    encryptionKeyId: "component-test",
    custodialConsentAcceptedAt: new Date(),
    custodialConsentActorKind: "user",
    custodialConsentActorId: input.userId,
  });
  await db.insert(polyWalletBalanceSnapshots).values({
    billingAccountId: input.billingAccountId,
    address: input.address,
    usdcE: "10",
    pusd: "5",
    pol: "1",
    status: "ok",
    errors: [],
    observedAt: new Date(),
  });
  const [wallet] = await db
    .insert(polyTraderWallets)
    .values({ walletAddress: input.address, kind: "cogni_wallet", label: input.userId })
    .returning({ id: polyTraderWallets.id, address: polyTraderWallets.walletAddress });
  if (!wallet) throw new Error("wallet seed failed");
  await db.insert(polyTraderIngestionCursors).values({
    traderWalletId: wallet.id,
    source: "data-api-positions",
    status: "ok",
    lastSuccessAt: new Date(),
  });
  return wallet;
}

function currentPosition(walletId: string, index: number, conditionId = `condition-${index}`) {
  return {
    traderWalletId: walletId,
    conditionId,
    tokenId: `token-${walletId}-${index}`,
    shares: "2",
    costBasisUsdc: "1",
    currentValueUsdc: "2",
    avgPrice: "0.5",
    contentHash: `hash-${walletId}-${index}`,
    lastObservedAt: new Date(),
    firstObservedAt: new Date(),
    raw: {
      title: `Market ${index}`,
      eventTitle: `Event ${index}`,
      eventSlug: `event-${index}`,
      slug: `market-${index}`,
      outcome: "Yes",
      curPrice: "1",
    },
  };
}

describe("wallet dashboard coherent snapshot", () => {
  const db = getSeedDb();
  let walletA: SeededWallet;
  let walletB: SeededWallet;
  let tenantATargetId = "";
  let tenantBTargetId = "";
  const targetWalletIds: string[] = [];
  const boundedTargetWallets: Array<{ id: string; address: string }> = [];

  beforeAll(async () => {
    walletA = await seedConnection({ userId: USER_A, billingAccountId: TENANT_A, address: OUR_A });
    walletB = await seedConnection({ userId: USER_B, billingAccountId: TENANT_B, address: OUR_B });

    await db.insert(polyTraderCurrentPositions).values(
      Array.from({ length: 501 }, (_, index) => ({
        ...currentPosition(walletA.id, index),
        // condition-0 is the market shared with Tenant A's target snapshot.
        // Rank it above the 500 equal-valued preview rows so this isolation
        // assertion never depends on PostgreSQL's ordering of an unresolved tie.
        ...(index === 0 ? { shares: "3", currentValueUsdc: "3" } : {}),
      }))
    );
    await db.insert(polyCopyTradeFills).values(
      Array.from({ length: 31 }, (_, index) => ({
        billingAccountId: TENANT_A,
        createdByUserId: USER_A,
        targetId: TARGET_ID,
        fillId: `closed-${index}`,
        marketId: `closed-condition-${index}`,
        observedAt: new Date(Date.now() - index * 1_000),
        clientOrderId: `closed-client-${index}`,
        status: "filled",
        positionLifecycle: "closed",
        attributes: {
          condition_id: `closed-condition-${index}`,
          token_id: `closed-token-${index}`,
          side: "BUY",
          limit_price: "0.5",
          size_usdc: "1",
          filled_size_usdc: "1",
          closed_at: new Date(Date.now() - index * 1_000).toISOString(),
        },
      }))
    );

    const targets = await db
      .insert(polyTraderWallets)
      .values([
        { walletAddress: TARGET_A, kind: "copy_target", label: "Tenant A target" },
        { walletAddress: TARGET_B, kind: "copy_target", label: "Tenant B target" },
      ])
      .returning({ id: polyTraderWallets.id, address: polyTraderWallets.walletAddress });
    targetWalletIds.push(...targets.map((row) => row.id));
    tenantATargetId =
      targets.find((row) => row.address === TARGET_A)?.id ?? "";
    tenantBTargetId =
      targets.find((row) => row.address === TARGET_B)?.id ?? "";
    await db.insert(polyCopyTradeTargets).values([
      { billingAccountId: TENANT_A, createdByUserId: USER_A, targetWallet: TARGET_A },
      { billingAccountId: TENANT_B, createdByUserId: USER_B, targetWallet: TARGET_B },
    ]);
    await db.insert(polyTraderPositionSnapshots).values(
      targets.map((target) => ({
        traderWalletId: target.id,
        conditionId: "condition-0",
        tokenId: `token-${
          target.address === TARGET_A ? walletA.id : walletB.id
        }-0`,
        shares: "4",
        costBasisUsdc: "2",
        currentValueUsdc: "3",
        avgPrice: "0.5",
        contentHash: `target-hash-${target.id}`,
        capturedAt: new Date(),
        raw: { title: "Market 0", eventSlug: "event-0", outcome: "Yes" },
      }))
    );
    await db.insert(polyTraderCurrentPositions).values(
      targets.map((target) => ({
        traderWalletId: target.id,
        conditionId: "condition-0",
        tokenId: `token-${
          target.address === TARGET_A ? walletA.id : walletB.id
        }-0`,
        active: true,
        shares: "4",
        costBasisUsdc: "2",
        currentValueUsdc: "3",
        avgPrice: "0.5",
        contentHash: `target-hash-${target.id}`,
        lastObservedAt: new Date(),
        raw: { title: "Market 0", eventSlug: "event-0", outcome: "Yes" },
      }))
    );

    const boundedTargets = await db
      .insert(polyTraderWallets)
      .values(
        Array.from({ length: 11 }, (_, index) => ({
          walletAddress: `0x${(0xc000 + index).toString(16).padStart(40, "0")}`,
          kind: "copy_target",
          label: `Bounded target ${index}`,
        }))
      )
      .returning({ id: polyTraderWallets.id, address: polyTraderWallets.walletAddress });
    boundedTargetWallets.push(...boundedTargets);
    targetWalletIds.push(...boundedTargets.map((row) => row.id));
    await db.insert(polyCopyTradeTargets).values(
      boundedTargets.map((target) => ({
        billingAccountId: TENANT_A,
        createdByUserId: USER_A,
        targetWallet: target.address,
      }))
    );
    const boundedSnapshots = boundedTargets.flatMap((target, targetIndex) =>
      Array.from({ length: targetIndex === 10 ? 1 : 171 }, (_, conditionIndex) => ({
        traderWalletId: target.id,
        conditionId: `bounded-condition-${conditionIndex}`,
        tokenId: `bounded-token-${targetIndex}-${conditionIndex}-yes`,
        shares: "4",
        costBasisUsdc: "2",
        currentValueUsdc: "3",
        avgPrice: "0.5",
        contentHash: `bounded-${targetIndex}-${conditionIndex}-yes`,
        capturedAt: new Date(),
        raw: {
          title: `Bounded market ${conditionIndex}`,
          eventSlug: `bounded-event-${conditionIndex % 200}`,
          outcome: "Yes",
        },
      }))
    );
    boundedSnapshots.push({
      traderWalletId: boundedTargets[0]!.id,
      conditionId: "bounded-condition-0",
      tokenId: "bounded-token-0-0-no",
      shares: "2",
      costBasisUsdc: "1",
      currentValueUsdc: "1.2",
      avgPrice: "0.5",
      contentHash: "bounded-0-0-no",
      capturedAt: new Date(),
      raw: { title: "Bounded market 0", eventSlug: "bounded-event-0", outcome: "No" },
    });
    await db.insert(polyTraderPositionSnapshots).values(boundedSnapshots);
    await db.insert(polyTraderCurrentPositions).values(
      boundedSnapshots.map((snapshot) => ({
        traderWalletId: snapshot.traderWalletId,
        conditionId: snapshot.conditionId,
        tokenId: snapshot.tokenId,
        active: true,
        shares: snapshot.shares,
        costBasisUsdc: snapshot.costBasisUsdc,
        currentValueUsdc: snapshot.currentValueUsdc,
        avgPrice: snapshot.avgPrice,
        contentHash: snapshot.contentHash,
        lastObservedAt: new Date(),
        raw: snapshot.raw,
      }))
    );
    await db.insert(polyTraderFills).values({
      traderWalletId: boundedTargets[0]!.id,
      source: "data-api",
      nativeId: "bounded-gross-buy",
      conditionId: "bounded-condition-0",
      tokenId: "bounded-token-0-0-yes",
      side: "BUY",
      price: "0.5",
      shares: "18",
      sizeUsdc: "9",
      observedAt: new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    await db.delete(polyCopyTradeTargets).where(inArray(polyCopyTradeTargets.billingAccountId, [TENANT_A, TENANT_B]));
    await db.delete(polyCopyTradeFills).where(inArray(polyCopyTradeFills.billingAccountId, [TENANT_A, TENANT_B]));
    await db.delete(billingAccounts).where(inArray(billingAccounts.id, [TENANT_A, TENANT_B]));
    await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
    await db.delete(polyTraderWallets).where(inArray(polyTraderWallets.id, [walletA.id, walletB.id, ...targetWalletIds]));
  });

  it("returns exact 501/31 counts with independently bounded 500/30 previews", async () => {
    const result = await readTenantWalletDashboard({
      db,
      billingAccountId: TENANT_A,
      interval: "1W",
      adapterConfigured: true,
    });
    expect(result.execution.live_position_count).toBe(501);
    expect(result.execution.live_positions).toHaveLength(500);
    expect(result.execution.closed_position_count).toBe(31);
    expect(result.execution.closed_positions).toHaveLength(30);
    expect(result.facts.positions.status).toBe("fresh");
    expect(result.facts.history.status).toBe("partial");
    expect(result.execution.warnings.map((entry) => entry.code)).toContain("positions_preview_truncated");
    expect(result.execution.warnings.map((entry) => entry.code)).toContain("realized_pnl_incomplete");
    expect(result.execution.comparisonCoverage.positions.live).toEqual({
      eligible: 501,
      comparable: 1,
      dropped: 500,
      sampled: 0,
      complete: false,
      reasons: [
        "source_incomplete",
        "comparison_missing",
        "preview_truncated",
      ],
    });
    expect(result.execution.comparisonCoverage.positions.closed).toEqual({
      eligible: 31,
      comparable: 0,
      dropped: 31,
      sampled: 0,
      complete: false,
      reasons: [
        "source_incomplete",
        "comparison_missing",
        "preview_truncated",
      ],
    });
    expect(
      result.execution.comparisonCoverage.positionClassifications
    ).toContainEqual({
      conditionId: "condition-0",
      tokenId: `token-${walletA.id}-0`,
      status: "live",
      result: "comparable",
    });
    expect(result.execution.comparisonCoverage.markets.live.eligible).toBe(501);
  }, 60_000);

  it("rolls back a forced cash SQL error to its savepoint and keeps later facts readable", async () => {
    const result = await readTenantWalletDashboard({
      db,
      billingAccountId: TENANT_A,
      interval: "1W",
      adapterConfigured: true,
      readBalance: async (savepoint) => {
        await savepoint.execute(sql.raw("SELECT dashboard_missing_column FROM poly_wallet_balance_snapshots"));
        throw new Error("unreachable");
      },
    });
    expect(result.facts.cash.status).toBe("unavailable");
    expect(result.overview.usdc_total).toBeNull();
    expect(result.execution.live_position_count).toBe(501);
    expect(result.execution.closed_position_count).toBe(31);
    expect(result.warnings.map((entry) => entry.code)).toContain("balances_unavailable");
  });

  it("keeps historical facts visible but disables actions when the adapter is unconfigured", async () => {
    const result = await readTenantWalletDashboard({
      db,
      billingAccountId: TENANT_A,
      interval: "1W",
      adapterConfigured: false,
    });
    expect(result.overview.configured).toBe(false);
    expect(result.execution.live_position_count).toBe(501);
    expect(result.execution.live_positions).toHaveLength(500);
    expect(result.facts.positions.actionsAllowed).toBe(false);
    expect(result.warnings.map((entry) => entry.code)).toContain(
      "wallet_adapter_unconfigured"
    );
    expect(result.execution.warnings.map((entry) => entry.code)).toContain(
      "wallet_adapter_unconfigured"
    );
  }, 60_000);

  it("holds one repeatable-read snapshot while a concurrent writer commits", async () => {
    let release!: () => void;
    let observed!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { observed = resolve; });
    const read = readTenantWalletDashboard({
      db,
      billingAccountId: TENANT_B,
      interval: "1W",
      adapterConfigured: true,
      readBalance: async (savepoint, billingAccountId) => {
        const balance = await readWalletBalanceFact(savepoint, billingAccountId);
        observed();
        await pause;
        return balance;
      },
    });
    await started;
    await db.insert(polyTraderCurrentPositions).values(
      currentPosition(walletB.id, 0, "condition-0")
    );
    release();
    const during = await read;
    expect(during.execution.live_position_count).toBe(0);

    const after = await readTenantWalletDashboard({ db, billingAccountId: TENANT_B, interval: "1W", adapterConfigured: true });
    expect(after.execution.live_position_count).toBe(1);
  });

  it("isolates colliding connection/current/market facts by tenant", async () => {
    const [tenantA, tenantB] = await Promise.all([
      readTenantWalletDashboard({ db, billingAccountId: TENANT_A, interval: "1W", adapterConfigured: true }),
      readTenantWalletDashboard({ db, billingAccountId: TENANT_B, interval: "1W", adapterConfigured: true }),
    ]);
    expect(tenantA.overview.address).toBe(OUR_A);
    expect(tenantB.overview.address).toBe(OUR_B);
    expect(tenantA.execution.live_position_count).toBe(501);
    expect(tenantB.execution.live_position_count).toBe(1);
    const labelsA = tenantA.execution.market_groups.flatMap((group) => group.lines.flatMap((line) => line.participants.map((participant) => participant.label)));
    const labelsB = tenantB.execution.market_groups.flatMap((group) => group.lines.flatMap((line) => line.participants.map((participant) => participant.label)));
    expect(labelsA).toContain("Tenant A target");
    expect(labelsA).not.toContain("Tenant B target");
    expect(labelsB).toContain("Tenant B target");
    expect(labelsB).not.toContain("Tenant A target");

    const finiteGroups = tenantB.execution.market_groups.filter(
      (group) => group.edgeGapPct !== null && Number.isFinite(group.edgeGapPct)
    );
    const finiteLines = new Set(
      tenantB.execution.market_groups.flatMap((group) =>
        group.lines
          .filter(
            (line) =>
              line.edgeGapPct !== null && Number.isFinite(line.edgeGapPct)
          )
          .map((line) => line.conditionId)
      )
    );
    const comparablePositions = tenantB.execution.live_positions.filter(
      (position) => finiteLines.has(position.conditionId)
    );
    expect(tenantB.execution.comparisonCoverage.markets.live).toMatchObject({
      eligible: tenantB.execution.market_groups.length,
      comparable: finiteGroups.length,
      sampled: finiteGroups.length,
      complete: true,
      reasons: [],
    });
    expect(tenantB.execution.comparisonCoverage.positions.live).toMatchObject({
      eligible: tenantB.execution.live_position_count,
      comparable: comparablePositions.length,
      sampled: comparablePositions.length,
      complete: true,
      reasons: [],
    });
  });

  it("suppresses inactive and stale target current facts for live local rows", async () => {
    const targetPosition = and(
      eq(polyTraderCurrentPositions.traderWalletId, tenantATargetId),
      eq(polyTraderCurrentPositions.conditionId, "condition-0")
    );
    const readDashboard = async () =>
      readTenantWalletDashboard({
        db,
        billingAccountId: TENANT_A,
        interval: "1W",
        adapterConfigured: true,
      });
    const expectLiveTargetSuppressed = async () => {
      const dashboard = await readDashboard();
      const labels = dashboard.execution.market_groups.flatMap((group) =>
        group.lines.flatMap((line) =>
          line.participants.map((participant) => participant.label)
        )
      );
      expect(labels).not.toContain("Tenant A target");
      expect(dashboard.execution.comparisonCoverage.positions.live).toMatchObject({
        eligible: 501,
        comparable: 0,
      });
      expect(
        dashboard.execution.comparisonCoverage.positionClassifications
      ).toContainEqual({
        conditionId: "condition-0",
        tokenId: `token-${walletA.id}-0`,
        status: "live",
        result: "no_target_position",
      });
    };

    try {
      await db
        .update(polyTraderCurrentPositions)
        .set({ active: false, lastObservedAt: new Date() })
        .where(targetPosition);
      await expectLiveTargetSuppressed();

      await db
        .update(polyTraderCurrentPositions)
        .set({
          active: true,
          lastObservedAt: new Date(Date.now() - 7 * 60 * 60_000),
        })
        .where(targetPosition);
      await expectLiveTargetSuppressed();
    } finally {
      await db
        .update(polyTraderCurrentPositions)
        .set({ active: true, lastObservedAt: new Date() })
        .where(targetPosition);
    }
  }, 60_000);

  it("keeps an exact saved target snapshot comparable for a closed local row", async () => {
    const contentHash = `closed-target-${randomUUID()}`;
    await db.insert(polyTraderPositionSnapshots).values({
      traderWalletId: tenantATargetId,
      conditionId: "closed-condition-0",
      tokenId: "closed-token-0",
      shares: "4",
      costBasisUsdc: "2",
      currentValueUsdc: "3",
      avgPrice: "0.5",
      contentHash,
      capturedAt: new Date(),
      raw: {
        title: "Closed market 0",
        eventSlug: "closed-event-0",
        outcome: "Yes",
      },
    });

    try {
      const targetCurrent = await db
        .select({ tokenId: polyTraderCurrentPositions.tokenId })
        .from(polyTraderCurrentPositions)
        .where(
          and(
            eq(polyTraderCurrentPositions.traderWalletId, tenantATargetId),
            eq(
              polyTraderCurrentPositions.conditionId,
              "closed-condition-0"
            ),
            eq(polyTraderCurrentPositions.tokenId, "closed-token-0")
          )
        );
      expect(targetCurrent).toEqual([]);

      const dashboard = await readTenantWalletDashboard({
        db,
        billingAccountId: TENANT_A,
        interval: "1W",
        adapterConfigured: true,
      });
      expect(
        dashboard.execution.comparisonCoverage.positionClassifications
      ).toContainEqual({
        conditionId: "closed-condition-0",
        tokenId: "closed-token-0",
        status: "closed",
        result: "comparable",
      });
      const closedPosition = dashboard.execution.closed_positions.find(
        (position) => position.conditionId === "closed-condition-0"
      );
      expect(closedPosition).toBeDefined();
      const bounded = await buildBoundedMarketExposureWithCoverage({
        db,
        billingAccountId: TENANT_A,
        walletAddress: OUR_A,
        livePositions: [],
        closedPositions: [closedPosition!],
      });
      expect(bounded.positionClassifications).toContainEqual({
        conditionId: "closed-condition-0",
        tokenId: "closed-token-0",
        status: "closed",
        result: "comparable",
      });
      const line = bounded.market.groups
        .flatMap((group) => group.lines)
        .find((candidate) => candidate.conditionId === "closed-condition-0");
      expect(line).toMatchObject({
        status: "closed",
        targetEntryValueUsdc: 2,
        targetValueUsdc: 3,
      });
      expect(
        line?.participants.some(
          (participant) => participant.label === "Tenant A target"
        )
      ).toBe(true);
    } finally {
      await db
        .delete(polyTraderPositionSnapshots)
        .where(eq(polyTraderPositionSnapshots.contentHash, contentHash));
    }
  }, 60_000);

  it("marks history partial while terminal Position-gap accounting is pending", async () => {
    const fillId = `pg-history-pending-${randomUUID()}`;
    await db.insert(polyCopyTradeFills).values({
      billingAccountId: TENANT_B,
      createdByUserId: USER_B,
      targetId: TARGET_ID,
      fillId,
      marketId: "prediction-market:polymarket:pg-history-pending",
      observedAt: new Date(),
      clientOrderId: `pg-history-pending-client-${randomUUID()}`,
      status: "filled",
      positionLifecycle: "loser",
      price: "0.386",
      shares: "9.3",
      attributes: {
        condition_id: "pg-history-pending",
        token_id: "pg-history-pending-token",
        size_usdc: 3.5898,
        filled_size_usdc: 3.5898,
        position_gap_version: "3",
        closed_at: new Date().toISOString(),
      },
    });
    try {
      const dashboard = await readTenantWalletDashboard({
        db,
        billingAccountId: TENANT_B,
        interval: "1W",
        adapterConfigured: true,
      });
      expect(dashboard.execution.closed_position_count).toBe(1);
      expect(dashboard.execution.closed_positions).toEqual([]);
      expect(dashboard.facts.history).toMatchObject({
        status: "partial",
        complete: false,
      });
      expect(dashboard.warnings).toContainEqual(
        expect.objectContaining({
          component: "history",
          code: "history_fill_accounting_pending",
        })
      );
    } finally {
      await db.delete(polyCopyTradeFills).where(eq(polyCopyTradeFills.fillId, fillId));
    }
  }, 60_000);

  it("dedupes canonical condition siblings and fails their coverage closed", async () => {
    await db.insert(polyTraderCurrentPositions).values([
      currentPosition(walletB.id, 910, "Case-Duplicate"),
      {
        ...currentPosition(walletB.id, 911, "case-duplicate"),
        tokenId: `token-${walletB.id}-910`,
        contentHash: `hash-${walletB.id}-911-case-variant`,
      },
    ]);
    await db.insert(polyTraderPositionSnapshots).values({
      traderWalletId: tenantBTargetId,
      conditionId: "case-duplicate",
      tokenId: "target-case-duplicate",
      shares: "2",
      costBasisUsdc: "1",
      currentValueUsdc: "2",
      avgPrice: "0.5",
      contentHash: "target-case-duplicate",
      capturedAt: new Date(),
      raw: { title: "Case duplicate", outcome: "Yes" },
    });

    try {
      const result = await readTenantWalletDashboard({
        db,
        billingAccountId: TENANT_B,
        interval: "1W",
        adapterConfigured: true,
      });
      expect(
        result.execution.live_positions.filter(
          (position) => position.conditionId === "case-duplicate"
        )
      ).toHaveLength(1);
      expect(result.execution.comparisonCoverage.positions.live.reasons).toContain(
        "identity_ambiguous"
      );
    } finally {
      await db
        .delete(polyTraderCurrentPositions)
        .where(
          and(
            eq(polyTraderCurrentPositions.traderWalletId, walletB.id),
            inArray(polyTraderCurrentPositions.conditionId, [
              "Case-Duplicate",
              "case-duplicate",
            ])
          )
        );
      await db
        .delete(polyTraderPositionSnapshots)
        .where(eq(polyTraderPositionSnapshots.contentHash, "target-case-duplicate"));
    }
  });

  it("detects duplicate canonical wallet identities without duplicating output", async () => {
    const canonicalSibling = `0x${OUR_B.slice(2).toUpperCase()}`;
    const [duplicate] = await db
      .insert(polyTraderWallets)
      .values({
        walletAddress: canonicalSibling,
        kind: "cogni_wallet",
        label: "duplicate canonical wallet",
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      })
      .returning({ id: polyTraderWallets.id });
    if (!duplicate) throw new Error("duplicate wallet seed failed");

    try {
      const result = await readTenantWalletDashboard({
        db,
        billingAccountId: TENANT_B,
        interval: "1W",
        adapterConfigured: true,
      });
      expect(result.execution.live_position_count).toBe(1);
      expect(result.execution.live_positions).toHaveLength(1);
      expect(result.execution.comparisonCoverage.positions.live.reasons).toContain(
        "identity_ambiguous"
      );
      expect(result.facts.positions.status).toBe("partial");
      expect(result.facts.positions.complete).toBe(false);
      expect(result.facts.positions.actionsAllowed).toBe(false);
      expect(result.facts.history.status).toBe("partial");
      expect(result.facts.history.complete).toBe(false);
      expect(result.overview.usdc_total).toBeNull();
      expect(result.execution.warnings).toContainEqual(
        expect.objectContaining({ code: "realized_pnl_identity_ambiguous" })
      );
    } finally {
      await db.delete(polyTraderWallets).where(eq(polyTraderWallets.id, duplicate.id));
    }
  });

  it("enforces bounded market SQL before hydration with fresh target facts", async () => {
    const positions: WalletExecutionPosition[] = Array.from({ length: 500 }, (_, index) => ({
      positionId: `bounded-condition-${index}:our-${index}`,
      conditionId: `bounded-condition-${index}`,
      asset: `our-${index}`,
      marketTitle: `Bounded market ${index}`,
      eventTitle: `Bounded event ${index % 200}`,
      marketSlug: `bounded-market-${index}`,
      eventSlug: `bounded-event-${index % 200}`,
      marketUrl: null,
      outcome: "Yes",
      status: "open",
      lifecycleState: "open",
      openedAt: new Date().toISOString(),
      closedAt: null,
      resolvesAt: null,
      gameStartTime: null,
      heldMinutes: 0,
      entryPrice: 0.5,
      currentPrice: 0.6,
      size: 2,
      currentValue: 1.2,
      pnlUsd: 0.2,
      pnlPct: 20,
      syncedAt: new Date().toISOString(),
      syncAgeMs: 0,
      syncStale: false,
      timeline: [],
      events: [],
    }));
    const bounded = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: TENANT_A,
      walletAddress: OUR_A,
      livePositions: positions,
    });
    const participants = bounded.groups.flatMap((group) =>
      group.lines.flatMap((line) => line.participants)
    );
    expect(bounded.groups.length).toBeLessThanOrEqual(200);
    expect(participants).toHaveLength(2_200);
    expect(bounded.truncated).toBe(true);
    for (const group of bounded.groups) {
      const targetRows = group.lines.flatMap((line) => line.participants).filter((row) => row.side === "copy_target");
      expect(targetRows.length).toBeLessThanOrEqual(10);
    }
    const pivotLine = bounded.groups
      .flatMap((group) => group.lines)
      .find((line) => line.conditionId === "bounded-condition-0");
    const pivot = pivotLine?.participants.find(
      (row) => row.label === "Bounded target 0" && row.conditionId === "bounded-condition-0"
    );
    expect(pivot?.primary?.lifecycle).toBe("active");
    expect(pivot?.hedge).not.toBeNull();
    expect(pivotLine?.targetGrossBuyNotionalUsdc).not.toBe(
      pivotLine?.targetEntryValueUsdc
    );

    const one = [{
      ...positions[0]!,
      positionId: "condition-0:our-parity",
      conditionId: "condition-0",
      asset: "our-parity",
      eventSlug: "event-0",
    }];
    const defaultRead = await buildMarketExposureGroups({
      db,
      billingAccountId: TENANT_B,
      walletAddress: OUR_B,
      livePositions: one,
    });
    const boundedRead = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: TENANT_B,
      walletAddress: OUR_B,
      livePositions: one,
    });
    expect(boundedRead.truncated).toBe(false);
    expect(boundedRead.groups).toEqual(defaultRead);
  }, 60_000);

  it("distinguishes observed zero, partial, stale, and never-observed without false totals", async () => {
    const cursor = and(
      eq(polyTraderIngestionCursors.traderWalletId, walletB.id),
      eq(polyTraderIngestionCursors.source, "data-api-positions")
    );
    await db
      .update(polyTraderCurrentPositions)
      .set({ active: false })
      .where(eq(polyTraderCurrentPositions.traderWalletId, walletB.id));
    const zero = await readTenantWalletDashboard({ db, billingAccountId: TENANT_B, interval: "1W", adapterConfigured: true });
    expect(zero.execution.live_position_count).toBe(0);
    expect(zero.execution.live_positions).toEqual([]);
    expect(zero.overview.usdc_positions_mtm).toBe(0);
    expect(zero.facts.positions.status).toBe("fresh");
    expect(zero.facts.positions.actionsAllowed).toBe(true);

    await db
      .update(polyTraderCurrentPositions)
      .set({ active: true, lastObservedAt: new Date() })
      .where(eq(polyTraderCurrentPositions.traderWalletId, walletB.id));
    await db
      .update(polyTraderIngestionCursors)
      .set({ status: "partial", lastSuccessAt: new Date() })
      .where(cursor);
    const partial = await readTenantWalletDashboard({ db, billingAccountId: TENANT_B, interval: "1W", adapterConfigured: true });
    expect(partial.facts.positions.status).toBe("partial");
    expect(partial.facts.positions.actionsAllowed).toBe(false);
    expect(partial.execution.live_position_count).toBe(1);
    expect(partial.execution.live_positions).toHaveLength(1);
    expect(partial.execution.market_groups.length).toBeGreaterThan(0);
    expect(partial.facts.markets.status).toBe("partial");
    expect(partial.execution.comparisonCoverage.positions.live.reasons).toContain(
      "source_incomplete"
    );
    // bug.5031: a non-fresh positions fact must not emit a dollar MTM. The
    // exact count is retained for the execution card, but the money figure is
    // unknown — never a number summed over a frozen/partial inventory.
    expect(partial.overview.usdc_positions_mtm).toBeNull();
    expect(partial.overview.usdc_total).toBeNull();

    await db
      .update(polyTraderIngestionCursors)
      .set({ status: "ok", lastSuccessAt: new Date(Date.now() - 11 * 60_000) })
      .where(cursor);
    const stale = await readTenantWalletDashboard({ db, billingAccountId: TENANT_B, interval: "1W", adapterConfigured: true });
    expect(stale.facts.positions.status).toBe("stale");
    expect(stale.facts.positions.actionsAllowed).toBe(false);
    expect(stale.execution.live_position_count).toBe(1);
    expect(stale.execution.live_positions).toHaveLength(1);
    expect(stale.execution.market_groups.length).toBeGreaterThan(0);
    expect(stale.facts.markets.status).toBe("stale");
    // bug.5031: the stalled-observer case the dashboard actually hit in prod —
    // the frozen inventory's MTM is withheld (null), not a misleading stale
    // number, and the composite total stays null.
    expect(stale.overview.usdc_positions_mtm).toBeNull();
    expect(stale.overview.usdc_total).toBeNull();

    await db.delete(polyTraderIngestionCursors).where(cursor);
    const unavailable = await readTenantWalletDashboard({ db, billingAccountId: TENANT_B, interval: "1W", adapterConfigured: true });
    expect(unavailable.facts.positions.status).toBe("unavailable");
    expect(unavailable.execution.live_position_count).toBeNull();
    expect(unavailable.execution.live_positions).toEqual([]);
    expect(unavailable.execution.market_groups).toEqual([]);
    expect(unavailable.execution.comparisonCoverage.positions.live).toEqual({
      eligible: null,
      comparable: null,
      dropped: null,
      sampled: null,
      complete: false,
      reasons: ["source_unavailable"],
    });
    expect(unavailable.overview.usdc_positions_mtm).toBeNull();
    expect(unavailable.overview.usdc_total).toBeNull();
  });
});

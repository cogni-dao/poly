// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real-Postgres coherence, component isolation, preview, and tenant bounds. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TransactionReceipt } from "viem";
import type { PolymarketActivityV2, PolymarketDataApiClient, PolymarketUserPosition, PolymarketUserPositionV2 } from "@cogni/poly-market-provider/adapters/polymarket";
import { buildEconomicObservations, verifyEconomicSettlement } from "@/features/wallet-analysis/server/economic-observation-recovery";
import {
  polyMarketOutcomes,
  polyTraderCurrentPositions,
  polyTraderFills,
  polyTraderIngestionCursors,
  polyTraderPositionSnapshots,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { seedNativePaperConnection, seedNativePaperFill } from "./native-paper-receipt.fixture";
import { derivePaperAccountAddress } from "@/features/paper-accounts";
import { type SQL, and, eq, inArray, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { PAPER_POSITION_CURSOR_SOURCE, observePaperWallet } from "@/features/wallet-analysis/server/paper-fact-source";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  billingAccounts,
  polyCopyTradeFills,
  polyCopyTradeTargets,
  polyWalletBalanceSnapshots,
  polyWalletConnections,
  users,
} from "@/shared/db/schema";
import { readEconomicPositionProjection } from "@/features/wallet-analysis/server/economic-position-read-model";
import { readTenantWalletDashboard } from "@/features/wallet-analysis/server/tenant-wallet-dashboard-service";
import {
  buildBoundedMarketExposureWithCoverage,
  buildBoundedMarketExposureGroups,
  buildMarketExposureGroups,
} from "@/features/wallet-analysis/server/market-exposure-service";
import { readWalletBalanceFact } from "@/features/wallet-analysis/server/wallet-balance-snapshot-service";
import {
  PositionBalanceTransportError,
  PositionObservationController,
  refreshCurrentPositionsForWallet,
} from "@/features/wallet-analysis/server/trader-observation-service";
import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";

const USER_A = `dashboard-snapshot-user-a-${randomUUID()}`;
const USER_B = `dashboard-snapshot-user-b-${randomUUID()}`;
const TENANT_A = `dashboard-snapshot-a-${randomUUID()}`;
const TENANT_B = `dashboard-snapshot-b-${randomUUID()}`;
const OUR_A = `0x${"a1".repeat(20)}`;
const OUR_B = `0x${"b1".repeat(20)}`;
const TARGET_A = `0x${"a2".repeat(20)}`;
const TARGET_B = `0x${"b2".repeat(20)}`;
const boundedCondition = (index: number) => `0x${(0xb000 + index).toString(16).padStart(64, "0")}`;
const boundedToken = (target: number, index: number) => String(100000 + target * 1000 + index * 2);
const TARGET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type SeededWallet = { id: string; address: string };

async function seedConnection(input: {
  userId: string;
  billingAccountId: string;
  address: string;
  mode?: "live" | "paper";
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
  if (input.mode === "paper") {
    await seedNativePaperConnection(input, "100");
  } else {
    await db.insert(polyWalletConnections).values({
      billingAccountId: input.billingAccountId,
      createdByUserId: input.userId,
      kind: "privy_live",
      paperSeedUsdc: null,
      privyWalletId: `privy-${input.billingAccountId}`,
      address: input.address,
      funderAddress: input.address,
      clobApiKeyCiphertext: Buffer.from("component-test"),
      encryptionKeyId: "component-test",
      custodialConsentAcceptedAt: new Date(),
      custodialConsentActorKind: "user",
      custodialConsentActorId: input.userId,
    });
  }
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
    .values({ walletAddress: input.address, kind: input.mode === "paper" ? "paper_wallet" : "cogni_wallet", label: input.userId })
    .returning({ id: polyTraderWallets.id, address: polyTraderWallets.walletAddress });
  if (!wallet) throw new Error("wallet seed failed");
  await db.insert(polyTraderIngestionCursors).values({
    traderWalletId: wallet.id,
    source: input.mode === "paper" ? PAPER_POSITION_CURSOR_SOURCE : "data-api-positions",
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
        // Its deliberately tiny value would fall outside the 500-position and
        // 200-market previews unless exact target correlation wins the rank.
        ...(index === 0 ? { shares: "0.5", currentValueUsdc: "0.25" } : {}),
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
    // The authoritative closed projection is driven by canonical wallet
    // economics, not order lifecycle. Each historical leg is a true full exit.
    await db.insert(polyTraderFills).values(
      Array.from({ length: 31 }, (_, index) => [
        {
          traderWalletId: walletA.id,
          source: "data-api" as const,
          nativeId: `closed-buy-${index}`,
          conditionId: `closed-condition-${index}`,
          tokenId: `closed-token-${index}`,
          side: "BUY" as const,
          price: "0.5",
          shares: "2",
          sizeUsdc: "1",
          observedAt: new Date(Date.now() - index * 1_000 - 500),
        },
        {
          traderWalletId: walletA.id,
          source: "data-api" as const,
          nativeId: `closed-sell-${index}`,
          conditionId: `closed-condition-${index}`,
          tokenId: `closed-token-${index}`,
          side: "SELL" as const,
          price: "0.75",
          shares: "2",
          sizeUsdc: "1.5",
          observedAt: new Date(Date.now() - index * 1_000),
        },
      ]).flat()
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
        conditionId: boundedCondition(conditionIndex),
        tokenId: boundedToken(targetIndex, conditionIndex),
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
      conditionId: boundedCondition(0),
      tokenId: String(Number(boundedToken(0, 0)) + 1),
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
      conditionId: boundedCondition(0),
      tokenId: boundedToken(0, 0),
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

  it.each([
    { envelope: "absent", authority: "unavailable" },
    { envelope: "partial", authority: "unavailable" },
    { envelope: "absent", authority: "1n" },
    { envelope: "partial", authority: "1n" },
  ] as const)("composes the real writer and economics: $envelope envelope, terminal $authority", async testCase => {
    const suffix = randomUUID(), userId = `writer-economics-${suffix}`, account = `writer-economics-${suffix}`;
    const address = `0x${suffix.replaceAll("-", "").padStart(40, "f")}`;
    const conditionId = `0x${suffix.replaceAll("-", "").padStart(64, "d")}`;
    const healthyCondition = `0x${suffix.replaceAll("-", "").padStart(64, "b")}`;
    const wallet = await seedConnection({ userId, billingAccountId: account, address });
    const position = (winner: boolean): PolymarketUserPosition => ({
      proxyWallet: address, asset: winner ? "811" : "812", conditionId: winner ? conditionId : healthyCondition,
      size: winner ? 10 : 2, avgPrice: winner ? .6 : .5, initialValue: winner ? 6 : 1,
      currentValue: winner ? 10 : 2, cashPnl: winner ? 4 : 1, percentPnl: winner ? 100 * 4 / 6 : 100,
      totalBought: winner ? 10 : 2, realizedPnl: 0, percentRealizedPnl: 0, curPrice: 1,
      redeemable: winner, mergeable: false, title: winner ? "Retained winner W" : "Healthy H",
      slug: winner ? "winner-w" : "healthy-h", icon: "", eventId: suffix, eventSlug: suffix,
      outcome: "Yes", outcomeIndex: 0, oppositeOutcome: "No", oppositeAsset: winner ? "813" : "814",
      endDate: "2027-01-01", negativeRisk: false,
    });
    let page = [position(true), position(false)];
    const listUserPositions = vi.fn(async () => page);
    const readPositionBalances = vi.fn<NonNullable<Parameters<typeof refreshCurrentPositionsForWallet>[0]["readPositionBalances"]>>();
    const refresh = (delayed = false) => refreshCurrentPositionsForWallet({
      db, walletAddress: address, client: { listUserPositions } as unknown as PolymarketDataApiClient,
      // Only admission time is advanced. Preparation/publication clocks and
      // every successful query still come from real PostgreSQL.
      positionControl: new PositionObservationController({ now: () => Date.now() + 60_000, wait: async () => {}, random: () => 0 }),
      readPositionBalances,
      ...(delayed ? { beforePositionCursorPublish: async () => { await new Promise(resolve => setTimeout(resolve, 80)); } } : {}),
    });
    const saved = async () => {
      const rows = await db.select().from(polyTraderCurrentPositions).where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
      const [cursor] = await db.select().from(polyTraderIngestionCursors).where(and(
        eq(polyTraderIngestionCursors.traderWalletId, wallet.id), eq(polyTraderIngestionCursors.source, "data-api-positions")));
      const winner = rows.find(row => row.tokenId === "811"), healthy = rows.find(row => row.tokenId === "812");
      if (!winner || !healthy || !cursor?.lastSuccessAt) throw new Error("Writer did not persist the complete publication");
      return { winner, healthy, cursor: { ...cursor, lastSuccessAt: cursor.lastSuccessAt } };
    };
    const read = async () => {
      const projection = await readEconomicPositionProjection({ db, billingAccountId: account, walletAddress: address,
        connectionKind: "privy_live", capturedAt: new Date(), interval: "1W" });
      const dashboard = await readTenantWalletDashboard({ db, billingAccountId: account, interval: "1W", adapterConfigured: true });
      return { projection, dashboard };
    };
    try {
      await db.insert(polyTraderFills).values([
        { traderWalletId: wallet.id, source: "data-api", nativeId: `${suffix}-W`, conditionId, tokenId: "811",
          side: "BUY", price: ".6", shares: "10", sizeUsdc: "6", observedAt: new Date(Date.now() - 3600_000) },
        { traderWalletId: wallet.id, source: "data-api", nativeId: `${suffix}-H`, conditionId: healthyCondition, tokenId: "812",
          side: "BUY", price: ".5", shares: "2", sizeUsdc: "1", observedAt: new Date(Date.now() - 3600_000) },
      ]);
      await db.update(polyWalletBalanceSnapshots).set({ usdcE: "90", pusd: "0", observedAt: new Date() })
        .where(eq(polyWalletBalanceSnapshots.billingAccountId, account));
      expect(await refresh(true)).toMatchObject({ complete: true, positionRows: 2 });
      expect(readPositionBalances).not.toHaveBeenCalled();
      const initial = await saved();
      expect(initial.winner).toMatchObject({ active: false, shares: "10.00000000", currentValueUsdc: "10.00000000", lastObservedAt: initial.cursor.lastSuccessAt });
      expect(initial.healthy.lastObservedAt).toEqual(initial.cursor.lastSuccessAt);
      expect(initial.cursor.updatedAt.getTime() - initial.cursor.lastSuccessAt.getTime()).toBeGreaterThanOrEqual(60);
      const positive = await read();
      expect(positive.projection.positionFacts.find(row => row.tokenId === "811")).toMatchObject({ heldShares: 10, currentValueUsdc: 10, remainingBasisUsdc: 6 });
      expect(positive.dashboard.overview).toMatchObject({ usdc_positions_mtm: 12, usdc_total: 102 });

      if (testCase.envelope === "partial") {
        // Historical recovery owns this reserved envelope; it does not publish
        // quantity. The next real writer must preserve it without a new clock.
        await db.update(polyTraderCurrentPositions).set({ raw: { ...initial.winner.raw as Record<string, unknown>,
          economicObservationV1: { version: 1, wallet: address, conditionId, tokenId: "811", coverage: "partial",
            fetchedAt: initial.cursor.lastSuccessAt.toISOString(), windowStart: new Date(Date.now() - 86400_000).toISOString(),
            windowEnd: initial.cursor.lastSuccessAt.toISOString(), reasons: ["missing_closed_position"], closedPosition: null,
            lifetimeBuyUsdc: 6, lifetimeBuyShares: 10, lifetimeSellUsdc: 0, lifetimePnlUsdc: null, redeemUsdc: 0, constituents: [], settlements: [] } } })
          .where(and(eq(polyTraderCurrentPositions.traderWalletId, wallet.id), eq(polyTraderCurrentPositions.tokenId, "811")));
      }
      const beforeOmission = await saved();
      page = [position(false)];
      if (testCase.authority === "unavailable") readPositionBalances.mockRejectedValue(new PositionBalanceTransportError("RPC unavailable"));
      else readPositionBalances.mockResolvedValue([1n]);
      expect(await refresh()).toMatchObject({ complete: true, positionRows: 1 });
      expect(readPositionBalances).toHaveBeenCalledTimes(testCase.authority === "unavailable" ? 2 : 1);
      for (const [input] of readPositionBalances.mock.calls) expect(input).toMatchObject({ walletAddress: address, tokenIds: ["811"] });
      const omitted = await saved();
      expect(omitted.winner).toEqual(beforeOmission.winner);
      expect(omitted.cursor.status).toBe("ok");
      expect(omitted.cursor.lastSuccessAt.getTime()).toBeGreaterThan(initial.cursor.lastSuccessAt.getTime());
      expect(omitted.healthy.lastObservedAt).toEqual(omitted.cursor.lastSuccessAt);
      expect(omitted.cursor.errorMessage).toBe(testCase.authority === "unavailable"
        ? `terminal_recovery_v1:{"reason":"authority_unavailable","anchor":["${conditionId}","811"]}` : null);
      await db.update(polyWalletBalanceSnapshots).set({ usdcE: "100", pusd: "0", observedAt: new Date() })
        .where(eq(polyWalletBalanceSnapshots.billingAccountId, account));
      const pending = await read();
      expect(pending.projection.positionFacts.find(row => row.tokenId === "811")).toMatchObject({
        heldShares: null, currentValueUsdc: null, remainingBasisUsdc: null, unrealizedPnlUsdc: null,
        observedAt: initial.winner.lastObservedAt.toISOString(), inventoryCoverage: "unavailable", lifetimePnlUsdc: null });
      expect(pending.projection.positionFacts.find(row => row.tokenId === "812")).toMatchObject({ heldShares: 2, currentValueUsdc: 2 });
      expect(pending.projection.positionsMtm).toBeNull();
      expect(pending.dashboard.overview).toMatchObject({ usdc_available: 100, usdc_positions_mtm: null, usdc_total: null });
      const params = { db, billingAccountId: account, walletAddress: address, mode: "live" as const,
        capturedAt: new Date().toISOString(), livePositions: pending.projection.livePositions, closedPositions: pending.projection.closedPositions,
        positionFacts: pending.projection.positionFacts };
      const groups = await buildMarketExposureGroups(params);
      const bounded = await buildBoundedMarketExposureGroups(params);
      const coverage = await buildBoundedMarketExposureWithCoverage({ ...params, connectionKind: "privy_live" });
      for (const result of [groups, bounded.groups, coverage.market.groups, pending.dashboard.execution.market_groups]) {
        const legs = result.flatMap(group => group.lines).flatMap(line => line.participants)
          .filter(participant => participant.side === "our_wallet").flatMap(participant => participant.legs ?? []);
        expect(legs).toContainEqual(expect.objectContaining({ tokenId: "811", currentValueUsdc: null, costBasisUsdc: null, pnlUsdc: null }));
        expect(legs).toContainEqual(expect.objectContaining({ tokenId: "812", currentValueUsdc: 2 }));
      }

      readPositionBalances.mockClear().mockResolvedValue([0n]);
      expect(await refresh()).toMatchObject({ complete: true, positionRows: 1 });
      expect(readPositionBalances).toHaveBeenCalledTimes(1);
      const recovered = await saved();
      expect(recovered.winner).toMatchObject({ active: false, shares: "0.00000000", currentValueUsdc: "0.00000000", costBasisUsdc: "0.00000000", raw: beforeOmission.winner.raw });
      // Exact-zero publication retains PostgreSQL's submillisecond capture;
      // its ordered authority may be later than the cursor's Date precision.
      expect(recovered.winner.lastObservedAt.getTime()).toBeGreaterThanOrEqual(recovered.cursor.lastSuccessAt.getTime());
      expect(recovered.winner.lastObservedAt.getTime()).toBeGreaterThan(initial.winner.lastObservedAt.getTime());
      expect(recovered.cursor.errorMessage).toBeNull();
      const recoveredRead = await read();
      // Physical zero does not establish a completed exit or settlement cash.
      // Without a typed outcome/complete history W has no preview bucket, even
      // though its durable zero correctly removes it from whole-wallet MTM.
      expect(recoveredRead.projection.positionFacts.find(row => row.tokenId === "811")).toBeUndefined();
      expect([
        ...recoveredRead.projection.livePositions, ...recoveredRead.projection.closedPositions,
        ...recoveredRead.dashboard.execution.live_positions, ...recoveredRead.dashboard.execution.closed_positions,
      ].some(row => row.asset === "811")).toBe(false);
      expect(recoveredRead.projection.closedCount).toBe(0);
      expect(recoveredRead.projection.historyIncompleteCount).toBeGreaterThan(0);
      expect(recoveredRead.dashboard.facts.history.complete).toBe(false);
      expect(recoveredRead.dashboard.overview).toMatchObject({ usdc_available: 100, usdc_positions_mtm: 2, usdc_total: 102 });
      const snapshots = await db.select().from(polyTraderPositionSnapshots).where(and(
        eq(polyTraderPositionSnapshots.traderWalletId, wallet.id), eq(polyTraderPositionSnapshots.tokenId, "811")));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ shares: "10.00000000", capturedAt: initial.cursor.lastSuccessAt });
      expect(listUserPositions).toHaveBeenCalledTimes(3);
    } finally {
      await db.delete(billingAccounts).where(eq(billingAccounts.id, account));
      await db.delete(users).where(eq(users.id, userId));
      await db.delete(polyTraderWallets).where(eq(polyTraderWallets.id, wallet.id));
    }
  });

  // Captured writer publication states, separate from actual execution above.
  it.each([
    { name: "absent envelope", rowAge: 60_000, value: null },
    { name: "partial no-event envelope", rowAge: 60_000, value: null, partial: true },
    { name: "retained terminal 1n", rowAge: 60_000, value: null, terminal: true },
    { name: "same generation with later completion", rowAge: 0, value: 10 },
    { name: "genuinely later positive", rowAge: -100, value: 10 },
    { name: "submillisecond later positive", rowAge: 0, value: 10, subms: true },
    { name: "post-event exact zero", rowAge: 0, value: 0, zero: true },
    { name: "typed loser unknown quantity", rowAge: 60_000, value: 0, loser: true },
    { name: "future typed loser", rowAge: 60_000, value: null, loser: true, futureOutcome: true },
    { name: "contradictory typed loser", rowAge: 60_000, value: null, loser: true, contradictory: true },
    { name: "raw redeemable only", rowAge: 60_000, value: null, redeemable: true },
    { name: "selected missing cursor", rowAge: 0, value: null, cursor: "missing" },
    { name: "selected wrong-source cursor", rowAge: 0, value: null, cursor: "wrong-source" },
    { name: "selected disabled wallet", rowAge: 0, value: null, cursor: "disabled" },
    { name: "future overwritten selected cursor", rowAge: 0, value: null, cursor: "future" },
    { name: "equal-value older sibling latest generation", rowAge: 60_000, value: null, cursor: "older-sibling" },
    { name: "healthy same-generation siblings", rowAge: 0, value: 10, cursor: "healthy-sibling" },
    { name: "future overwritten current sibling", rowAge: 0, value: null, cursor: "future-current" },
  ])("fences live positive publication: $name", async testCase => {
    const suffix = randomUUID(), userId = `generation-${suffix}`, account = `generation-${suffix}`;
    const address = `0x${suffix.replaceAll("-", "").padStart(40, "e")}`;
    const conditionId = `0x${suffix.replaceAll("-", "").padStart(64, "d")}`;
    const healthyCondition = `0x${suffix.replaceAll("-", "").padStart(64, "b")}`;
    const wallet = await seedConnection({ userId, billingAccountId: account, address });
    const generation = new Date(Date.now() - 1_000), cutoff = new Date();
    const observedAt = new Date(generation.getTime() - testCase.rowAge);
    const walletIds = [wallet.id];
    try {
      await db.update(polyTraderIngestionCursors).set({ lastSuccessAt: generation,
        updatedAt: new Date(generation.getTime() + 80) })
        .where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id));
      await db.update(polyWalletBalanceSnapshots).set({ usdcE: "100", pusd: "0", observedAt: generation })
        .where(eq(polyWalletBalanceSnapshots.billingAccountId, account));
      await db.insert(polyTraderFills).values([
        { traderWalletId: wallet.id, source: "data-api", nativeId: `${suffix}-W`, conditionId, tokenId: "801",
          side: "BUY", price: ".6", shares: "10", sizeUsdc: "6", observedAt: new Date(generation.getTime() - 3600_000) },
        { traderWalletId: wallet.id, source: "data-api", nativeId: `${suffix}-H`, conditionId: healthyCondition, tokenId: "802",
          side: "BUY", price: ".5", shares: "2", sizeUsdc: "1", observedAt: new Date(generation.getTime() - 3600_000) },
      ]);
      // H is the actual healthy page; retained W's old clock never advances.
      await db.insert(polyTraderCurrentPositions).values([
        { ...currentPosition(wallet.id, 0, conditionId), tokenId: "801", shares: testCase.zero ? "0" : "10",
          costBasisUsdc: testCase.zero ? "0" : "6", currentValueUsdc: testCase.zero ? "0" : "10",
          firstObservedAt: observedAt, lastObservedAt: observedAt, active: !testCase.terminal,
          raw: { title: "Retained W", curPrice: "1", redeemable: Boolean(testCase.redeemable || testCase.terminal),
            ...(testCase.partial ? { economicObservationV1: { version: 1, wallet: address, conditionId, tokenId: "801",
              coverage: "partial", fetchedAt: generation.toISOString(),
              windowStart: new Date(generation.getTime() - 86400_000).toISOString(), windowEnd: generation.toISOString(),
              reasons: ["missing_closed_position"], closedPosition: null, lifetimeBuyUsdc: 6, lifetimeBuyShares: 10,
              lifetimeSellUsdc: 0, lifetimePnlUsdc: null, redeemUsdc: 0, constituents: [], settlements: [] } } : {}) } },
        { ...currentPosition(wallet.id, 1, healthyCondition), tokenId: "802", lastObservedAt: generation,
          raw: { title: "Healthy H", curPrice: "1" } },
      ]);
      if (testCase.subms) await db.execute(sql`UPDATE poly_trader_current_positions
        SET last_observed_at = ${generation.toISOString()}::timestamptz + interval '0.000001 seconds'
        WHERE trader_wallet_id = ${wallet.id} AND token_id = '801'`);
      if (testCase.loser || testCase.zero) await db.insert(polyMarketOutcomes).values({ conditionId, tokenId: "801",
        outcome: testCase.loser ? "loser" : "winner", payout: testCase.contradictory ? "1" : testCase.loser ? "0" : "1",
        resolvedAt: new Date(generation.getTime() - 30_000),
        updatedAt: new Date(generation.getTime() + (testCase.futureOutcome ? 60_000 : -500)) });
      if (testCase.cursor) {
        // A separate eligible physical sibling keeps a healthy cursor. It must
        // not certify the selected row, or hide a newer generation behind MIN.
        const [sibling] = await db.insert(polyTraderWallets).values({ walletAddress: `0x${address.slice(2).toUpperCase()}`,
          kind: "cogni_wallet", label: `generation sibling ${suffix}` }).returning();
        if (!sibling) throw new Error("Missing generation sibling");
        walletIds.push(sibling.id);
        await db.insert(polyTraderIngestionCursors).values({ traderWalletId: sibling.id,
          source: "data-api-positions", status: "ok", lastSuccessAt: generation });
        // Place H on the eligible sibling so it remains individually usable.
        await db.delete(polyTraderCurrentPositions).where(and(eq(polyTraderCurrentPositions.traderWalletId, wallet.id), eq(polyTraderCurrentPositions.tokenId, "802")));
        await db.insert(polyTraderCurrentPositions).values({ ...currentPosition(sibling.id, 1, healthyCondition),
          tokenId: "802", lastObservedAt: generation, raw: { title: "Healthy H", curPrice: "1" } });
        if (testCase.cursor === "missing" || testCase.cursor === "wrong-source") {
          await db.delete(polyTraderIngestionCursors).where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id));
          if (testCase.cursor === "wrong-source") await db.insert(polyTraderIngestionCursors).values({
            traderWalletId: wallet.id, source: "data-api-trades", status: "ok", lastSuccessAt: generation });
        }
        if (testCase.cursor === "disabled") await db.update(polyTraderWallets).set({ disabledAt: generation })
          .where(eq(polyTraderWallets.id, wallet.id));
        if (testCase.cursor === "future") await db.update(polyTraderIngestionCursors)
          .set({ lastSuccessAt: new Date(cutoff.getTime() + 60_000) }).where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id));
        if (["older-sibling", "healthy-sibling", "future-current"].includes(testCase.cursor)) {
          await db.insert(polyTraderCurrentPositions).values({ ...currentPosition(sibling.id, 0, conditionId), tokenId: "801",
            shares: "10", costBasisUsdc: "6", currentValueUsdc: "10", avgPrice: ".5",
            lastObservedAt: testCase.cursor === "future-current" ? new Date(cutoff.getTime() + 60_000) : observedAt,
            raw: { title: "Retained W", curPrice: "1", redeemable: false } });
          if (testCase.cursor === "older-sibling") await db.update(polyTraderIngestionCursors)
            .set({ lastSuccessAt: observedAt }).where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id));
        }
      }
      const saved = await db.select({ observedAt: polyTraderCurrentPositions.lastObservedAt,
        shares: polyTraderCurrentPositions.shares }).from(polyTraderCurrentPositions)
        .where(and(eq(polyTraderCurrentPositions.traderWalletId, wallet.id), eq(polyTraderCurrentPositions.tokenId, "801")));
      expect(saved[0]?.observedAt).toEqual(observedAt);
      expect(Number(saved[0]?.shares)).toBe(testCase.zero ? 0 : 10);
      if (!testCase.cursor) {
        const [cursor] = await db.select().from(polyTraderIngestionCursors)
          .where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id));
        expect(cursor).toMatchObject({ status: "ok", lastSuccessAt: generation,
          updatedAt: new Date(generation.getTime() + 80) });
      }
      const projection = await readEconomicPositionProjection({ db, billingAccountId: account, walletAddress: address,
        connectionKind: "privy_live", capturedAt: cutoff, interval: "1W" });
      const held = testCase.zero ? 0 : testCase.value === 10 ? 10 : null;
      const fact = projection.positionFacts.find(row => row.tokenId === "801");
      expect(fact).toMatchObject({ heldShares: held, remainingBasisUsdc: held === null ? null : testCase.zero ? 0 : 6,
        currentValueUsdc: testCase.value, lifetimePnlUsdc: null });
      if (!testCase.subms) expect(fact?.observedAt).toBe(observedAt.toISOString());
      if (held === null) expect(fact).toMatchObject({ inventoryCoverage: "unavailable", unrealizedPnlUsdc: null });
      // Preserve whole-wallet completeness: missing/future generations cannot
      // certify H either; ordinary terminal omission leaves H individually usable.
      expect(projection.positionFacts.find(row => row.tokenId === "802")?.currentValueUsdc)
        .toBe(["future", "missing", "wrong-source"].includes(testCase.cursor ?? "") ? null : 2);
      const expectedMtm = testCase.value === null ? null : testCase.value + 2;
      expect(projection.positionsMtm).toBe(expectedMtm);
      const dashboard = await readTenantWalletDashboard({ db, billingAccountId: account, interval: "1W", adapterConfigured: true });
      expect(dashboard.overview.usdc_positions_mtm).toBe(expectedMtm);
      expect(dashboard.overview.usdc_total).toBe(expectedMtm === null ? null : 100 + expectedMtm);
      // Exercise every public builder with the real canonical facts. Historical
      // display quantity must not revive rejected current money or erase W/H.
      const params = { db, billingAccountId: account, walletAddress: address, mode: "live" as const,
        capturedAt: cutoff.toISOString(), livePositions: projection.livePositions, closedPositions: projection.closedPositions,
        positionFacts: projection.positionFacts };
      const groups = await buildMarketExposureGroups(params);
      const bounded = await buildBoundedMarketExposureGroups(params);
      const coverage = await buildBoundedMarketExposureWithCoverage({ ...params, connectionKind: "privy_live" });
      for (const result of [groups, bounded.groups, coverage.market.groups]) {
        const legs = result.flatMap(group => group.lines).flatMap(line => line.participants)
          .filter(participant => participant.side === "our_wallet").flatMap(participant => participant.legs ?? []);
        expect(legs).toContainEqual(expect.objectContaining({ tokenId: "801", currentValueUsdc: testCase.value,
          costBasisUsdc: held === null ? null : testCase.zero ? 0 : 6 }));
        expect(legs).toContainEqual(expect.objectContaining({ tokenId: "802" }));
      }
    } finally {
      await db.delete(polyMarketOutcomes).where(eq(polyMarketOutcomes.conditionId, conditionId));
      await db.delete(billingAccounts).where(eq(billingAccounts.id, account));
      await db.delete(users).where(eq(users.id, userId));
      await db.delete(polyTraderWallets).where(inArray(polyTraderWallets.id, walletIds));
    }
  });

  it.each([
    {
      name: "aged loser",
      outcome: "loser",
      payout: "0",
      ageMinutes: 60,
      expected: 0,
    },
    {
      name: "older loser",
      outcome: "loser",
      payout: "0",
      ageMinutes: 180,
      expected: 0,
    },
    {
      name: "fresh winner",
      outcome: "winner",
      payout: "1",
      ageMinutes: 1,
      expected: 6,
    },
    {
      name: "aged winner",
      outcome: "winner",
      payout: "1",
      ageMinutes: 60,
      expected: null,
    },
    {
      name: "actual zero winner",
      outcome: "winner",
      payout: "1",
      ageMinutes: 1,
      expected: 0,
      zero: true,
    },
    {
      name: "future loser",
      outcome: "loser",
      payout: "0",
      ageMinutes: 60,
      expected: null,
      future: true,
    },
    {
      name: "contradictory loser",
      outcome: "loser",
      payout: "1",
      ageMinutes: 60,
      expected: null,
    },
    {
      name: "redeemable only",
      outcome: null,
      payout: null,
      ageMinutes: 60,
      expected: null,
    },
  ])(
    "values $name without inventing quantity or history",
    async (testCase) => {
      const suffix = randomUUID();
      const userId = `terminal-user-${suffix}`;
      const account = `terminal-account-${suffix}`;
      const address = `0x${suffix.replaceAll("-", "").padStart(40, "0")}`;
      const conditionId = `0x${suffix.replaceAll("-", "").padStart(64, "a")}`;
      const tokenId = "12345678901234567890";
      const wallet = await seedConnection({
        userId,
        billingAccountId: account,
        address,
      });
      const now = new Date();
      const observedAt = new Date(now.getTime() - testCase.ageMinutes * 60_000);
      // The fresh winner is an actual generation observation, not a retained row.
      if (testCase.name === "fresh winner") await db.update(polyTraderIngestionCursors)
        .set({ lastSuccessAt: observedAt }).where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id));
      try {
        await db.insert(polyTraderFills).values({
          traderWalletId: wallet.id,
          source: "data-api",
          nativeId: suffix,
          conditionId,
          tokenId,
          side: "BUY",
          price: "0.6",
          shares: "10",
          sizeUsdc: "6",
          observedAt: new Date(now.getTime() - 4 * 60 * 60_000),
        });
        await db.insert(polyTraderCurrentPositions).values({
          traderWalletId: wallet.id,
          conditionId,
          tokenId,
          active: false,
          shares: testCase.zero ? "0" : "10",
          costBasisUsdc: testCase.zero ? "0" : "6",
          currentValueUsdc: testCase.zero ? "0" : "6",
          avgPrice: "0.6",
          contentHash: suffix,
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
          raw: { redeemable: true, curPrice: testCase.zero ? "0" : "0.6" },
        });
        if (testCase.outcome)
          await db.insert(polyMarketOutcomes).values({
            conditionId,
            tokenId,
            outcome: testCase.outcome,
            payout: testCase.payout,
            resolvedAt: new Date(now.getTime() - 30 * 60_000),
            updatedAt: new Date(now.getTime() + (testCase.future ? 60_000 : -1000)),
          });
        const projection = await readEconomicPositionProjection({
          db,
          billingAccountId: account,
          walletAddress: address,
          connectionKind: "privy_live",
          capturedAt: now,
          interval: "1W",
        });
        expect(projection.positionsMtm).toBe(testCase.expected);
        const fact = projection.positionFacts.find((candidate) => candidate.tokenId === tokenId);
        expect(fact).toMatchObject({
          heldShares: testCase.zero ? 0 : testCase.name === "fresh winner" ? 10 : null,
          currentValueUsdc: testCase.expected,
          observedAt: observedAt.toISOString(),
          lifetimePnlUsdc: null,
          economicsCoverage: "partial",
        });
        if (testCase.outcome === "loser" && testCase.payout === "0" && !testCase.future) {
          expect(fact?.inventoryCoverage).toBe("unavailable");
          expect(projection.closedPositions[0]).toMatchObject({
            currentPrice: 0,
            currentValue: 0,
            pnlUsd: null,
          });
        }
        const dashboard = await readTenantWalletDashboard({
          db,
          billingAccountId: account,
          interval: "1W",
          adapterConfigured: true,
        });
        expect(dashboard.overview.usdc_positions_mtm).toBe(testCase.expected);
        expect(dashboard.overview.usdc_total).toBe(
          testCase.expected === null ? null : 15 + testCase.expected,
        );
        expect(dashboard.facts.history.complete).toBe(false);
      } finally {
        await db.delete(polyMarketOutcomes).where(eq(polyMarketOutcomes.conditionId, conditionId));
        await db.delete(billingAccounts).where(eq(billingAccounts.id, account));
        await db.delete(users).where(eq(users.id, userId));
        await db.delete(polyTraderWallets).where(eq(polyTraderWallets.id, wallet.id));
      }
    },
    60_000,
  );


  it.each([
    { name: "pre-settlement positive", age: 5, shares: "10", value: "6", expected: null, held: null },
    { name: "post-settlement positive", age: 1, shares: "4", value: "4", expected: 4, held: 4 },
    { name: "post-settlement zero", age: 1, shares: "0", value: "0", expected: 0, held: 0 },
    { name: "clockless authoritative zero dominates old mark", age: 1, shares: "0", value: "6", expected: 0, held: 0, clock: "missing" },
    { name: "missing event clock", age: 5, shares: "10", value: "6", expected: null, held: null, clock: "missing" },
    { name: "invalid event clock", age: 5, shares: "10", value: "6", expected: null, held: null, clock: "invalid" },
    { name: "future envelope", age: 5, shares: "10", value: "6", expected: 6, held: 10, future: true },
    { name: "future clock with as-of settlement", age: 5, shares: "10", value: "6", expected: null, held: null, clock: "future" },
  ])("fences partial native winner: $name", async testCase => {
    const fixture = JSON.parse(readFileSync(new URL("../../_fixtures/poly/economic-recovery-bcgame.json", import.meta.url), "utf8"));
    const positions = fixture.positions as PolymarketUserPositionV2[];
    const winner = positions.find(row => row.current_price === 1);
    if (!winner) throw new Error("Missing native winner");
    const address = "0x41a7ec25dc776bc364452c5c5cc936ffc6d5f296";
    const conditionId = fixture.provenance.conditionId as string;
    const receipt = { ...fixture.receipt, status: "success", blockNumber: BigInt(fixture.receipt.blockNumber),
      logs: fixture.receipt.logs.map((log: Record<string, unknown>) => ({ ...log, logIndex: Number(log.logIndex), blockNumber: BigInt(String(log.blockNumber)) })),
    } as TransactionReceipt;
    const proof = verifyEconomicSettlement({ receipt, walletAddress: address, conditionId,
      tokenId: winner.token_id, expectedAtomic: 229280000n, canonicalBlockHash: receipt.blockHash,
      head: receipt.blockNumber + 5n, chainId: 137 });
    expect(proof).not.toBeNull();
    if (!proof) throw new Error("Captured routed receipt failed verification");
    const suffix = randomUUID(), userId = `partial-user-${suffix}`, account = `partial-account-${suffix}`;
    const wallet = await seedConnection({ userId, billingAccountId: account, address });
    const now = new Date();
    const observedAt = new Date(now.getTime() - testCase.age * 60_000);
    // Isolate the existing event fence with a truthful same-generation row.
    await db.update(polyTraderIngestionCursors).set({ lastSuccessAt: observedAt })
      .where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id));
    const eventAt = Math.floor(now.getTime() / 1000) + (testCase.clock === "future" ? 60 : -180);
    // Actual native composition omits the losing CLOSED aggregate; winner proof
    // and closedPosition survive while the whole cohort becomes partial.
    const observations = buildEconomicObservations({ walletAddress: address, conditionId,
      positions: [{ ...winner, last_event_at: eventAt }], activity: fixture.activity as PolymarketActivityV2[],
      fetchedAt: new Date(now.getTime() + (testCase.future ? 60_000 : -60_000)),
      windowStart: new Date(now.getTime() - 35 * 86400_000), settlements: [proof] });
    const observation = observations.find(row => row.tokenId === winner.token_id);
    if (!observation) throw new Error("Missing composed winner observation");
    expect(observations).toHaveLength(2);
    expect(observation).toMatchObject({ coverage: "partial", lifetimePnlUsdc: null, settlements: [proof] });
    expect(observation.redeemUsdc).toBe(229.28);
    const envelope = JSON.parse(JSON.stringify(observation));
    if (testCase.clock === "missing") delete envelope.closedPosition.last_event_at;
    if (testCase.clock === "invalid") envelope.closedPosition.last_event_at = "unusable";
    try {
      await db.update(polyWalletBalanceSnapshots).set({ usdcE: "229.28", pusd: "0", observedAt: now }).where(eq(polyWalletBalanceSnapshots.billingAccountId, account));
      await db.insert(polyTraderFills).values({ traderWalletId: wallet.id, source: "data-api", nativeId: suffix,
        conditionId, tokenId: winner.token_id, side: "BUY", price: ".6", shares: "10", sizeUsdc: "6",
        observedAt: new Date(now.getTime() - 3600_000) });
      await db.insert(polyMarketOutcomes).values({ conditionId, tokenId: winner.token_id, outcome: "winner", payout: "1",
        resolvedAt: new Date(now.getTime() - 10 * 60_000), updatedAt: new Date(now.getTime() - 10 * 60_000) });
      await db.insert(polyTraderCurrentPositions).values({
        ...currentPosition(wallet.id, 0, conditionId), tokenId: winner.token_id,
        shares: testCase.shares, currentValueUsdc: testCase.value, costBasisUsdc: "4",
        firstObservedAt: observedAt, lastObservedAt: observedAt,
        raw: { economicObservationV1: envelope, curPrice: ".6", outcome: "BC.Game Esports" },
      });
      const projection = await readEconomicPositionProjection({ db, billingAccountId: account,
        walletAddress: address, connectionKind: "privy_live", capturedAt: now, interval: "1W" });
      expect(projection.positionsMtm).toBe(testCase.expected);
      expect(projection.positionFacts.find(fact => fact.tokenId === winner.token_id)).toMatchObject({
        heldShares: testCase.held, currentValueUsdc: testCase.expected,
        lifetimePnlUsdc: null, economicsCoverage: "partial", observedAt: observedAt.toISOString(),
      });
      const dashboard = await readTenantWalletDashboard({ db, billingAccountId: account, interval: "1W", adapterConfigured: true });
      expect(dashboard.overview.usdc_positions_mtm).toBe(testCase.expected);
      expect(dashboard.overview.usdc_total).toBe(testCase.expected === null ? null : 229.28 + testCase.expected);
      expect(dashboard.facts.history.complete).toBe(false);
      const own = dashboard.execution.market_groups.flatMap(group => group.lines).flatMap(line => line.participants).find(row => row.side === "our_wallet");
      if (testCase.expected === null) expect(own?.primary?.currentValueUsdc).toBeNull();
    } finally {
      await db.delete(polyMarketOutcomes).where(eq(polyMarketOutcomes.conditionId, conditionId));
      await db.delete(billingAccounts).where(eq(billingAccounts.id, account));
      await db.delete(users).where(eq(users.id, userId));
      await db.delete(polyTraderWallets).where(eq(polyTraderWallets.id, wallet.id));
    }
  });

  it.each([
    { mode: "live", fallback: false }, { mode: "live", fallback: true },
    { mode: "paper", fallback: false }, { mode: "paper", fallback: true },
  ] as const)("retains nullable $mode economics and third-leg identity, fallback=$fallback", async ({ mode, fallback }) => {
    const suffix = randomUUID();
    const userId = `integration-${suffix}`, account = `integration-${suffix}`;
    const address = mode === "paper" ? derivePaperAccountAddress(account) : `0x${suffix.replaceAll("-", "").padStart(40, "a")}`;
    const conditionId = `0x${suffix.replaceAll("-", "").padStart(64, "c")}`;
    const wallet = await seedConnection({ userId, billingAccountId: account, address, mode });
    const [target] = await db.insert(polyTraderWallets).values({ walletAddress: `0x${suffix.replaceAll("-", "").padStart(40, "1")}`, kind: "copy_target", label: "RN1 third leg" }).returning();
    if (!target) throw new Error("Missing target");
    let otherModeWalletId = "";
    try {
      // A same-address different mode has tempting complete finance and labels.
      const [trap] = await db.insert(polyTraderWallets).values({ walletAddress: `0x${address.slice(2).toUpperCase()}`, label: "Other mode trap", kind: mode === "live" ? "paper_wallet" : "cogni_wallet" }).returning();
      if (!trap) throw new Error("Missing mode trap");
      otherModeWalletId = trap.id;
      const observedAt = new Date(Date.now() - 1_000);
      await db.update(polyTraderIngestionCursors).set({ lastSuccessAt: observedAt })
        .where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id));
      if (mode === "paper") {
        const owner = { userId, billingAccountId: account };
        // Both accepted BUYs must precede even the retained stale mark.
        // A quantity observation from before its own fill cannot prove basis.
        const receiptAt = new Date(observedAt.getTime() - 2 * 60 * 60_000);
        for (const [tokenId, shares] of [["903", "10"], ["904", "5"]] as const) {
          await seedNativePaperFill(owner, randomUUID(), { conditionId, tokenId,
            side: "BUY", price: "0.4", shares, observedAt: receiptAt });
        }
        const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => logger };
        const projection = await observePaperWallet({ db, wallet: { traderWalletId: wallet.id,
          account: { billingAccountId: account, address: derivePaperAccountAddress(account), seedUsdc: "100" } },
          now: observedAt, readMidPrice: async () => 0.6, logger: logger as never });
        expect(projection).toMatchObject({ fills: 2, positions: 2, unpricedPositions: 0, navPublished: true });
        // Keep the real generation/proof fields; only the public labels and
        // second leg's mark clock differ in this nullable-economics fixture.
        for (const [tokenId, title, outcome, clock] of [
          ["903", "Own measured identity", "Own label", observedAt],
          ["904", "Own stale identity", "Unknown finance", new Date(Date.now() - 60 * 60_000)],
        ] as const) {
          await db.update(polyTraderCurrentPositions).set({ lastObservedAt: clock,
            raw: sql`raw || ${JSON.stringify({ title, outcome })}::jsonb` })
            .where(and(eq(polyTraderCurrentPositions.traderWalletId, wallet.id), eq(polyTraderCurrentPositions.tokenId, tokenId)));
        }
      } else {
        await db.insert(polyTraderCurrentPositions).values([
          { ...currentPosition(wallet.id, 0, conditionId), tokenId: "903", shares: "10", costBasisUsdc: "4", currentValueUsdc: "6", avgPrice: ".4", lastObservedAt: observedAt, raw: { title: "Own measured identity", outcome: "Own label" } },
          { ...currentPosition(wallet.id, 1, conditionId), tokenId: "904", shares: "5", costBasisUsdc: "2", currentValueUsdc: "3", avgPrice: ".4", lastObservedAt: new Date(Date.now() - 60_000), raw: { title: "Own stale identity", outcome: "Unknown finance" } },
        ]);
      }
      await db.insert(polyTraderCurrentPositions).values(
        { ...currentPosition(trap.id, 0, conditionId), tokenId: "903", shares: "1000", costBasisUsdc: "400", currentValueUsdc: "600", lastObservedAt: observedAt, raw: { title: "Wrong mode trap", outcome: "Wrong mode" } },
      );
      await db.insert(polyCopyTradeTargets).values({ billingAccountId: account, createdByUserId: userId, targetWallet: target.walletAddress });
      for (const [index, tokenId] of ["901", "902", "903"].entries()) {
        const common = { traderWalletId: target.id, conditionId, tokenId, shares: String(30 - index * 10), costBasisUsdc: String(12 - index * 4), currentValueUsdc: String(18 - index * 6), avgPrice: ".4", contentHash: `${suffix}-${tokenId}`, raw: { title: "Target market", outcome: `Target ${tokenId}` } };
        await db.insert(polyTraderCurrentPositions).values({ ...common, lastObservedAt: observedAt });
        await db.insert(polyTraderPositionSnapshots).values({ ...common, capturedAt: observedAt });
      }
      let injected = false;
      // Only the bundle SQL fails. Every returned row and fallback builder runs against real PG.
      const wrap = <T extends { execute(query: SQL): unknown }>(targetDb: T): T => new Proxy(targetDb, {
        get(targetDb, property) {
          const value = Reflect.get(targetDb, property);
          if (property === "execute") return (query: SQL) => {
            const text = new PgDialect().sqlToQuery(query).sql;
            if (fallback && !injected && text.includes("target_snapshot_source AS MATERIALIZED")) {
              injected = true;
              return targetDb.execute(sql`SELECT integration_forced_bundle_failure`);
            }
            return targetDb.execute(query);
          };
          if (property === "transaction") return (...args: unknown[]) => Reflect.apply(value, targetDb, [
            (child: T) => (args[0] as (child: T) => Promise<unknown>)(wrap(child)), ...args.slice(1),
          ]);
          return typeof value === "function" ? value.bind(targetDb) : value;
        },
      });
      const diagnostics: import("@/features/wallet-analysis/server/tenant-wallet-dashboard-service").WalletDashboardReadDiagnostics = {};
      const dashboard = await readTenantWalletDashboard({ db: wrap(db), billingAccountId: account, interval: "1W", adapterConfigured: true, diagnostics });
      expect(injected).toBe(fallback);
      expect(diagnostics.comparisonPath).toBe(fallback ? "bundle_fallback" : "bundle");
      expect(dashboard.execution.live_positions).toHaveLength(2);
      expect(dashboard.execution.live_positions).toContainEqual(expect.objectContaining({ asset: "903", marketTitle: "Own measured identity", size: 10, pnlUsd: 2 }));
      expect(dashboard.execution.live_positions).toContainEqual(expect.objectContaining({ asset: "904", marketTitle: "Own stale identity", size: 5, currentValue: null, pnlUsd: null }));
      const line = dashboard.execution.market_groups.flatMap(group => group.lines).find(line => line.conditionId === conditionId);
      expect(line?.ourEntryValueUsdc).toBe(mode === "live" ? null : 6);
      expect(line?.ourValueUsdc).toBeNull();
      const own = line?.participants.find(p => p.side === "our_wallet");
      // Native paper history proves mark 6 - BUY 4 - known fees 0 = +2.
      // The live fixture has no complete lifetime history; its P/L stays unknown.
      expect(own?.primary).toMatchObject({ tokenId: "903", shares: 10, costBasisUsdc: 4, currentValueUsdc: 6, pnlUsdc: mode === "paper" ? 2 : null });
      expect(own?.legs).toContainEqual(expect.objectContaining({ tokenId: "904", costBasisUsdc: mode === "live" ? null : 2, currentValueUsdc: null, pnlUsdc: null }));
      expect(line?.participants.find(p => p.side === "copy_target")?.legs?.map(leg => leg.tokenId)).toEqual(["901", "902", "903"]);
      expect(line?.tokenComparisons).toContainEqual(expect.objectContaining({ ourTokenId: "903", targetTokenId: "903", relation: "same", economicsAvailability: "unavailable" }));
      expect(line?.edgeGapPct).toBeNull();
      if (!fallback) {
        const coverage = dashboard.execution.comparisonCoverage.positions.live;
        expect(coverage.eligible).toBe(2);
        expect(coverage.comparable).toBe(1);
        expect(coverage.sampled).toBe(0);
        expect(coverage.eligible).toBe((coverage.comparable ?? 0) + (coverage.dropped ?? 0));
      } else expect(dashboard.execution.comparisonCoverage.positions.live.complete).toBe(false);
    } finally {
      await db.delete(billingAccounts).where(eq(billingAccounts.id, account));
      await db.delete(users).where(eq(users.id, userId));
      await db.delete(polyTraderWallets).where(inArray(polyTraderWallets.id, [wallet.id, target.id, otherModeWalletId].filter(Boolean)));
    }
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
    expect(result.execution.warnings.map((entry) => entry.code)).not.toContain("realized_pnl_incomplete");
    expect(result.execution.comparisonCoverage.positions.live).toEqual({
      eligible: 501,
      comparable: 1,
      dropped: 500,
      // Exact identity is comparable, but canonical return inputs are absent.
      sampled: 0,
      complete: false,
      reasons: [
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
    expect(
      result.execution.live_positions.some(
        (position) => position.conditionId === "condition-0"
      )
    ).toBe(true);
    const correlatedLine = result.execution.market_groups
      .flatMap((group) => group.lines)
      .find((line) => line.conditionId === "condition-0");
    expect(correlatedLine).toBeDefined();
    expect(correlatedLine?.targetEntryValueUsdc ?? 0).toBeGreaterThan(0);
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

    // SQL identity coverage stays separate from finite financial deltas.
    const classifications = tenantB.execution.comparisonCoverage.positionClassifications;
    expect(classifications).toContainEqual({
      conditionId: "condition-0", tokenId: `token-${walletB.id}-0`, status: "live", result: "comparable",
    });
    expect(tenantB.execution.comparisonCoverage.markets.live).toMatchObject({
      eligible: 1, comparable: 1, dropped: 0, sampled: 0,
      complete: false, reasons: ["preview_truncated"],
    });
    expect(tenantB.execution.comparisonCoverage.positions.live).toMatchObject({
      eligible: 1, comparable: 1, dropped: 0, sampled: 0,
      complete: false, reasons: ["preview_truncated"],
    });
    expect(tenantB.execution.market_groups.every(group => group.edgeGapPct === null)).toBe(true);
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

      // The comparison fixture explicitly has complete native BUY/SELL
      // coverage; lifecycle-only or partial fills must not acquire fake P/L.
      const economicHistoryHash = `complete-closed-${contentHash}`;
      await db.insert(polyTraderPositionSnapshots).values({
        traderWalletId: walletA.id, conditionId: "closed-condition-0", tokenId: "closed-token-0",
        shares: "0", costBasisUsdc: "0", currentValueUsdc: "0", avgPrice: "0", contentHash: economicHistoryHash,
        capturedAt: new Date(), raw: { economicObservationV1: {
          version: 1, wallet: OUR_A, conditionId: "closed-condition-0", tokenId: "closed-token-0",
          fetchedAt: new Date().toISOString(), windowStart: new Date(Date.now()-86_400_000).toISOString(), windowEnd: new Date().toISOString(),
          coverage: "complete", reasons: [], lifetimeBuyUsdc: 1, lifetimeBuyShares: 2,
          lifetimeSellUsdc: 1.5, lifetimePnlUsdc: 0.5, redeemUsdc: 0, constituents: [], settlements: [],
          closedPosition: { current_price: 0.75, last_event_at: Math.floor(Date.now()/1000), first_entry_at: Math.floor(Date.now()/1000)-1 },
        } },
      });
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
        connectionKind: "privy_live",
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
        .where(inArray(polyTraderPositionSnapshots.contentHash, [contentHash, `complete-closed-${contentHash}`]));
    }
  }, 60_000);

  it("withholds lifecycle-only history when canonical economics are missing", async () => {
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
      expect(dashboard.execution.closed_position_count).toBe(0);
      expect(dashboard.execution.closed_positions).toEqual([]);
      expect(dashboard.facts.history).toMatchObject({
        status: "partial",
        complete: false,
      });
      expect(dashboard.warnings).toContainEqual(
        expect.objectContaining({
          component: "history",
          code: "history_projection_incomplete",
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
      expect(result.execution.warnings).not.toContainEqual(
        expect.objectContaining({ code: "realized_pnl_identity_ambiguous" })
      );
    } finally {
      await db.delete(polyTraderWallets).where(eq(polyTraderWallets.id, duplicate.id));
    }
  });

  it("enforces bounded market SQL before hydration with fresh target facts", async () => {
    const positions: WalletExecutionPosition[] = Array.from({ length: 500 }, (_, index) => ({
      positionId: `${boundedCondition(index)}:${900000 + index}`,
      conditionId: boundedCondition(index),
      asset: String(900000 + index),
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
    // The shared reader requires saved own-wallet metadata for event grouping.
    const hashes = positions.map((_, index) => `bounded-own-${index}`);
    await db.insert(polyTraderPositionSnapshots).values(positions.map((position, index) => ({
      traderWalletId: walletA.id, conditionId: position.conditionId, tokenId: position.asset,
      shares: "2", costBasisUsdc: "1", currentValueUsdc: "1.2", avgPrice: ".5",
      capturedAt: new Date(), contentHash: `bounded-own-${index}`,
      raw: { title: position.marketTitle, eventTitle: position.eventTitle, eventSlug: position.eventSlug, outcome: position.outcome },
    })));
    try {
    const bounded = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: TENANT_A,
      walletAddress: OUR_A,
      livePositions: positions,
    });
    const participants = bounded.groups.flatMap((group) =>
      group.lines.flatMap((line) => line.participants)
    );
    expect(bounded.groups).toHaveLength(200);
    expect(participants).toHaveLength(2_200);
    expect(bounded.truncated).toBe(true);
    for (const group of bounded.groups) {
      const targetRows = group.lines.flatMap((line) => line.participants).filter((row) => row.side === "copy_target");
      expect(targetRows.length).toBeLessThanOrEqual(10);
    }
    const pivotLine = bounded.groups
      .flatMap((group) => group.lines)
      .find((line) => line.conditionId === boundedCondition(0));
    const pivot = pivotLine?.participants.find(
      (row) => row.label === "Bounded target 0" && row.conditionId === boundedCondition(0)
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
    } finally {
      await db.delete(polyTraderPositionSnapshots).where(inArray(polyTraderPositionSnapshots.contentHash, hashes));
    }
  }, 60_000);

  it("distinguishes observed zero, partial, stale, and never-observed without false totals", async () => {
    const cursor = and(
      eq(polyTraderIngestionCursors.traderWalletId, walletB.id),
      eq(polyTraderIngestionCursors.source, "data-api-positions")
    );
    await db
      .update(polyTraderCurrentPositions)
      .set({ active: false, shares: "0", currentValueUsdc: "0" })
      .where(eq(polyTraderCurrentPositions.traderWalletId, walletB.id));
    const zero = await readTenantWalletDashboard({ db, billingAccountId: TENANT_B, interval: "1W", adapterConfigured: true });
    expect(zero.execution.live_position_count).toBe(0);
    expect(zero.execution.live_positions).toEqual([]);
    expect(zero.overview.usdc_positions_mtm).toBe(0);
    expect(zero.facts.positions.status).toBe("fresh");
    expect(zero.facts.positions.actionsAllowed).toBe(true);

    await db
      .update(polyTraderCurrentPositions)
      .set({ active: true, shares: "2", currentValueUsdc: "2", lastObservedAt: new Date() })
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
    expect(partial.execution.market_groups).toHaveLength(1);
    expect(partial.execution.market_groups[0]?.ourValueUsdc).toBeNull();
    expect(partial.execution.market_groups[0]?.lines[0]?.participants.find(row => row.side === "our_wallet")?.primary).toMatchObject({ currentValueUsdc: null, pnlUsdc: null });
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
    expect(stale.facts.positions.status).toBe("partial");
    expect(stale.facts.positions.actionsAllowed).toBe(false);
    expect(stale.execution.live_position_count).toBe(1);
    expect(stale.execution.live_positions).toHaveLength(1);
    expect(stale.execution.market_groups).toHaveLength(1);
    expect(stale.execution.market_groups[0]?.ourValueUsdc).toBeNull();
    expect(stale.facts.markets.status).toBe("partial");
    // bug.5031: the stalled-observer case the dashboard actually hit in prod —
    // the frozen inventory's MTM is withheld (null), not a misleading stale
    // number, and the composite total stays null.
    expect(stale.overview.usdc_positions_mtm).toBeNull();
    expect(stale.overview.usdc_total).toBeNull();

    await db.delete(polyTraderIngestionCursors).where(cursor);
    const unavailable = await readTenantWalletDashboard({ db, billingAccountId: TENANT_B, interval: "1W", adapterConfigured: true });
    expect(unavailable.facts.positions.status).toBe("partial");
    expect(unavailable.execution.live_position_count).toBe(1);
    expect(unavailable.execution.live_positions).toHaveLength(1);
    expect(unavailable.execution.market_groups).toHaveLength(1);
    expect(unavailable.execution.market_groups[0]?.ourValueUsdc).toBeNull();
    expect(unavailable.execution.comparisonCoverage.positions.live.reasons).toContain(
      "source_incomplete"
    );
    expect(unavailable.overview.usdc_positions_mtm).toBeNull();
    expect(unavailable.overview.usdc_total).toBeNull();
  });
});

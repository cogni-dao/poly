// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Authoritative lifetime-token-leg partition and economic-P/L coverage. */
import { randomUUID } from "node:crypto";
import {
  polyMarketOutcomes,
  polyTraderIngestionCursors,
  polyTraderCurrentPositions,
  polyTraderFills,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEconomicPositionProjection } from "@/features/wallet-analysis/server/economic-position-read-model";
import { billingAccounts, polyCopyTradeFills, users } from "@/shared/db/schema";

const USER = `economic-position-user-${randomUUID()}`;
const TENANT = `economic-position-tenant-${randomUUID()}`;
const OTHER_USER = `economic-position-other-user-${randomUUID()}`;
const OTHER_TENANT = `economic-position-other-tenant-${randomUUID()}`;
const TARGET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADDRESS = `0x${"ab".repeat(20)}`;
const ADDRESS_CASE_SIBLING = `0x${"AB".repeat(20)}`;
const PAPER_ADDRESS_CASE_SIBLING = `0x${"Ab".repeat(20)}`;
const OTHER_ADDRESS = `0x${"cd".repeat(20)}`;
const CAPTURED = new Date("2026-10-12T12:00:00.000Z");

const CONDITIONS = {
  winner: "condition-winner",
  loser: "condition-loser",
  fullExit: "condition-full-exit",
  partial: "condition-partial",
  reopened: "condition-reopened",
  fillConflict: "condition-fill-conflict",
  fillKeyConflictA: "condition-fill-key-conflict-a",
  fillKeyConflictB: "condition-fill-key-conflict-b",
  currentConflict: "condition-current-conflict",
  outcomeConflict: "condition-outcome-conflict",
  otherTenant: "condition-other-tenant",
} as const;

const walletIds: string[] = [];
const outcomeConditions: string[] = [];

function token(condition: string): string {
  return `token-${condition}`;
}

describe("authoritative wallet economic-position projection", () => {
  const db = getSeedDb();

  beforeAll(async () => {
    await db.insert(users).values([
      { id: USER, name: USER },
      { id: OTHER_USER, name: OTHER_USER },
    ]);
    await db.insert(billingAccounts).values([
      { id: TENANT, ownerUserId: USER, balanceCredits: 0n },
      { id: OTHER_TENANT, ownerUserId: OTHER_USER, balanceCredits: 0n },
    ]);

    for (const [address, label] of [
      [ADDRESS, "canonical"],
      [ADDRESS_CASE_SIBLING, "case-sibling"],
      [OTHER_ADDRESS, "other-tenant"],
    ] as const) {
      const inserted = await db
        .insert(polyTraderWallets)
        .values({ walletAddress: address, kind: "cogni_wallet", label })
        .returning({ id: polyTraderWallets.id });
      const id = inserted[0]?.id;
      if (!id) throw new Error("wallet seed failed");
      walletIds.push(id);
    }
    const paperInserted = await db
      .insert(polyTraderWallets)
      .values({
        walletAddress: PAPER_ADDRESS_CASE_SIBLING,
        kind: "paper_wallet",
        label: "paper-mode-sibling",
      })
      .returning({ id: polyTraderWallets.id });
    const paperWallet = paperInserted[0]?.id;
    if (!paperWallet) throw new Error("paper wallet seed failed");
    walletIds.push(paperWallet);

    const [wallet, sibling, otherWallet] = walletIds;
    if (!wallet || !sibling || !otherWallet) {
      throw new Error("wallet seed incomplete");
    }

    const tenantConditions = Object.values(CONDITIONS).filter(
      (condition) => condition !== CONDITIONS.otherTenant
    );
    await db.insert(polyCopyTradeFills).values([
      ...tenantConditions.map((condition, index) => ({
        billingAccountId: TENANT,
        createdByUserId: USER,
        targetId: TARGET_ID,
        fillId: `origin-${index}`,
        marketId: `prediction-market:polymarket:${condition}`,
        observedAt: new Date(Date.UTC(2026, 9, index + 1, 10)),
        clientOrderId: `origin-client-${index}`,
        status: "filled",
        positionLifecycle: "open",
        mode: "live",
        attributes: {
          condition_id: condition,
          token_id: token(condition),
          filled_size_usdc: "4",
        },
      })),
      {
        billingAccountId: OTHER_TENANT,
        createdByUserId: OTHER_USER,
        targetId: TARGET_ID,
        fillId: "other-origin",
        marketId: `prediction-market:polymarket:${CONDITIONS.otherTenant}`,
        observedAt: new Date("2026-10-01T10:00:00.000Z"),
        clientOrderId: "other-origin-client",
        status: "filled",
        positionLifecycle: "open",
        mode: "live",
        attributes: {
          condition_id: CONDITIONS.otherTenant,
          token_id: token(CONDITIONS.otherTenant),
          filled_size_usdc: "4",
        },
      },
    ]);

    const fill = (
      traderWalletId: string,
      nativeId: string,
      conditionId: string,
      side: "BUY" | "SELL",
      price: string,
      shares: string,
      observedAt: string
    ) => ({
      traderWalletId,
      source: "data-api" as const,
      nativeId,
      conditionId,
      tokenId: token(conditionId.toLowerCase()),
      side,
      price,
      shares,
      sizeUsdc: String(Number(price) * Number(shares)),
      observedAt: new Date(observedAt),
    });
    await db.insert(polyTraderFills).values([
      fill(wallet, "winner-buy", CONDITIONS.winner, "BUY", "0.4", "10", "2026-10-01T10:00:00.000Z"),
      fill(sibling, "winner-buy", CONDITIONS.winner.toUpperCase(), "BUY", "0.4", "10", "2026-10-01T10:00:00.000Z"),
      fill(wallet, "loser-buy", CONDITIONS.loser, "BUY", "0.4", "10", "2026-10-02T10:00:00.000Z"),
      fill(wallet, "exit-buy", CONDITIONS.fullExit, "BUY", "0.4", "10", "2026-10-03T10:00:00.000Z"),
      fill(wallet, "exit-sell", CONDITIONS.fullExit, "SELL", "0.6", "10", "2026-10-04T10:00:00.000Z"),
      fill(wallet, "partial-buy", CONDITIONS.partial, "BUY", "0.4", "10", "2026-10-05T10:00:00.000Z"),
      fill(wallet, "partial-sell", CONDITIONS.partial, "SELL", "0.6", "4", "2026-10-06T10:00:00.000Z"),
      fill(wallet, "reopen-buy-a", CONDITIONS.reopened, "BUY", "0.4", "10", "2026-10-01T11:00:00.000Z"),
      fill(wallet, "reopen-sell", CONDITIONS.reopened, "SELL", "0.5", "10", "2026-10-02T11:00:00.000Z"),
      fill(wallet, "reopen-buy-b", CONDITIONS.reopened, "BUY", "0.25", "4", "2026-10-03T11:00:00.000Z"),
      fill(wallet, "conflicting-native", CONDITIONS.fillConflict, "BUY", "0.4", "10", "2026-10-07T10:00:00.000Z"),
      fill(sibling, "conflicting-native", CONDITIONS.fillConflict, "BUY", "0.5", "10", "2026-10-07T10:00:00.000Z"),
      fill(wallet, "conflicting-key-native", CONDITIONS.fillKeyConflictA, "BUY", "0.4", "10", "2026-10-07T11:00:00.000Z"),
      fill(sibling, "conflicting-key-native", CONDITIONS.fillKeyConflictB, "BUY", "0.4", "10", "2026-10-07T11:00:00.000Z"),
      fill(wallet, "current-conflict-buy", CONDITIONS.currentConflict, "BUY", "0.4", "10", "2026-10-07T12:00:00.000Z"),
      fill(wallet, "outcome-conflict-buy", CONDITIONS.outcomeConflict, "BUY", "0.4", "10", "2026-10-08T10:00:00.000Z"),
      fill(otherWallet, "other-buy", CONDITIONS.otherTenant, "BUY", "0.4", "10", "2026-10-01T10:00:00.000Z"),
      fill(paperWallet, "paper-partial-buy", CONDITIONS.partial, "BUY", "0.9", "100", "2026-10-01T10:00:00.000Z"),
    ]);

    await db.insert(polyTraderIngestionCursors).values([
      { traderWalletId: wallet, source: "data-api-positions", status: "ok", lastSuccessAt: new Date("2026-10-12T11:55:00.000Z") },
      { traderWalletId: sibling, source: "data-api-positions", status: "ok", lastSuccessAt: new Date("2026-10-12T11:55:00.000Z") },
    ]);
    await db.insert(polyTraderCurrentPositions).values([
      {
        traderWalletId: wallet,
        conditionId: CONDITIONS.reopened,
        tokenId: token(CONDITIONS.reopened),
        active: true,
        shares: "4",
        costBasisUsdc: "1",
        currentValueUsdc: "1.2",
        avgPrice: "0.25",
        contentHash: "reopened-current",
        lastObservedAt: new Date("2026-10-12T11:55:00.000Z"),
        firstObservedAt: new Date("2026-10-01T11:00:00.000Z"),
        raw: { curPrice: "0.3", outcome: "YES" },
      },
      ...[wallet, sibling].map((traderWalletId, index) => ({
        traderWalletId,
        conditionId: CONDITIONS.currentConflict,
        tokenId: token(CONDITIONS.currentConflict),
        active: true,
        shares: "10",
        costBasisUsdc: "4",
        currentValueUsdc: index === 0 ? "6" : "7",
        avgPrice: "0.4",
        contentHash: `current-conflict-${index}`,
        lastObservedAt: new Date("2026-10-12T11:55:00.000Z"),
        firstObservedAt: new Date("2026-10-07T12:00:00.000Z"),
        raw: { curPrice: index === 0 ? "0.6" : "0.7", outcome: "YES" },
      })),
    ]);

    const outcomes = [
      { conditionId: CONDITIONS.winner, outcome: "winner" as const, payout: "1" },
      { conditionId: CONDITIONS.winner.toUpperCase(), outcome: "winner" as const, payout: "1" },
      { conditionId: CONDITIONS.loser, outcome: "loser" as const, payout: "0" },
      { conditionId: CONDITIONS.outcomeConflict, outcome: "winner" as const, payout: "1" },
      { conditionId: CONDITIONS.outcomeConflict.toUpperCase(), outcome: "loser" as const, payout: "0" },
    ];
    outcomeConditions.push(...outcomes.map((entry) => entry.conditionId));
    await db.insert(polyMarketOutcomes).values(
      outcomes.map((entry) => ({
        ...entry,
        tokenId: token(entry.conditionId.toLowerCase()),
        resolvedAt: new Date("2026-10-10T12:00:00.000Z"),
      }))
    );
  });

  afterAll(async () => {
    await db.delete(polyMarketOutcomes).where(inArray(polyMarketOutcomes.conditionId, outcomeConditions));
    await db.delete(polyTraderCurrentPositions).where(inArray(polyTraderCurrentPositions.traderWalletId, walletIds));
    await db.delete(polyTraderIngestionCursors).where(inArray(polyTraderIngestionCursors.traderWalletId, walletIds));
    await db.delete(polyTraderFills).where(inArray(polyTraderFills.traderWalletId, walletIds));
    await db.delete(polyCopyTradeFills).where(inArray(polyCopyTradeFills.billingAccountId, [TENANT, OTHER_TENANT]));
    await db.delete(polyTraderWallets).where(inArray(polyTraderWallets.id, walletIds));
    await db.delete(billingAccounts).where(inArray(billingAccounts.id, [TENANT, OTHER_TENANT]));
    await db.delete(users).where(inArray(users.id, [USER, OTHER_USER]));
  });

  it("partitions every complete key once and never loses resolved or unmarked legs", async () => {
    const result = await readEconomicPositionProjection({
      db,
      billingAccountId: TENANT,
      walletAddress: ADDRESS,
      connectionKind: "privy_live",
      capturedAt: CAPTURED,
      interval: "ALL",
    });

    expect(result.liveCount).toBe(3);
    expect(result.closedCount).toBe(3);
    expect(result.incompleteCount).toBe(4);
    expect(result.walletIdentityCount).toBe(2);
    expect(result.fillIdentityConflictCount).toBe(3);
    expect(result.outcomeIdentityConflictCount).toBe(1);
    expect(result.currentIdentityConflictCount).toBe(1);
    expect(result.missingMarkCount).toBe(2);

    const liveIds = new Set(result.livePositions.map((position) => position.positionId));
    const closedIds = new Set(result.closedPositions.map((position) => position.positionId));
    expect([...liveIds].filter((id) => closedIds.has(id))).toEqual([]);
    expect(liveIds).toContain(`${CONDITIONS.partial}:${token(CONDITIONS.partial)}`);
    expect(liveIds).toContain(`${CONDITIONS.reopened}:${token(CONDITIONS.reopened)}`);
    expect([...liveIds, ...closedIds].some((id) => id.includes(CONDITIONS.otherTenant))).toBe(false);

    const winner = result.closedPositions.find((position) => position.conditionId === CONDITIONS.winner);
    expect(winner).toMatchObject({ status: "redeemable", lifecycleState: "winner", pnlUsd: null });
    const loser = result.closedPositions.find((position) => position.conditionId === CONDITIONS.loser);
    expect(loser).toMatchObject({ status: "closed", pnlUsd: null });
    const fullExit = result.closedPositions.find((position) => position.conditionId === CONDITIONS.fullExit);
    expect(fullExit).toMatchObject({ status: "closed", pnlUsd: null, closedAt: "2026-10-04T10:00:00.000Z" });

    const reopened = result.livePositions.find((position) => position.conditionId === CONDITIONS.reopened);
    expect(reopened).toMatchObject({ positionId: `${CONDITIONS.reopened}:${token(CONDITIONS.reopened)}`, size: 4, currentValue: 1.2, pnlUsd: 0.2 });
    const unmarked = result.livePositions.find((position) => position.conditionId === CONDITIONS.partial);
    expect(unmarked).toMatchObject({ size: 6, currentPrice: null, currentValue: null, pnlUsd: null, pnlPct: null });
    const currentConflict = result.livePositions.find((position) => position.conditionId === CONDITIONS.currentConflict);
    expect(currentConflict).toMatchObject({ size: 10, currentPrice: null, currentValue: null, pnlUsd: null, pnlPct: null });
  });
});

describe("current quantity authority and whole-position cost", () => {
  it("conserves newer zero, values held redeemable winners, and withholds a superseded zero", async () => {
    const db = getSeedDb();
    const address = `0x${randomUUID().replaceAll("-", "").padStart(40, "0")}`;
    const [wallet] = await db
      .insert(polyTraderWallets)
      .values({
        walletAddress: address,
        kind: "cogni_wallet",
        label: "zero-authority",
      })
      .returning();
    if (!wallet) throw new Error("missing wallet");
    const conditionId = `0x${randomUUID().replaceAll("-", "").padStart(64, "0")}`;
    const observed = new Date("2026-10-12T11:59:00Z");
    try {
      await db
        .insert(polyTraderIngestionCursors)
        .values({
          traderWalletId: wallet.id,
          source: "data-api-positions",
          status: "ok",
          lastSuccessAt: observed,
        });
      await db.insert(polyTraderCurrentPositions).values([
        {
          traderWalletId: wallet.id,
          conditionId,
          tokenId: "101",
          shares: "0",
          costBasisUsdc: "4",
          currentValueUsdc: "0",
          avgPrice: "0.4",
          active: false,
          contentHash: "zero",
          lastObservedAt: observed,
        },
        {
          traderWalletId: wallet.id,
          conditionId,
          tokenId: "102",
          shares: "67.41",
          costBasisUsdc: "28.61",
          currentValueUsdc: "28.3111",
          avgPrice: "0.424418",
          active: true,
          contentHash: "held",
          lastObservedAt: observed,
          raw: { cashPnl: -0.2989, curPrice: 0.42 },
        },
        {
          traderWalletId: wallet.id,
          conditionId,
          tokenId: "103",
          shares: "10",
          costBasisUsdc: "4",
          currentValueUsdc: "10",
          avgPrice: "0.4",
          active: false,
          contentHash: "redeemable",
          lastObservedAt: observed,
          raw: { redeemable: true, curPrice: 1, cashPnl: 6 },
        },
      ]);
      await db
        .insert(polyTraderFills)
        .values(
          ["101", "102", "103"].map((tokenId) => ({
            traderWalletId: wallet.id,
            source: "data-api",
            nativeId: `partial-${tokenId}`,
            conditionId,
            tokenId,
            side: "BUY",
            shares: "10",
            sizeUsdc: "4",
            price: "0.4",
            observedAt: new Date("2026-10-12T10:00:00Z"),
          })),
        );
      await db
        .insert(polyMarketOutcomes)
        .values({
          conditionId,
          tokenId: "103",
          outcome: "winner",
          payout: "1",
          resolvedAt: new Date("2026-10-12T11:00:00Z"),
        });
      await db.insert(polyTraderCurrentPositions).values({ traderWalletId: wallet.id, conditionId, tokenId: "104", shares: "0", costBasisUsdc: "4", currentValueUsdc: "0", avgPrice: "0.4", active: false, contentHash: "closed-zero", lastObservedAt: observed });
      await db.insert(polyTraderFills).values({ traderWalletId: wallet.id, source: "data-api", nativeId: "closed-zero-buy", conditionId, tokenId: "104", side: "BUY", shares: "10", sizeUsdc: "4", price: "0.4", observedAt: new Date("2026-10-12T10:00:00Z") });
      await db.insert(polyMarketOutcomes).values({ conditionId, tokenId: "104", outcome: "loser", payout: "0", resolvedAt: new Date("2026-10-12T11:00:00Z") });
      const read = () =>
        readEconomicPositionProjection({
          db,
          billingAccountId: "no-execution-lineage",
          walletAddress: address,
          connectionKind: "privy_live",
          capturedAt: CAPTURED,
          interval: "ALL",
        });
      const result = await read();
      expect(result.positionsMtm).toBe(38.31);
      expect(result.livePositions.map((row) => row.asset)).toEqual(["102"]);
      expect(result.livePositions[0]).toMatchObject({
        size: 67.41,
        currentValue: 28.31,
        pnlUsd: -0.3,
      });
      expect(
        result.closedPositions.find((row) => row.asset === "103"),
      ).toMatchObject({ status: "redeemable", currentValue: 10, pnlUsd: null });
      expect(
        result.positionFacts.find((row) => row.tokenId === "102"),
      ).toMatchObject({
        remainingBasisUsdc: 28.61,
        unrealizedPnlUsdc: -0.2989,
        lifetimePnlUsdc: null,
        inventoryCoverage: "complete",
        economicsCoverage: "partial",
      });
      expect(result.historyIncompleteCount).toBeGreaterThan(0);
      expect(result.positionFacts.find((row) => row.tokenId === "104")?.inventoryCoverage).toBe("complete");
      await db.update(polyTraderIngestionCursors).set({ status: "stale", lastSuccessAt: new Date("2026-10-12T10:00:00Z") }).where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id));
      const staleZero = (await read()).positionFacts.find((row) => row.tokenId === "104");
      expect(staleZero).toMatchObject({ heldShares: 0, inventoryCoverage: "stale" });
      await db.update(polyTraderIngestionCursors).set({ status: "ok", lastSuccessAt: observed }).where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id));
      // An old zero may not hide a genuinely newer BUY before observation catches up.
      await db
        .insert(polyTraderFills)
        .values({
          traderWalletId: wallet.id,
          source: "data-api",
          nativeId: "new-after-zero",
          conditionId,
          tokenId: "101",
          side: "BUY",
          shares: "5",
          sizeUsdc: "2",
          price: "0.4",
          observedAt: new Date("2026-10-12T11:59:30Z"),
        });
      expect((await read()).positionsMtm).toBeNull();
      // A current row from after the frozen snapshot cannot be borrowed backwards.
      await db
        .update(polyTraderCurrentPositions)
        .set({ lastObservedAt: new Date("2026-10-12T12:01:00Z") })
        .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
      expect((await read()).positionsMtm).toBeNull();
    } finally {
      await db
        .delete(polyMarketOutcomes)
        .where(eq(polyMarketOutcomes.conditionId, conditionId));
      await db
        .delete(polyTraderWallets)
        .where(eq(polyTraderWallets.id, wallet.id));
    }
  });
});

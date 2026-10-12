// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Authoritative lifetime-token-leg partition and economic-P/L coverage. */
import { randomUUID } from "node:crypto";
import {
  polyMarketOutcomes,
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
        observedAt: new Date(`2026-10-0${index + 1}T10:00:00.000Z`),
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
      fill(wallet, "outcome-conflict-buy", CONDITIONS.outcomeConflict, "BUY", "0.4", "10", "2026-10-08T10:00:00.000Z"),
      fill(otherWallet, "other-buy", CONDITIONS.otherTenant, "BUY", "0.4", "10", "2026-10-01T10:00:00.000Z"),
      fill(paperWallet, "paper-partial-buy", CONDITIONS.partial, "BUY", "0.9", "100", "2026-10-01T10:00:00.000Z"),
    ]);

    await db.insert(polyTraderCurrentPositions).values({
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
    });

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

    expect(result.liveCount).toBe(2);
    expect(result.closedCount).toBe(3);
    expect(result.incompleteCount).toBe(4);
    expect(result.walletIdentityCount).toBe(2);
    expect(result.fillIdentityConflictCount).toBe(3);
    expect(result.outcomeIdentityConflictCount).toBe(1);
    expect(result.missingMarkCount).toBe(1);

    const liveIds = new Set(result.livePositions.map((position) => position.positionId));
    const closedIds = new Set(result.closedPositions.map((position) => position.positionId));
    expect([...liveIds].filter((id) => closedIds.has(id))).toEqual([]);
    expect(liveIds).toContain(`${CONDITIONS.partial}:${token(CONDITIONS.partial)}`);
    expect(liveIds).toContain(`${CONDITIONS.reopened}:${token(CONDITIONS.reopened)}`);
    expect([...liveIds, ...closedIds].some((id) => id.includes(CONDITIONS.otherTenant))).toBe(false);

    const winner = result.closedPositions.find((position) => position.conditionId === CONDITIONS.winner);
    expect(winner).toMatchObject({ status: "redeemable", lifecycleState: "winner", pnlUsd: 6 });
    const loser = result.closedPositions.find((position) => position.conditionId === CONDITIONS.loser);
    expect(loser).toMatchObject({ status: "closed", pnlUsd: -4 });
    const fullExit = result.closedPositions.find((position) => position.conditionId === CONDITIONS.fullExit);
    expect(fullExit).toMatchObject({ status: "closed", pnlUsd: 2, closedAt: "2026-10-04T10:00:00.000Z" });

    const reopened = result.livePositions.find((position) => position.conditionId === CONDITIONS.reopened);
    expect(reopened).toMatchObject({ positionId: `${CONDITIONS.reopened}:${token(CONDITIONS.reopened)}`, size: 4, currentValue: 1.2, pnlUsd: 1.2 });
    const unmarked = result.livePositions.find((position) => position.conditionId === CONDITIONS.partial);
    expect(unmarked).toMatchObject({ size: 6, currentPrice: 0.6, currentValue: 3.6, pnlUsd: 2 });
  });
});

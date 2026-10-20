// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real PostgreSQL: false-error history, atomic native replacement, cursor isolation. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { toUserId, userActor } from "@cogni/ids";
import {
  polyTraderCurrentPositions,
  polyTraderFillRollupsDaily,
  polyTraderFills,
  polyTraderIngestionCursors,
  polyTraderPositionSnapshots,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import type { LoggerPort } from "@cogni/poly-market-provider";
import type { PolymarketDataApiClient } from "@cogni/poly-market-provider/adapters/polymarket";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { getCopyTradeInvestigationSummary } from "@/features/wallet-analysis/server/copy-trade-investigation-service";
import { readEconomicPositionProjection } from "@/features/wallet-analysis/server/economic-position-read-model";
import { recoverEconomicObservations } from "@/features/wallet-analysis/server/economic-observation-recovery";
import {
  billingAccounts,
  polyCopyTradeFills,
  polyWalletConnections,
  users,
} from "@/shared/db/schema";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../_fixtures/poly/economic-recovery-bcgame.json", import.meta.url),
    "utf8",
  ),
);

// Discovery deliberately has a global LIMIT 1. Exercise the real SQL with an
// app-role tenant scope so another suite's valid cohort cannot consume a retry.
function recoverForUser(
  userId: string,
  input: Parameters<typeof recoverEconomicObservations>[0],
) {
  return withTenantScope(getAppDb(), userActor(toUserId(userId)), (tx) =>
    recoverEconomicObservations({ ...input, db: tx as never }),
  );
}

describe("native economic observation persistence", () => {
  it.each(["current", "same-day rollup", "future-day rollup"] as const)(
    "does not discover a future %s cohort or call its upstream client",
    async (source) => {
      const db = getSeedDb();
      const userId = randomUUID(), account = randomUUID();
      const address = `0x${randomUUID().replaceAll("-", "").padStart(40, "0")}`;
      // An early fixed capture also makes every other suite's contemporary
      // fixture a future neighbor rather than legitimate recovery work.
      const now = new Date("2000-01-15T12:00:00Z");
      const future = new Date(now.getTime() + (source === "future-day rollup" ? 86_400_000 : 60_000));
      const conditionId = `0x${"8".repeat(64)}`;
      await db.insert(users).values({ id: userId, name: "future recovery neighbor" });
      await db.insert(billingAccounts).values({ id: account, ownerUserId: userId, balanceCredits: 0n });
      await db.insert(polyWalletConnections).values({ billingAccountId: account, createdByUserId: userId,
        address, funderAddress: address, privyWalletId: userId,
        clobApiKeyCiphertext: Buffer.from("test"), encryptionKeyId: "test",
        custodialConsentAcceptedAt: now, custodialConsentActorKind: "user", custodialConsentActorId: userId });
      const [wallet] = await db.insert(polyTraderWallets).values({ walletAddress: address, kind: "cogni_wallet", label: "future recovery neighbor" }).returning();
      if (!wallet) throw new Error("future recovery wallet missing");
      try {
        if (source === "current") {
          await db.insert(polyTraderCurrentPositions).values({ traderWalletId: wallet.id, conditionId, tokenId: "888",
            shares: "10", costBasisUsdc: "4", currentValueUsdc: "6", avgPrice: "0.4",
            contentHash: "future-recovery-current", firstObservedAt: future, lastObservedAt: future, raw: {} });
        } else {
          await db.insert(polyTraderFillRollupsDaily).values({ traderWalletId: wallet.id, conditionId, tokenId: "888",
            day: future.toISOString().slice(0, 10), fillCount: 1, buyCount: 1, sellCount: 0,
            buyUsdc: "4", sellUsdc: "0", buyShares: "10", sellShares: "0",
            firstBuyObservedAt: future, firstObservedAt: future, lastObservedAt: future });
        }
        const listClosed = vi.fn().mockResolvedValue({ positions: [], requestCount: 1 });
        const listActivity = vi.fn().mockResolvedValue({ activity: [], requestCount: 1 });
        const readSettlement = vi.fn();
        await recoverForUser(userId, { db, now, client: {
          listUserPositionsV2Raw: listClosed, listConditionActivityV2: listActivity,
        } as unknown as PolymarketDataApiClient, readSettlement,
          logger: { info: vi.fn() } as unknown as LoggerPort });
        expect(listClosed).not.toHaveBeenCalled();
        expect(listActivity).not.toHaveBeenCalled();
        expect(readSettlement).not.toHaveBeenCalled();
        expect(await db.select().from(polyTraderPositionSnapshots).where(eq(polyTraderPositionSnapshots.traderWalletId, wallet.id))).toEqual([]);
        expect(await db.select().from(polyTraderIngestionCursors).where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id))).toEqual([]);
      } finally {
        await db.delete(polyTraderWallets).where(eq(polyTraderWallets.id, wallet.id));
        await db.delete(billingAccounts).where(eq(billingAccounts.id, account));
        await db.delete(users).where(eq(users.id, userId));
      }
    },
  );

  it("recovers both false-error legs once, preserving execution/fill cursors and exact native economics", async () => {
    const db = getSeedDb();
    const suffix = randomUUID();
    const userId = randomUUID();
    const account = `native-account-${suffix}`;
    const address = `0x${suffix.replaceAll("-", "").padStart(40, "0")}`;
    const conditionId = fixture.provenance.conditionId;
    const positions = fixture.positions.map((row: Record<string, unknown>) => ({
      ...row,
      proxy_wallet: address,
    }));
    const activity = fixture.activity.map((row: Record<string, unknown>) => ({
      ...row,
      proxy_wallet: address,
    }));
    const winner = positions.find((row: { current_price: number }) => row.current_price === 1);
    await db.insert(users).values({ id: userId, name: "native economic test" });
    await db
      .insert(billingAccounts)
      .values({ id: account, ownerUserId: userId, balanceCredits: 0n });
    await db
      .insert(polyWalletConnections)
      .values({
        billingAccountId: account,
        createdByUserId: userId,
        address,
        funderAddress: address,
        privyWalletId: suffix,
        clobApiKeyCiphertext: Buffer.from("test"),
        encryptionKeyId: "test",
        custodialConsentAcceptedAt: new Date(),
        custodialConsentActorKind: "user",
        custodialConsentActorId: userId,
      });
    const [wallet] = await db
      .insert(polyTraderWallets)
      .values({ walletAddress: address, kind: "cogni_wallet", label: suffix })
      .returning();
    if (!wallet || !winner) throw new Error("fixture failed");
    const now = new Date("2026-10-15T14:35:00Z");
    await db
      .insert(polyCopyTradeFills)
      .values({
        billingAccountId: account,
        createdByUserId: userId,
        targetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        fillId: suffix,
        clientOrderId: suffix,
        marketId: `prediction-market:polymarket:${conditionId}`,
        observedAt: new Date("2026-10-15T12:00:00Z"),
        status: "error",
        mode: "live",
        attributes: { condition_id: conditionId, token_id: winner.token_id, size_usdc: "50" },
      });
    await db
      .insert(polyTraderIngestionCursors)
      .values({
        traderWalletId: wallet.id,
        source: "data-api-trades",
        lastSeenAt: now,
        lastSuccessAt: now,
        status: "ok",
      });
    const oldInventoryAt = new Date("2026-10-15T14:30:00Z");
    await db.insert(polyTraderCurrentPositions).values({ traderWalletId: wallet.id, conditionId, tokenId: winner.token_id,
      shares: "229.28", costBasisUsdc: "49.23874", currentValueUsdc: "229.28", avgPrice: "0.21475375",
      active: false, contentHash: "pre-redemption-positive", firstObservedAt: new Date("2026-10-15T12:00:00Z"), lastObservedAt: oldInventoryAt,
      raw: { redeemable: true, curPrice: 1 } });
    await db.insert(polyTraderIngestionCursors).values({ traderWalletId: wallet.id, source: "data-api-positions", lastSuccessAt: now, status: "ok" });
    const listClosed = vi.fn().mockResolvedValue({ positions, requestCount: 1 });
    const listActivity = vi.fn().mockResolvedValue({ activity, requestCount: 1 });
    const readSettlement = vi
      .fn()
      .mockResolvedValue({
        txHash: fixture.receipt.transactionHash,
        blockNumber: BigInt(fixture.receipt.blockNumber).toString(),
        blockHash: fixture.receipt.blockHash,
        logIndex: Number(
          fixture.receipt.logs.find(
            (row: { address: string; topics: string[] }) =>
              row.address.toLowerCase() === "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb" &&
              row.topics.length === 3,
          ).logIndex,
        ),
        collateral: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
        atomicAmount: "229280000",
        recipient: address,
        conditionId,
        tokenId: winner.token_id,
        sharesAtomic: "229280000",
      });
    const client = {
      listUserPositionsV2Raw: listClosed,
      listConditionActivityV2: listActivity,
    } as unknown as PolymarketDataApiClient;
    const input = {
      db,
      client,
      readSettlement,
      logger: { info: vi.fn() } as unknown as LoggerPort,
      now,
    };
    try {
      await recoverForUser(userId, input);
      const before = await db
        .select()
        .from(polyTraderPositionSnapshots)
        .where(eq(polyTraderPositionSnapshots.traderWalletId, wallet.id));
      const read = await readEconomicPositionProjection({
        db,
        billingAccountId: account,
        walletAddress: address,
        connectionKind: "privy_live",
        capturedAt: new Date(now.getTime() + 1000),
        interval: "1W",
      });
      expect(read.positionsMtm).toBeNull(); // payout cannot coexist with an older positive MTM
      expect(read.positionFacts.find((row) => row.tokenId === winner.token_id)?.inventoryCoverage).toBe("unavailable");
      const current = await db.select().from(polyTraderCurrentPositions).where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
      expect(current[0]?.shares).toBe("229.28000000");
      expect(current[0]?.lastObservedAt).toEqual(oldInventoryAt); // history does not publish inventory
      expect(read.closedCount).toBe(2);
      expect(read.closedPositions).toHaveLength(2);
      const proof = read.closedPositions.find(
        (row) => row.asset === winner.token_id,
      )?.economicProof;
      expect(proof).toMatchObject({
        coverage: "complete",
        buyUsdc: 49.23874,
        buyShares: 229.28,
        redeemUsdc: 229.28,
        lifetimePnlUsdc: 180.04126,
        sourceRecordCount: 30,
      });
      expect(read.closedPositions.find((row) => row.asset === winner.token_id)).toMatchObject({
        entryPrice: 0.21475375,
        size: 229.28,
        status: "closed",
        pnlUsd: 180.04,
      });
      await recoverForUser(userId, { ...input, now: new Date(now.getTime() + 60_000) });
      expect(
        await db
          .select()
          .from(polyTraderPositionSnapshots)
          .where(eq(polyTraderPositionSnapshots.traderWalletId, wallet.id)),
      ).toEqual(before);
      expect(listClosed).toHaveBeenCalledTimes(1);
      expect(listActivity).toHaveBeenCalledTimes(1);
      expect(readSettlement).toHaveBeenCalledTimes(1);
      expect(
        await db
          .select()
          .from(polyTraderFills)
          .where(eq(polyTraderFills.traderWalletId, wallet.id)),
      ).toEqual([]);
      const cursor = await db
        .select()
        .from(polyTraderIngestionCursors)
        .where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id));
      expect(cursor).toHaveLength(2);
      expect(cursor.find((row) => row.source === "data-api-trades")?.lastSeenAt).toEqual(now);
      const ledger = await db
        .select()
        .from(polyCopyTradeFills)
        .where(eq(polyCopyTradeFills.billingAccountId, account));
      expect(ledger[0]?.status).toBe("error");
      expect(ledger[0]?.orderId).toBeNull();
      // Only a newer canonical publication can clear the held inventory.
      await db.update(polyTraderCurrentPositions).set({ shares: "0", currentValueUsdc: "0", lastObservedAt: now }).where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
      const afterPublication = await readEconomicPositionProjection({ db, billingAccountId: account, walletAddress: address, connectionKind: "privy_live", capturedAt: new Date(now.getTime()+1000), interval: "1W" });
      expect(afterPublication.positionsMtm).toBe(0);
      expect(afterPublication.closedPositions.find((row) => row.asset === winner.token_id)?.economicProof?.lifetimePnlUsdc).toBe(180.04126);
      // Populate 31 more recent exits so the audited winner is outside newest 30.
      await db.insert(polyTraderFills).values(Array.from({length:31}, (_, i) =>
        (["BUY", "SELL"] as const).map((side) => ({
          traderWalletId: wallet.id, source: "data-api" as const,
          nativeId: `preview-${side}-${i}`, conditionId: `${conditionId}-preview-${i}`,
          tokenId: `preview-${i}`, side, price: "0.5", shares: "1", sizeUsdc: "0.5",
          observedAt: new Date(now.getTime() - (side === "BUY" ? 1000 : 0)), raw: {},
        }))
      ).flat());
      const bounded = await readEconomicPositionProjection({ db, billingAccountId: account, walletAddress: address,
        connectionKind: "privy_live", capturedAt: new Date(now.getTime()+1000), interval: "1W" });
      expect(bounded.closedPositions).toHaveLength(30);
      expect(bounded.closedPositions.some((row) => row.asset === winner.token_id)).toBe(false);
      // Exact-condition proof is independent of global preview ordering/caps.
      const requested = {
        billing_account_id: account,
        condition_id: conditionId,
        mode: "live" as const,
        token_id: winner.token_id,
      };
      const detail = await getCopyTradeInvestigationSummary(db, requested);
      expect(detail?.economic_proofs).toEqual([
        { mode: "live", token_id: winner.token_id, proof },
      ]);
      expect(detail?.economic_proofs_truncated).toBe(false);
      expect(
        (
          await getCopyTradeInvestigationSummary(db, {
            ...requested,
            token_id: "not-this-token",
          })
        )?.economic_proofs,
      ).toEqual([]);
      expect(
        await getCopyTradeInvestigationSummary(db, {
          ...requested,
          mode: "paper",
        }),
      ).toBeNull();
      expect(
        await getCopyTradeInvestigationSummary(db, {
          ...requested,
          billing_account_id: `other-${suffix}`,
        }),
      ).toBeNull();
    } finally {
      await db.delete(polyCopyTradeFills).where(eq(polyCopyTradeFills.billingAccountId, account));
      await db.delete(polyTraderWallets).where(eq(polyTraderWallets.id, wallet.id));
      await db
        .delete(polyWalletConnections)
        .where(eq(polyWalletConnections.billingAccountId, account));
      await db.delete(billingAccounts).where(eq(billingAccounts.id, account));
      await db.delete(users).where(eq(users.id, userId));
    }
  });
});

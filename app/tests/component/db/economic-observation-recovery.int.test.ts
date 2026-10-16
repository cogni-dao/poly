// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real PostgreSQL: false-error history, atomic native replacement, cursor isolation. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
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

describe("native economic observation persistence", () => {
  it("recovers both false-error legs once, preserving execution/fill cursors and exact native economics", async () => {
    const db = getSeedDb();
    const suffix = randomUUID();
    const userId = `native-user-${suffix}`;
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
    const now = new Date("2026-10-16T07:00:00Z");
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
      await recoverEconomicObservations(input);
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
      await recoverEconomicObservations({ ...input, now: new Date(now.getTime() + 60_000) });
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
      expect(cursor).toHaveLength(1);
      expect(cursor[0]?.lastSeenAt).toEqual(now);
      const ledger = await db
        .select()
        .from(polyCopyTradeFills)
        .where(eq(polyCopyTradeFills.billingAccountId, account));
      expect(ledger[0]?.status).toBe("error");
      expect(ledger[0]?.orderId).toBeNull();
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

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * bug.5062: a tenant wallet's total needs a fresh saved mark for EVERY held
 * token. The Data API v2 value floor (`filter_type=CASH`, PR #293) silently
 * dropped worthless REDEEMABLE rows from the observer page, so their saved
 * rows stopped refreshing and withheld the whole-wallet MTM/total forever.
 * Real Postgres, real writer, real economic projection.
 */
import { randomUUID } from "node:crypto";
import type {
  PolymarketDataApiClient,
  PolymarketUserPosition,
} from "@cogni/poly-market-provider/adapters/polymarket";
import {
  polyTraderCurrentPositions,
  polyTraderFills,
  polyTraderIngestionCursors,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  PositionObservationController,
  refreshCurrentPositionsForWallet,
} from "@/features/wallet-analysis/server/trader-observation-service";
import { readTenantWalletDashboard } from "@/features/wallet-analysis/server/tenant-wallet-dashboard-service";
import {
  billingAccounts,
  polyWalletBalanceSnapshots,
  polyWalletConnections,
  users,
} from "@/shared/db/schema";

const WORTHLESS_COUNT = 40;

describe("tenant wallet marks survive the Data API value floor (bug.5062)", () => {
  const db = getSeedDb();

  it("refreshes worthless REDEEMABLE rows so MTM and total stay numbers", async () => {
    const suffix = randomUUID();
    const userId = `marks-${suffix}`;
    const account = `marks-${suffix}`;
    const address = `0x${suffix.replaceAll("-", "").padStart(40, "c")}`;
    const cond = (n: number) =>
      `0x${(n + 1).toString(16).padStart(8, "0")}${suffix.replaceAll("-", "").padStart(56, "a")}`;
    const open = (conditionId: string, token: string, value: number): PolymarketUserPosition => ({
      proxyWallet: address, asset: token, conditionId, size: 5, avgPrice: 0.54,
      initialValue: 2.7, currentValue: value, cashPnl: value - 2.7, percentPnl: 0,
      totalBought: 5, realizedPnl: 0, percentRealizedPnl: 0, curPrice: value / 5,
      redeemable: false, mergeable: false, title: `Open ${token}`, slug: `open-${token}`,
      icon: "", eventId: suffix, eventSlug: `open-${token}`, outcome: "Yes", outcomeIndex: 0,
      oppositeOutcome: "No", oppositeAsset: `${token}9`, endDate: "2027-01-01", negativeRisk: false,
    });
    const worthless = (n: number): PolymarketUserPosition => ({
      ...open(cond(n), `7${n}`, 0), size: 3, initialValue: 1.5, currentValue: 0, cashPnl: -1.5,
      curPrice: 0, redeemable: true, title: `Lost ${n}`, slug: `lost-${n}`, eventSlug: `lost-${n}`,
      endDate: "2026-10-18",
    });
    const book = [
      open(cond(0), "70", 0.475),
      ...Array.from({ length: WORTHLESS_COUNT }, (_, i) => worthless(i + 1)),
    ];

    await db.insert(users).values({ id: userId, name: userId, walletAddress: address });
    await db.insert(billingAccounts).values({ id: account, ownerUserId: userId, balanceCredits: 0n });
    await db.insert(polyWalletConnections).values({
      billingAccountId: account, createdByUserId: userId, kind: "privy_live",
      privyWalletId: `privy-${account}`, address, funderAddress: address,
      clobApiKeyCiphertext: Buffer.from("component-test"), encryptionKeyId: "component-test",
      custodialConsentAcceptedAt: new Date(), custodialConsentActorKind: "user", custodialConsentActorId: userId,
    });
    await db.insert(polyWalletBalanceSnapshots).values({
      billingAccountId: account, address, usdcE: "100", pusd: "0", pol: "1", status: "ok", errors: [], observedAt: new Date(),
    });
    const [wallet] = await db.insert(polyTraderWallets)
      .values({ walletAddress: address, kind: "cogni_wallet", label: userId }).returning({ id: polyTraderWallets.id });
    if (!wallet) throw new Error("wallet seed failed");
    try {
      await db.insert(polyTraderIngestionCursors).values({
        traderWalletId: wallet.id, source: "data-api-positions", status: "ok", lastSuccessAt: new Date(Date.now() - 3_600_000),
      });
      await db.insert(polyTraderFills).values(book.map((row, index) => ({
        traderWalletId: wallet.id, source: "data-api" as const, nativeId: `${suffix}-${index}`,
        conditionId: row.conditionId, tokenId: row.asset, side: "BUY" as const, price: "0.5",
        shares: String(row.size), sizeUsdc: String(row.initialValue), observedAt: new Date(Date.now() - 7_200_000),
      })));
      // State left by the value-floor builds: worthless rows saved long ago,
      // never refreshed again.
      await db.insert(polyTraderCurrentPositions).values(
        book.slice(1).map((row, index) => ({
          traderWalletId: wallet.id, conditionId: row.conditionId, tokenId: row.asset, active: false,
          shares: String(row.size), costBasisUsdc: String(row.initialValue), currentValueUsdc: "0", avgPrice: "0.5",
          contentHash: `${suffix}-stale-${index}`, firstObservedAt: new Date(Date.now() - 7_200_000),
          lastObservedAt: new Date(Date.now() - 3_600_000),
          raw: { title: row.title, curPrice: "0", redeemable: true, outcome: "Yes", endDate: "2026-10-18" },
        })),
      );

      // The CASH-floored page (value-bearing rows only), as the Data API serves it.
      const listUserPositions = vi.fn(async (_wallet: string, params?: { minValueUsdc?: number }) => ({
        rows: params?.minValueUsdc === undefined ? book : book.filter((row) => row.currentValue >= params.minValueUsdc!),
        nextCursor: null,
      }));
      const readPositionBalances = vi.fn(async ({ tokenIds }: { tokenIds: readonly string[] }) =>
        tokenIds.map(() => 3_000_000n));
      const refresh = () => refreshCurrentPositionsForWallet({
        db, walletAddress: address, client: { listUserPositions } as unknown as PolymarketDataApiClient,
        positionControl: new PositionObservationController({ now: () => Date.now() + 60_000, wait: async () => {}, random: () => 0 }),
        readPositionBalances,
      });

      // Control: one pass of the value-floored page (the #293 builds). The
      // observer is fresh, yet the stale worthless rows withhold the total.
      listUserPositions.mockImplementationOnce(async () => ({ rows: [book[0]!], nextCursor: null }));
      expect(await refresh()).toMatchObject({ complete: true, positionRows: 1 });
      const before = await readTenantWalletDashboard({ db, billingAccountId: account, interval: "1M", adapterConfigured: true });
      expect(before.facts.positions.status).toBe("partial");
      expect(before.overview.usdc_positions_mtm).toBeNull();
      expect(before.overview.usdc_total).toBeNull();
      expect(before.warnings.map((w) => w.code)).toContain("positions_current_mark_unavailable");
      listUserPositions.mockClear();
      readPositionBalances.mockClear();

      expect(await refresh()).toMatchObject({ complete: true, positionRows: WORTHLESS_COUNT + 1 });
      // Tenant wallets read the complete book: no value floor, so no chain
      // authority probe is needed to explain a worthless omission either.
      expect(listUserPositions).toHaveBeenCalledTimes(1);
      expect(listUserPositions.mock.calls[0]?.[1]).toMatchObject({ sizeThreshold: 0 });
      expect(listUserPositions.mock.calls[0]?.[1]).not.toHaveProperty("minValueUsdc");
      expect(readPositionBalances).not.toHaveBeenCalled();

      const after = await readTenantWalletDashboard({ db, billingAccountId: account, interval: "1M", adapterConfigured: true });
      expect(after.overview.usdc_positions_mtm).toBe(0.48);
      expect(after.overview.usdc_total).toBe(100.48);
      expect(after.facts.positions.status).toBe("fresh");
      expect(after.facts.total.status).toBe("fresh");
      expect(after.warnings.map((w) => w.code)).not.toContain("positions_current_mark_unavailable");
      expect(after.warnings.map((w) => w.code)).not.toContain("wallet_total_unavailable");
    } finally {
      await db.delete(billingAccounts).where(eq(billingAccounts.id, account));
      await db.delete(users).where(eq(users.id, userId));
      await db.delete(polyTraderWallets).where(eq(polyTraderWallets.id, wallet.id));
    }
  }, 60_000);
});

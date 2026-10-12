// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Fill-authoritative origin survives without a decision row or active target assignment. */
import { randomUUID } from "node:crypto";
import {
  polyTraderCurrentPositions,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAlgorithmOriginProjection } from "@/features/wallet-analysis/server/algorithm-origin-read-model";
import {
  billingAccounts,
  polyAlgorithmInputSnapshots,
  polyCopyTradeFills,
  users,
} from "@/shared/db/schema";

const USER = `origin-user-${randomUUID()}`;
const ACCOUNT = `origin-account-${randomUUID()}`;
const TARGET_ID = randomUUID();
const TARGET = `0x${randomUUID()
  .replaceAll("-", "")
  .padEnd(40, "0")
  .slice(0, 40)}`;
const CONDITION = "condition-origin-a";
const TOKEN = "token-origin-a";
const HASH = `sha256:${"a".repeat(64)}`;
const VERSION_HASH = `sha256:${"b".repeat(64)}`;
const CONFIG_HASH = `sha256:${"c".repeat(64)}`;
let targetWalletId = "";

describe("algorithm origin read model", () => {
  const db = getSeedDb();

  beforeAll(async () => {
    await db.insert(users).values({ id: USER, name: USER });
    await db.insert(billingAccounts).values({
      id: ACCOUNT,
      ownerUserId: USER,
      balanceCredits: 0n,
    });
    const inserted = await db
      .insert(polyTraderWallets)
      .values({
        walletAddress: TARGET,
        kind: "copy_target",
        label: "Origin target",
      })
      .returning({ id: polyTraderWallets.id });
    targetWalletId = inserted[0]?.id ?? "";
    if (!targetWalletId) throw new Error("target wallet seed failed");
    await db.insert(polyTraderCurrentPositions).values({
      traderWalletId: targetWalletId,
      conditionId: CONDITION,
      tokenId: TOKEN,
      active: true,
      shares: "4",
      costBasisUsdc: "2",
      currentValueUsdc: "2.4",
      avgPrice: "0.5",
      contentHash: `origin-current-${randomUUID()}`,
      firstObservedAt: new Date("2026-10-12T09:00:00.000Z"),
      lastObservedAt: new Date("2026-10-12T12:00:00.000Z"),
    });
    await db.insert(polyAlgorithmInputSnapshots).values({
      billingAccountId: ACCOUNT,
      inputSnapshotId: HASH,
      createdByUserId: USER,
      algorithmId: "poly.copy-mirror.target-percentile-scaled",
      inputContractVersion: "fill-facts-v2",
      canonicalInput: {
        fill: {
          target_wallet: TARGET,
          market_id: `prediction-market:polymarket:${CONDITION}`,
          observed_at: "2026-10-12T10:00:00.000Z",
          size_usdc: 3,
          price: 0.3,
          attributes: { condition_id: CONDITION, asset: TOKEN },
        },
        state: {
          target_position: {
            condition_id: CONDITION,
            tokens: [{ token_id: TOKEN, cost_usdc: 12, size_shares: 30 }],
          },
        },
      },
      quality: { validation: "validated" },
    });
    await db.insert(polyCopyTradeFills).values({
      billingAccountId: ACCOUNT,
      createdByUserId: USER,
      targetId: TARGET_ID,
      fillId: "data-api:origin:token:BUY:1",
      marketId: `prediction-market:polymarket:${CONDITION}`,
      observedAt: new Date("2026-10-12T10:00:01.000Z"),
      clientOrderId: `origin-client-${randomUUID()}`,
      orderId: `origin-order-${randomUUID()}`,
      status: "filled",
      positionLifecycle: "open",
      mode: "live",
      algorithmId: "poly.copy-mirror.target-percentile-scaled",
      algorithmVersionId: VERSION_HASH,
      configHash: CONFIG_HASH,
      inputSnapshotId: HASH,
      assignmentId: "assignment-origin-a",
      correlationId: "correlation-origin-a",
      shares: "5",
      attributes: {
        condition_id: CONDITION,
        token_id: TOKEN,
        target_wallet: TARGET,
        filled_size_usdc: "2",
        limit_price: "0.4",
      },
    });
  });

  afterAll(async () => {
    await db
      .delete(polyCopyTradeFills)
      .where(eq(polyCopyTradeFills.billingAccountId, ACCOUNT));
    await db
      .delete(polyAlgorithmInputSnapshots)
      .where(eq(polyAlgorithmInputSnapshots.billingAccountId, ACCOUNT));
    if (targetWalletId) {
      await db
        .delete(polyTraderCurrentPositions)
        .where(eq(polyTraderCurrentPositions.traderWalletId, targetWalletId));
      await db
        .delete(polyTraderWallets)
        .where(eq(polyTraderWallets.id, targetWalletId));
    }
    await db.delete(billingAccounts).where(eq(billingAccounts.id, ACCOUNT));
    await db.delete(users).where(eq(users.id, USER));
  });

  it("proves the origin from the executed fill and keeps target-now optional", async () => {
    const result = await readAlgorithmOriginProjection({
      db,
      billingAccountId: ACCOUNT,
      connectionKind: "privy_live",
      capturedAt: new Date("2026-10-12T12:30:00.000Z"),
      previewPositionKeys: [{ conditionId: CONDITION, tokenId: TOKEN }],
    });

    expect(result.coverage).toMatchObject({
      originPositionCount: 1,
      originEventCount: 1,
      completeEventCount: 1,
      originLayerCount: 1,
      comparableLayerCount: 1,
      previewLayerCount: 1,
      previewTruncated: false,
    });
    expect(
      result.byPositionKey.get(`${CONDITION}\u0000${TOKEN}`)?.[0]
    ).toMatchObject({
      algorithmId: "poly.copy-mirror.target-percentile-scaled",
      assignmentId: "assignment-origin-a",
      correlationId: "correlation-origin-a",
      targetAtDecision: { costBasisUsdc: 12, shares: 30 },
      targetNow: { costBasisUsdc: 2, shares: 4, currentValueUsdc: 2.4 },
      comparisonStatus: "comparable",
    });
    expect(
      result.layerCountByPositionKey.get(`${CONDITION}\u0000${TOKEN}`)
    ).toBe(1);
  });
});

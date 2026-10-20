// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Real saved publication -> per-field reader -> bounded comparison assembly. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { toUserId, userActor } from "@cogni/ids";
import { noopMetrics, type OrderReceipt, type TargetBookSnapshotV1 } from "@cogni/poly-market-provider";
import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPolyTradeExecutorFactory } from "@/bootstrap/capabilities/poly-trade-executor";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { buildPositionGapBuyIntent } from "@/features/copy-trade/position-gap-actor";
import { createExecutionVenueResolver, createPaperVenue, derivePaperAccountAddress } from "@/features/paper-accounts";
import { createOrderLedger } from "@/features/trading/order-ledger";
import { persistPositionGapTargetSnapshot } from "@/features/wallet-analysis/server/copy-target-position-hydration-service";
import { getRecentAttemptsForAccount } from "@/features/wallet-analysis/server/copy-trade-attempts-read";
import { listCopyTradeOrdersForAccount } from "@/features/wallet-analysis/server/copy-trade-orders-read";
import { readCurrentWalletPositionModel } from "@/features/wallet-analysis/server/current-position-read-model";
import { readEconomicPositionProjection } from "@/features/wallet-analysis/server/economic-position-read-model";
import {
	buildBoundedMarketExposureGroups,
	buildBoundedMarketExposureWithCoverage,
	buildMarketExposureGroups,
} from "@/features/wallet-analysis/server/market-exposure-service";
import { observePaperWallet } from "@/features/wallet-analysis/server/paper-fact-source";
import { refreshMarketMetadata } from "@/features/wallet-analysis/server/poly-market-metadata-service";
import {
	type OriginDescriptor,
	positionMetadataOriginSelect,
	positionMetadataRequestKey,
	positionMetadataSelect,
	readPositionMetadata,
} from "@/features/wallet-analysis/server/position-metadata-read";
import { getTargetPositionsForAccount } from "@/features/wallet-analysis/server/target-positions-read";
import {
	billingAccounts,
	polyCopyTradeFills,
	polyCopyTradeTargets,
	polyWalletConnections,
	users,
} from "@/shared/db/schema";
import { targetIdFromWallet } from "@/shared/util/poly-target-id";

const unique = randomUUID().replaceAll("-", "");
const conditionId = `0x${unique}${unique}`;
const fieldCondition = `0x${unique}${"a".repeat(32)}`;
const planCondition = `0x${unique}${"b".repeat(32)}`;
const tiedCondition = `0x${unique}${"c".repeat(32)}`;
const proofConditions = Array.from({ length: 20 }, (_, index) => `0x${unique}${(index + 1).toString(16).padStart(32, "0")}`);
const integrationCondition = `0x${unique}${"e".repeat(32)}`;
const futureCondition = `0x${unique}${"f".repeat(32)}`;
const attemptCondition = `0x${unique}${"d".repeat(32)}`;
const wallet = `0x${unique}aabbccdd`;
const ownWallet = `0x${unique}eeff0011`;
const unknownWallet = `0x${unique}11223344`;
const tokenId = "6789012345678901234567890";
const oppositeTokenId = "6789012345678901234567891";
const thirdTokenId = "6789012345678901234567892";
const userId = randomUUID();
const accountId = randomUUID();
const db = getSeedDb();
const rows = <T>(result: unknown): T[] =>
  (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const start = Date.now() - 60_000;
const at = (offset: number) => new Date(start + offset * 1_000).toISOString();
const lookup = (
  address: string | null,
  condition = conditionId,
  token = tokenId,
) => {
  const key = positionMetadataRequestKey({
    conditionId: condition,
    tokenId: token,
    walletAddress: address,
  });
  if (key === null) throw new Error("Invalid test metadata identity");
  return key;
};

function snapshot(offset: number, rich: boolean): TargetBookSnapshotV1 {
  const time = start + offset * 1_000;
  return {
    version: 1,
    snapshotId: `metadata-${unique}-${offset}`,
    targetWallet: wallet,
    fullRefreshAtMs: time,
    updatedAtMs: time,
    expiresAtMs: time + 60_000,
    complete: true,
    refreshStats: {
      kind: "full",
      discoveryRows: 1,
      conditionCount: 1,
      dataApiCalls: 1,
      sourceComputedAt: at(offset),
      sourceMaxSyncedBlock: 90_000_000 + offset,
    },
    conditions: [
      {
        conditionId,
        status: "OPEN",
        redeemable: false,
        endDate: null,
        negativeRisk: false,
        marketTitle: rich ? "Known market" : null,
        marketSlug: rich ? "known-market" : null,
        tokens: [
          {
            tokenId,
            oppositeTokenId,
            outcomeIndex: 0,
            shares: 10,
            markPrice: 0.6,
            averagePrice: 0.4,
            outcome: rich ? "Our outcome" : null,
          },
          {
            tokenId: oppositeTokenId,
            oppositeTokenId: tokenId,
            outcomeIndex: 1,
            shares: 0,
            markPrice: 0.4,
            averagePrice: 0,
            outcome: rich ? "Other outcome" : null,
          },
        ],
      },
    ],
  };
}

async function addCurrent(
  address: string,
  condition: string,
  token: string,
  raw: Record<string, unknown>,
  offset = 5,
) {
  await db.execute(sql`INSERT INTO poly_trader_current_positions
    (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,last_observed_at,raw)
    SELECT id,${condition},${token},10,4,6,.4,${randomUUID()},${at(offset)}::timestamptz,${JSON.stringify(raw)}::jsonb
    FROM poly_trader_wallets WHERE wallet_address=${address} AND kind <> 'paper_wallet'
    ON CONFLICT (trader_wallet_id,condition_id,token_id) DO UPDATE SET
      active=true,shares=10,cost_basis_usdc=4,current_value_usdc=6,avg_price=.4,
      last_observed_at=EXCLUDED.last_observed_at,raw=EXCLUDED.raw`);
}
async function addFill(
  condition: string,
  raw: Record<string, unknown>,
  offset: number,
) {
  await db.execute(sql`INSERT INTO poly_trader_fills
    (trader_wallet_id,source,native_id,condition_id,token_id,side,price,shares,size_usdc,observed_at,raw)
    SELECT id,'data-api',${randomUUID()},${condition},${tokenId},'BUY',.4,1,.4,${at(offset)}::timestamptz,${JSON.stringify(raw)}::jsonb
    FROM poly_trader_wallets WHERE wallet_address=${wallet}`);
}

type Plan = Record<string, unknown> & { Plans?: Plan[] };
function planNodes(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)];
}

describe("saved metadata publication and indexed exact identity reads", () => {
  beforeAll(async () => {
    await db
      .insert(users)
      .values({ id: userId, name: userId, walletAddress: ownWallet });
    await db
      .insert(billingAccounts)
      .values({ id: accountId, ownerUserId: userId, balanceCredits: 0n });
    await db.insert(polyCopyTradeTargets).values({
      billingAccountId: accountId,
      createdByUserId: userId,
      targetWallet: wallet,
    });
    await db.execute(
      sql`INSERT INTO poly_trader_wallets (wallet_address,kind,label) VALUES (${ownWallet},'cogni_wallet','Our wallet')`,
    );
  });
  afterAll(async () => {
    await db.execute(
      sql`DELETE FROM poly_market_metadata WHERE lower(condition_id) IN (${conditionId},${fieldCondition},${planCondition},${tiedCondition},${attemptCondition},${integrationCondition},${futureCondition},${sql.join(proofConditions.map(condition => sql`${condition}`), sql`,`)})`,
    );
    await db.execute(
      sql`DELETE FROM poly_market_outcomes WHERE lower(condition_id) IN (${conditionId},${fieldCondition},${planCondition},${tiedCondition},${attemptCondition},${integrationCondition},${futureCondition},${sql.join(proofConditions.map(condition => sql`${condition}`), sql`,`)})`,
    );
    await db.execute(sql`DELETE FROM billing_accounts WHERE id=${accountId}`);
    await db.execute(sql`DELETE FROM users WHERE id=${userId}`);
    await db.execute(
      sql`DELETE FROM poly_trader_wallets WHERE wallet_address IN (${wallet},${ownWallet})`,
    );
  });

  it("retains exact labels through rich->sparse->rich at identical economic content hash", async () => {
    await persistPositionGapTargetSnapshot({ db, snapshot: snapshot(1, true) });
    await refreshMarketMetadata({ db, logger });
    await persistPositionGapTargetSnapshot({
      db,
      snapshot: snapshot(2, false),
    });
    await refreshMarketMetadata({ db, logger });
    const metadata = await readPositionMetadata({
      db,
      keys: [{ conditionId, tokenId, walletAddress: wallet }],
    });
    expect(metadata.get(lookup(wallet))).toMatchObject({
      marketTitle: "Known market",
      outcome: "Our outcome",
      oppositeTokenId,
    });
    await persistPositionGapTargetSnapshot({ db, snapshot: snapshot(3, true) });
    const current = rows<{ raw: Record<string, unknown> }>(
      await db.execute(
        sql`SELECT raw FROM poly_trader_current_positions WHERE condition_id=${conditionId} AND token_id=${tokenId}`,
      ),
    );
    expect(current[0]?.raw.outcome).toBe("Our outcome");
    const wrong = await readPositionMetadata({
      db,
      keys: [{ conditionId, tokenId: oppositeTokenId, walletAddress: wallet }],
    });
    expect(
      wrong.get(lookup(wallet, conditionId, oppositeTokenId))?.outcome,
    ).toBeNull();
  });

  it("selects newest meaningful fields separately across sparse rows, case siblings and sources", async () => {
    const mixed = `0x${fieldCondition.slice(2).toUpperCase()}`;
    await addCurrent(
      wallet,
      fieldCondition,
      tokenId,
      { title: "Current title only" },
      5,
    );
    await db.execute(sql`INSERT INTO poly_trader_position_snapshots
      (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,captured_at,raw)
      SELECT id,${fieldCondition},${tokenId},10,4,6,.4,${randomUUID()},${at(4)}::timestamptz,'{"slug":"snapshot-title-only"}'::jsonb
      FROM poly_trader_wallets WHERE wallet_address=${wallet}`);
    await addFill(
      fieldCondition,
      { outcome: "Older exact outcome", eventTitle: "Older event" },
      1,
    );
    await addFill(fieldCondition, { title: "Newer title only" }, 6);
    await addFill(
      fieldCondition,
      { title: "Polymarket", outcome: "UNKNOWN", eventTitle: " " },
      8,
    );
    await db.execute(sql`INSERT INTO poly_market_metadata (condition_id,market_title,event_slug,fetched_at)
      VALUES (${fieldCondition},'Older canonical title','older-event',${at(2)}::timestamptz),
             (${mixed},'UNKNOWN','newer-event',${at(7)}::timestamptz)`);
    const metadata = await readPositionMetadata({
      db,
      keys: [{ conditionId: fieldCondition, tokenId, walletAddress: wallet }],
    });
    expect(metadata.get(lookup(wallet, fieldCondition))).toMatchObject({
      marketTitle: "Newer title only",
      marketSlug: "snapshot-title-only",
      eventTitle: "Older event",
      eventSlug: "newer-event",
      outcome: "Older exact outcome",
    });
    // No requested wallet: explicit global canonical sources, never another wallet's raw row.
    const global = await readPositionMetadata({
      db,
      keys: [{ conditionId: fieldCondition, tokenId }],
    });
    expect(global.get(lookup(null, fieldCondition))).toMatchObject({
      marketTitle: "Older canonical title",
      eventSlug: "newer-event",
      outcome: null,
    });
  });

  it("keeps wallet provenance across one batch and unknown requested wallets never widen", async () => {
    await addCurrent(
      ownWallet,
      fieldCondition,
      tokenId,
      { title: "Own saved title", outcome: "Own saved label" },
      9,
    );
    const keys = [wallet, ownWallet, unknownWallet].map((walletAddress) => ({
      conditionId: fieldCondition,
      tokenId,
      walletAddress,
    }));
    const metadata = await readPositionMetadata({ db, keys });
    expect(metadata.size).toBe(3);
    expect(metadata.get(lookup(wallet, fieldCondition))?.outcome).toBe(
      "Older exact outcome",
    );
    expect(metadata.get(lookup(ownWallet, fieldCondition))?.outcome).toBe(
      "Own saved label",
    );
    expect(metadata.get(lookup(unknownWallet, fieldCondition))).toMatchObject({
      marketTitle: "Older canonical title",
      outcome: null,
    });
    expect(
      metadata.get(lookup(ownWallet, fieldCondition))?.provenance.outcome
        ?.source,
    ).toBe("current");
    expect(
      metadata.get(lookup(wallet, fieldCondition))?.provenance.outcome?.source,
    ).toBe("fill");
  });

  it("honors capturedAt for canonical and exact outcome sources as well as wallet history", async () => {
    await db.execute(sql`INSERT INTO poly_market_outcomes (condition_id,token_id,outcome,updated_at,raw)
      VALUES (${fieldCondition},${tokenId},'unknown',${at(10)}::timestamptz,'{"label":"Future label"}'::jsonb)`);
    const metadata = await readPositionMetadata({
      db,
      keys: [
        { conditionId: fieldCondition, tokenId, walletAddress: unknownWallet },
      ],
      capturedAt: at(3),
    });
    expect(metadata.get(lookup(unknownWallet, fieldCondition))).toMatchObject({
      marketTitle: "Older canonical title",
      eventSlug: "older-event",
      outcome: null,
    });
  });

  it("retains tied source outcome conflicts and accepts equal duplicate labels", async () => {
    const mixed = `0x${tiedCondition.slice(2).toUpperCase()}`;
    await db.execute(sql`INSERT INTO poly_market_metadata (condition_id,market_title,fetched_at)
      VALUES (${tiedCondition},'Tied observations',${at(1)}::timestamptz)`);
    for (const [sourceIndex, source] of [
      "current",
      "snapshot",
      "fill",
      "outcome",
    ].entries()) {
      for (const conflicting of [false, true]) {
        const token = String(700 + sourceIndex * 2 + Number(conflicting));
        for (const [index, label] of [
          "Same label",
          conflicting ? "Different label" : "Same label",
        ].entries()) {
          const condition = index === 0 ? tiedCondition : mixed;
          const raw = JSON.stringify({ outcome: label });
          if (source === "current") {
            await addCurrent(wallet, condition, token, { outcome: label }, 30);
          } else if (source === "snapshot") {
            await db.execute(sql`INSERT INTO poly_trader_position_snapshots
              (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,captured_at,raw)
              SELECT id,${condition},${token},10,4,6,.4,${randomUUID()},${at(30)}::timestamptz,${raw}::jsonb
              FROM poly_trader_wallets WHERE wallet_address=${wallet}`);
          } else if (source === "fill") {
            await db.execute(sql`INSERT INTO poly_trader_fills
              (trader_wallet_id,source,native_id,condition_id,token_id,side,price,shares,size_usdc,observed_at,raw)
              SELECT id,'data-api',${randomUUID()},${condition},${token},'BUY',.4,1,.4,${at(30)}::timestamptz,${raw}::jsonb
              FROM poly_trader_wallets WHERE wallet_address=${wallet}`);
          } else {
            await db.execute(sql`INSERT INTO poly_market_outcomes (condition_id,token_id,outcome,updated_at,raw)
              VALUES (${condition},${token},'unknown',${at(30)}::timestamptz,${raw}::jsonb)`);
          }
        }
        const key = {
          conditionId: tiedCondition,
          tokenId: token,
          walletAddress: wallet,
        };
        const metadata = (await readPositionMetadata({ db, keys: [key] })).get(
          lookup(wallet, tiedCondition, token),
        );
        expect(metadata, source).toMatchObject({
          marketTitle: "Tied observations",
          outcome: conflicting ? null : "Same label",
          availability: conflicting ? "conflict" : "complete",
        });
      }
    }
  });

  it.each(["current", "snapshot", "fill", "outcome"] as const)(
    "preserves %s mapping conflicts through actual saved reader and assembly",
    async (source) => {
      const sourceIndex = ["current", "snapshot", "fill", "outcome"].indexOf(source);
      for (const [scenarioIndex, scenario] of ["tied-conflict", "equal-duplicate", "dual-alias", "equal-alias", "newer-unique"].entries()) {
        const condition = proofConditions[sourceIndex * 5 + scenarioIndex];
        if (!condition) throw new Error("Missing proof condition");
        const mixed = `0x${condition.slice(2).toUpperCase()}`;
        const exact = "901", opposite = "902", other = "903";
        const label = "Valid opposite label";
        await addCurrent(ownWallet, condition, exact, { title: "Proof market", outcome: "Our valid label", oppositeAsset: opposite }, 20);
        await addCurrent(wallet, condition, exact, { title: "Proof market", outcome: "Our valid label", oppositeAsset: opposite }, 20);
        await addCurrent(wallet, condition, opposite, { title: "Proof market", outcome: label, oppositeAsset: exact }, 20);
        const insert = async (physicalCondition: string, raw: Record<string, unknown>, offset: number) => {
          if (source === "current") {
            await addCurrent(wallet, physicalCondition, opposite, raw, offset);
          } else if (source === "snapshot") {
            await db.execute(sql`INSERT INTO poly_trader_position_snapshots
              (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,captured_at,raw)
              SELECT id,${physicalCondition},${opposite},10,4,6,.4,${randomUUID()},${at(offset)}::timestamptz,${JSON.stringify(raw)}::jsonb
              FROM poly_trader_wallets WHERE wallet_address=${wallet}`);
          } else if (source === "fill") {
            await db.execute(sql`INSERT INTO poly_trader_fills
              (trader_wallet_id,source,native_id,condition_id,token_id,side,price,shares,size_usdc,observed_at,raw)
              SELECT id,'data-api',${randomUUID()},${physicalCondition},${opposite},'BUY',.4,1,.4,${at(offset)}::timestamptz,${JSON.stringify(raw)}::jsonb
              FROM poly_trader_wallets WHERE wallet_address=${wallet}`);
          } else {
            await db.execute(sql`INSERT INTO poly_market_outcomes (condition_id,token_id,outcome,updated_at,raw)
              VALUES (${physicalCondition},${opposite},'unknown',${at(offset)}::timestamptz,${JSON.stringify(raw)}::jsonb)
              ON CONFLICT (condition_id,token_id) DO UPDATE SET updated_at=EXCLUDED.updated_at,raw=EXCLUDED.raw`);
          }
        };
        if (scenario === "dual-alias" || scenario === "equal-alias") {
          await insert(condition, { outcome: label, oppositeAsset: exact, opposite_token_id: scenario === "equal-alias" ? exact : other }, 30);
        } else {
          await insert(mixed, { outcome: label, oppositeAsset: scenario === "equal-duplicate" ? exact : other }, scenario === "newer-unique" ? 29 : 30);
          await insert(condition, { outcome: label, oppositeAsset: exact }, 30);
        }
        const conflicted = scenario === "tied-conflict" || scenario === "dual-alias";
        const metadata = (await readPositionMetadata({ db, keys: [{ conditionId: condition, tokenId: opposite, walletAddress: wallet }], capturedAt: at(35) })).get(lookup(wallet, condition, opposite));
        expect(metadata, `${source}:${scenario}`).toMatchObject({
          outcome: label,
          oppositeTokenId: conflicted ? null : exact,
          oppositeProofAvailability: conflicted ? "conflict" : "available",
        });
        // Seed the exact publication seam consumed by both market builders.
        await db.execute(sql`INSERT INTO poly_trader_position_snapshots
          (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,captured_at,raw)
          SELECT trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,${randomUUID()},${at(20)}::timestamptz,raw
          FROM poly_trader_current_positions WHERE trader_wallet_id=(SELECT id FROM poly_trader_wallets WHERE wallet_address=${wallet})
            AND condition_id=${condition} AND token_id IN (${exact},${opposite})`);
        const own: WalletExecutionPosition = {
          positionId: `${condition}:${exact}`, conditionId: condition, asset: exact,
          marketTitle: "Proof market", marketSlug: null, eventSlug: null, marketUrl: null,
          outcome: "Our valid label", status: "open", lifecycleState: "open", openedAt: at(20), closedAt: null,
          resolvesAt: null, size: 10, entryPrice: .4, currentPrice: .6, currentValue: 6,
          pnlUsd: null, pnlPct: null, heldMinutes: 1, timeline: [], events: [],
        };
        const groups = await buildBoundedMarketExposureGroups({ db, billingAccountId: accountId, walletAddress: ownWallet, livePositions: [own] });
        const line = groups.groups.flatMap(group => group.lines).find(candidate => candidate.conditionId === condition);
        expect(line?.participants.find(participant => participant.side === "copy_target")?.legs?.find(leg => leg.tokenId === opposite)?.outcome, `${source}:${scenario}`).toBe(label);
        expect(line?.tokenComparisons, `${source}:${scenario}`).toEqual([expect.objectContaining({
          ourTokenId: exact, targetTokenId: exact, relation: "same", metadataAvailability: "available",
          oppositeTargetTokenIds: conflicted ? [] : [opposite],
        })]);
        const bundle = await buildBoundedMarketExposureWithCoverage({ db, billingAccountId: accountId, walletAddress: ownWallet, connectionKind: "privy_live", livePositions: [own] });
        const bundledLine = bundle.market.groups.flatMap(group => group.lines).find(candidate => candidate.conditionId === condition);
        expect(bundledLine?.tokenComparisons, `${source}:${scenario}:bundle`).toEqual([expect.objectContaining({
          ourTokenId: exact, targetTokenId: exact, relation: "same", metadataAvailability: "available",
          oppositeTargetTokenIds: conflicted ? [] : [opposite],
        })]);
      }
    },
  );

  it("does not leak a future-only canonical title through the actual attempts entrypoint", async () => {
    await db.execute(sql`INSERT INTO poly_market_metadata (condition_id,market_title,fetched_at)
      VALUES (${attemptCondition},'Future-only title',${at(40)}::timestamptz)`);
    await db.execute(sql`INSERT INTO poly_copy_trade_decisions
      (billing_account_id,created_by_user_id,target_id,fill_id,outcome,reason,intent,decided_at,mode)
      VALUES (${accountId},${userId},${randomUUID()}::uuid,${randomUUID()},'skipped','cutoff-test',
        ${JSON.stringify({ market_id: `prediction-market:polymarket:${attemptCondition}`, token_id: tokenId, side: "BUY", target_wallet: wallet, outcome: "Unverified fallback label" })}::jsonb,
        ${at(10)}::timestamptz,'live')`);
    await db.execute(sql`INSERT INTO poly_market_outcomes (condition_id,token_id,outcome,updated_at,raw)
      VALUES (${attemptCondition},${tokenId},'unknown',${at(10)}::timestamptz,'{"label":"First tied label"}'::jsonb),
        (${`0x${attemptCondition.slice(2).toUpperCase()}`},${tokenId},'unknown',${at(10)}::timestamptz,'{"label":"Other tied label"}'::jsonb)`);
    const result = await withTenantScope(
      getAppDb(),
      userActor(toUserId(userId)),
      (tx) =>
        getRecentAttemptsForAccount(
          tx,
          {
            billing_account_id: accountId,
            mode: "live",
            outcome: "all",
            limit: 20,
            captured_at: at(20),
          },
          accountId,
        ),
    );
    expect(result?.attempts).toHaveLength(1);
    expect(result?.attempts[0]).toMatchObject({
      market_title: null,
      outcome_label: null,
    });
  });

  it("assembles all three saved DB legs with exact token only third and rich mutual opposite proof", async () => {
    const book = snapshot(20, true);
    const condition = book.conditions[0];
    if (!condition) throw new Error("Missing test condition");
    await persistPositionGapTargetSnapshot({ db, snapshot: book });
    // The binary publisher remains binary. Three saved legs are possible in the
    // reporting DB, so seed the extra persisted leg without widening that port.
    await persistPositionGapTargetSnapshot({
      db,
      snapshot: {
        ...book,
        snapshotId: `${book.snapshotId}-two-larger`,
        updatedAtMs: start + 21_000,
        conditions: [
          {
            ...condition,
            tokens: [
              {
                tokenId: oppositeTokenId,
                oppositeTokenId: tokenId,
                outcomeIndex: 1,
                shares: 30,
                markPrice: 0.4,
                averagePrice: 0.4,
                outcome: "Other outcome",
              },
              {
                tokenId: thirdTokenId,
                oppositeTokenId,
                outcomeIndex: 0,
                shares: 20,
                markPrice: 0.5,
                averagePrice: 0.4,
                outcome: "Additional outcome",
              },
            ],
          },
        ],
      },
    });
    await addCurrent(
      wallet,
      conditionId,
      tokenId,
      {
        title: "Known market",
        outcome: "Our outcome",
        oppositeAsset: oppositeTokenId,
      },
      22,
    );
    await addCurrent(
      ownWallet,
      conditionId,
      tokenId,
      {
        title: "Known market",
        outcome: "Our outcome",
        oppositeAsset: oppositeTokenId,
      },
      20,
    );
    const own: WalletExecutionPosition = {
      positionId: `${conditionId}:${tokenId}`,
      conditionId,
      asset: tokenId,
      marketTitle: "Known market",
      marketSlug: null,
      eventSlug: null,
      marketUrl: null,
      outcome: "Our outcome",
      status: "open",
      lifecycleState: "open",
      openedAt: at(20),
      closedAt: null,
      resolvesAt: null,
      size: 10,
      entryPrice: 0.4,
      currentPrice: 0.6,
      currentValue: 6,
      pnlUsd: null,
      pnlPct: null,
      heldMinutes: 1,
      timeline: [],
      events: [],
    };
    const read = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: accountId,
      walletAddress: ownWallet,
      livePositions: [own],
    });
    const line = read.groups[0]?.lines[0];
    const target = line?.participants.find((p) => p.side === "copy_target");
    expect(target?.primary?.tokenId).toBe(oppositeTokenId);
    expect(target?.hedge?.tokenId).toBe(thirdTokenId);
    expect(target?.legs?.map((l) => l.tokenId)).toEqual([
      oppositeTokenId,
      thirdTokenId,
      tokenId,
    ]);
    expect(target?.net.currentValueUsdc).toBe(28);
    expect(target?.net.costBasisUsdc).toBe(24);
    expect(line?.tokenComparisons).toEqual([
      expect.objectContaining({
        ourTokenId: tokenId,
        targetTokenId: tokenId,
        relation: "same",
        oppositeTargetTokenIds: [oppositeTokenId],
        metadataAvailability: "available",
      }),
    ]);
    const bundle = await buildBoundedMarketExposureWithCoverage({
      db,
      billingAccountId: accountId,
      walletAddress: ownWallet,
      connectionKind: "privy_live",
      livePositions: [own],
    });
    const bundledLine = bundle.market.groups[0]?.lines[0];
    expect(
      bundledLine?.participants
        .find((p) => p.side === "copy_target")
        ?.legs?.map((l) => l.tokenId),
    ).toEqual([oppositeTokenId, thirdTokenId, tokenId]);
    expect(bundledLine?.tokenComparisons).toEqual([
      expect.objectContaining({
        ourTokenId: tokenId,
        targetTokenId: tokenId,
        relation: "same",
        oppositeTargetTokenIds: [oppositeTokenId],
      }),
    ]);
    // A conflict must survive the consumer: do not coalesce the resolver's
    // null outcome back to the rich, but now ambiguous, leg label.
    for (const label of ["First tied label", "Other tied label"]) {
      await db.execute(sql`INSERT INTO poly_trader_position_snapshots
        (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,captured_at,raw)
        SELECT id,${conditionId},${tokenId},10,4,6,.4,${randomUUID()},${at(25)}::timestamptz,${JSON.stringify({ outcome: label })}::jsonb
        FROM poly_trader_wallets WHERE wallet_address=${wallet}`);
    }
    const conflicted = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: accountId,
      walletAddress: ownWallet,
      livePositions: [own],
    });
    const conflictedLine = conflicted.groups[0]?.lines[0];
    expect(
      conflictedLine?.participants
        .find((p) => p.side === "copy_target")
        ?.legs?.find((leg) => leg.tokenId === tokenId)?.outcome,
    ).toBe("UNKNOWN");
    expect(conflictedLine?.tokenComparisons).toEqual([
      expect.objectContaining({
        ourTokenId: tokenId,
        targetTokenId: tokenId,
        relation: "same",
        metadataAvailability: "unavailable",
      }),
    ]);
    const targetPositions = await withTenantScope(
      getAppDb(),
      userActor(toUserId(userId)),
      (tx) =>
        getTargetPositionsForAccount(
          tx,
          accountId,
          { sort: "portfolio_weight", limit: 200 },
          { resolveEffectiveKind: () => "mirror_fill_exact" },
        ),
    );
    expect(
      targetPositions.positions.find(
        (position) =>
          position.condition_id === conditionId &&
          position.token_id === tokenId,
      )?.outcome,
    ).toBeNull();
    await db.execute(sql`UPDATE poly_trader_current_positions SET active=false
      WHERE trader_wallet_id=(SELECT id FROM poly_trader_wallets WHERE wallet_address=${wallet})
        AND condition_id=${conditionId} AND token_id=${tokenId}`);
    const oppositeOnly = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: accountId,
      walletAddress: ownWallet,
      livePositions: [own],
    });
    expect(oppositeOnly.groups[0]?.lines[0]?.tokenComparisons).toEqual([
      expect.objectContaining({
        ourTokenId: tokenId,
        targetTokenId: oppositeTokenId,
        relation: "opposite",
        oppositeTargetTokenIds: [oppositeTokenId],
        metadataAvailability: "available",
      }),
    ]);
  });


  it("shares as-of metadata across current/history/markets without future, wallet or mode revival", async () => {
    const condition = integrationCondition, exact = "801", closed = "802";
    const [paper] = rows<{ id: string }>(await db.execute(sql`INSERT INTO poly_trader_wallets (wallet_address,kind,label)
      VALUES (${`0x${ownWallet.slice(2).toUpperCase()}`},'paper_wallet','Mode trap') RETURNING id`));
    if (!paper) throw new Error("Missing mode trap");
    const siblingAddress = `${ownWallet.slice(0, -8)}Eeff0011`;
    const [sibling] = rows<{ id: string }>(await db.execute(sql`INSERT INTO poly_trader_wallets (wallet_address,kind,label)
      VALUES (${siblingAddress},'cogni_wallet','Physical sibling') RETURNING id`));
    if (!sibling) throw new Error("Missing physical sibling");
    try {
      await addCurrent(ownWallet, condition, exact, { title: "Polymarket", outcome: "UNKNOWN", slug: "" }, 10);
      await addCurrent(wallet, condition, exact, { title: "Other wallet trap", outcome: "Wrong wallet" }, 11);
      await db.execute(sql`INSERT INTO poly_trader_current_positions
        (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,last_observed_at,raw)
        VALUES (${paper.id},${condition},${exact},10,40,60,4,'mode-trap',${at(11)}::timestamptz,'{"title":"Paper trap","outcome":"Wrong mode"}'::jsonb)`);
      for (const token of [exact, closed]) {
        await db.execute(sql`INSERT INTO poly_trader_fills
          (trader_wallet_id,source,native_id,condition_id,token_id,side,price,shares,size_usdc,observed_at,raw)
          SELECT id,'data-api',${randomUUID()},${condition},${token},'BUY',.4,10,4,${at(1)}::timestamptz,
            '{"title":"Older exact title","eventTitle":"Older event","eventSlug":"older-event","slug":"older-market","outcome":"Older exact outcome"}'::jsonb
          FROM poly_trader_wallets WHERE wallet_address=${ownWallet} AND kind='cogni_wallet'`);
      }
      await db.execute(sql`INSERT INTO poly_trader_fills
        (trader_wallet_id,source,native_id,condition_id,token_id,side,price,shares,size_usdc,observed_at,raw)
        SELECT id,'data-api',${randomUUID()},${condition},${closed},'SELL',.6,10,6,${at(2)}::timestamptz,'{}'::jsonb
        FROM poly_trader_wallets WHERE wallet_address=${ownWallet} AND kind='cogni_wallet'`);
      await db.execute(sql`INSERT INTO poly_market_metadata (condition_id,market_title,event_slug,fetched_at)
        VALUES (${condition},'Future title','future-event',${at(30)}::timestamptz)`);
      await db.execute(sql`INSERT INTO poly_trader_ingestion_cursors (trader_wallet_id,source,status,last_success_at)
        SELECT id,'data-api-positions','ok',${at(15)}::timestamptz FROM poly_trader_wallets WHERE wallet_address=${ownWallet} AND kind='cogni_wallet'
        ON CONFLICT (trader_wallet_id,source) DO UPDATE SET status='ok',last_success_at=EXCLUDED.last_success_at`);
      const cutoff = at(20);
      const projection = await readEconomicPositionProjection({ db, billingAccountId: accountId, walletAddress: ownWallet, connectionKind: "privy_live", capturedAt: new Date(cutoff), interval: "1W" });
      const current = await readCurrentWalletPositionModel({ db, billingAccountId: accountId, walletAddress: ownWallet, mode: "live", capturedAt: new Date(cutoff) });
      const expected = { marketTitle: "Older exact title", outcome: "Older exact outcome", eventTitle: "Older event", eventSlug: "older-event", marketSlug: "older-market", marketUrl: "https://polymarket.com/event/older-event" };
      const own = projection.livePositions.find(p => p.conditionId === condition && p.asset === exact);
      if (!own) throw new Error("Missing real economic position");
      expect(own).toMatchObject(expected);
      expect(projection.closedPositions.find(p => p.conditionId === condition && p.asset === closed)).toMatchObject(expected);
      expect(current.positions.find(p => p.conditionId === condition && p.asset === exact)).toMatchObject(expected);
      const builders = async (position: WalletExecutionPosition, capturedAt: string) => [
        await buildMarketExposureGroups({ db, billingAccountId: accountId, walletAddress: ownWallet, livePositions: [position], capturedAt }),
        (await buildBoundedMarketExposureGroups({ db, billingAccountId: accountId, walletAddress: ownWallet, livePositions: [position], capturedAt })).groups,
        (await buildBoundedMarketExposureWithCoverage({ db, billingAccountId: accountId, walletAddress: ownWallet, connectionKind: "privy_live", livePositions: [position], capturedAt })).market.groups,
      ];
      for (const groups of await builders(own, cutoff)) {
        const line = groups.flatMap(g => g.lines).find(l => l.conditionId === condition);
        expect(line?.marketTitle).toBe(expected.marketTitle);
        expect(line?.marketSlug).toBe("older-market");
        expect(line?.participants.find(p => p.side === "our_wallet")?.primary?.outcome).toBe(expected.outcome);
      }
      const fact = projection.positionFacts.find(f => f.conditionId === condition && f.tokenId === exact);
      if (!fact) throw new Error("Missing canonical fact");
      for (const positionFacts of [[], [fact, fact], [{ ...fact, mode: "paper" as const }], [{ ...fact, currentValueUsdc: null, remainingBasisUsdc: null, unrealizedPnlUsdc: null }]]) {
        const params = { db, billingAccountId: accountId, walletAddress: ownWallet, livePositions: [own], capturedAt: cutoff, mode: "live" as const, positionFacts };
        const outputs = [await buildMarketExposureGroups(params), (await buildBoundedMarketExposureGroups(params)).groups, (await buildBoundedMarketExposureWithCoverage({ ...params, connectionKind: "privy_live" })).market.groups];
        for (const groups of outputs) {
          const line = groups.flatMap(g => g.lines).find(l => l.conditionId === condition);
          expect(line?.ourEntryValueUsdc).toBeNull();
          expect(line?.ourValueUsdc).toBeNull();
          expect(line?.participants.find(p => p.side === "our_wallet")?.primary).toMatchObject({ tokenId: exact, costBasisUsdc: null, currentValueUsdc: null, vwap: null, pnlUsdc: null });
        }
      }
      // Later-only saved target observation cannot certify an earlier comparison.
      await addCurrent(wallet, futureCondition, exact, { title: "Future target", outcome: "Future outcome" }, 30);
      await db.execute(sql`INSERT INTO poly_trader_position_snapshots
        (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,captured_at,raw)
        SELECT id,${futureCondition},${exact},10,4,6,.4,'future-only',${at(30)}::timestamptz,'{"title":"Future target","outcome":"Future outcome"}'::jsonb
        FROM poly_trader_wallets WHERE wallet_address=${wallet}`);
      const futureOwn = { ...own, conditionId: futureCondition, positionId: `${futureCondition}:${exact}`, marketTitle: "Unverified legacy fallback", outcome: "Unverified legacy outcome" };
      for (const groups of await builders(futureOwn, cutoff)) {
        const line = groups.flatMap(g => g.lines).find(l => l.conditionId === futureCondition);
        expect(line?.participants.filter(p => p.side === "copy_target")).toEqual([]);
        expect(line?.marketTitle).toBe("Polymarket");
        expect(line?.participants.find(p => p.side === "our_wallet")?.primary?.outcome).toBe("UNKNOWN");
      }
      // Same-time physical condition siblings conflict; identity stays visible.
      const mixed = `0x${condition.slice(2).toUpperCase()}`;
      await addCurrent(ownWallet, condition, exact, { outcome: "First label" }, 15);
      await addCurrent(ownWallet, mixed, exact, { outcome: "Second label" }, 15);
      const conflicted = await readCurrentWalletPositionModel({ db, billingAccountId: accountId, walletAddress: ownWallet, mode: "live", capturedAt: new Date(cutoff) });
      expect(conflicted.positions.find(p => p.conditionId === condition && p.asset === exact)).toMatchObject({ outcome: "UNKNOWN", marketTitle: "Older exact title" });
      await db.execute(sql`INSERT INTO poly_trader_current_positions
        (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,last_observed_at,raw)
        VALUES (${sibling.id},${condition},${exact},10,4,6,.4,'physical-sibling',${at(15)}::timestamptz,'{"outcome":"First label"}'::jsonb)`);
      const evidence = rows(await db.execute(positionMetadataSelect([{ conditionId: condition, tokenId: exact, wallet: ownWallet, mode: "live" }], cutoff)));
      expect(evidence.length).toBeLessThanOrEqual(24);
    } finally {
      await db.execute(sql`DELETE FROM poly_trader_wallets WHERE id IN (${paper.id},${sibling.id})`);
    }
  });

  it("proves indexed rows visited and scalar bounds against unrelated and sparse token history", async () => {
    await db.execute(sql`INSERT INTO poly_trader_position_snapshots
      (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,captured_at,raw)
      SELECT w.id,${planCondition},CASE WHEN n<=80 THEN ${tokenId} ELSE 'unrelated-'||n END,
        1,.4,.5,.4,'plan-'||n,${at(15)}::timestamptz-(n||' seconds')::interval,
        CASE WHEN n=80 THEN '{"outcome":"Deep saved label"}'::jsonb ELSE '{}'::jsonb END
      FROM poly_trader_wallets w CROSS JOIN generate_series(1,5080) n WHERE w.wallet_address=${wallet}`);
    await db.execute(sql`INSERT INTO poly_trader_fills
      (trader_wallet_id,source,native_id,condition_id,token_id,side,price,shares,size_usdc,observed_at,raw)
      SELECT w.id,'data-api','plan-'||n,${planCondition},CASE WHEN n<=80 THEN ${tokenId} ELSE 'unrelated-'||n END,
        'BUY',.4,1,.4,${at(15)}::timestamptz-(n||' seconds')::interval,
        CASE WHEN n=80 THEN '{"title":"Deep saved title"}'::jsonb ELSE '{}'::jsonb END
      FROM poly_trader_wallets w CROSS JOIN generate_series(1,5080) n WHERE w.wallet_address=${wallet}`);
    await db.execute(sql`ANALYZE poly_trader_position_snapshots`);
    await db.execute(sql`ANALYZE poly_trader_fills`);
    const query = positionMetadataSelect([
      { conditionId: planCondition, tokenId, wallet },
    ]);
    const evidence = rows<unknown>(await db.execute(query));
    expect(evidence.length).toBeLessThanOrEqual(24);
    const result = rows<{ "QUERY PLAN": Array<{ Plan: Plan }> }>(
      await db.execute(sql`EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) ${query}`),
    );
    const plan = result[0]?.["QUERY PLAN"][0]?.Plan;
    if (!plan) throw new Error("Missing Postgres EXPLAIN plan");
    const nodes = planNodes(plan);
    for (const relation of [
      "poly_trader_position_snapshots",
      "poly_trader_fills",
    ]) {
      const scans = nodes.filter((n) => n["Relation Name"] === relation);
      expect(scans.length).toBeGreaterThan(0);
      for (const scan of scans) {
        expect(scan["Node Type"]).not.toBe("Seq Scan");
        // Any planner-selected index must visit only this token's <=80 rows,
        // including filtered blank fields; a wallet-wide index is insufficient.
        expect(
          Number(scan["Actual Rows"]) +
            Number(scan["Rows Removed by Filter"] ?? 0),
        ).toBeLessThanOrEqual(80);
      }
    }
    const metadata = await readPositionMetadata({
      db,
      keys: [{ conditionId: planCondition, tokenId, walletAddress: wallet }],
    });
    expect(metadata.get(lookup(wallet, planCondition))).toMatchObject({
      marketTitle: "Deep saved title",
      outcome: "Deep saved label",
    });
  });
});

/** Independent fixtures for account-qualified origins; no shared target enablement or new-fill repair. */
async function originFixture(metadata?: {
	condition: string;
	tokens: readonly [string, string];
	title: string;
}) {
	const user = randomUUID(),
		account = randomUUID();
	const target =
		`0x${randomUUID().replaceAll("-", "")}11223344` as `0x${string}`;
	const condition =
		metadata?.condition ?? `0x${randomUUID().replaceAll("-", "").repeat(2)}`;
	const paper = derivePaperAccountAddress(account);
	const accountScope = { billingAccountId: account };
	const tokens =
		metadata?.tokens ??
		(["950100000000000000001", "950100000000000000002"] as const);
	await db.insert(users).values({ id: user, walletAddress: target });
	await db
		.insert(billingAccounts)
		.values({ id: account, ownerUserId: user, balanceCredits: 0n });
	await db.insert(polyWalletConnections).values({
		billingAccountId: account,
		createdByUserId: user,
		kind: "paper",
		address: paper,
		funderAddress: paper,
		paperSeedUsdc: "1000",
		createdAt: new Date(at(0)),
		custodialConsentAcceptedAt: new Date(at(0)),
		custodialConsentActorKind: "user",
		custodialConsentActorId: user,
	});
	await db.insert(polyCopyTradeTargets).values({
		billingAccountId: account,
		createdByUserId: user,
		targetWallet: target,
		createdAt: new Date(at(0)),
		disabledAt: new Date(at(20)),
	});
	const [paperRow] = rows<{ id: string }>(
		await db.execute(sql`INSERT INTO poly_trader_wallets (wallet_address,kind,label)
    VALUES (${paper},'paper_wallet','Metadata origin fixture') RETURNING id`),
	);
	if (!paperRow) throw new Error("Missing fixture paper wallet");
	const key = (token: string = tokens[0]) => ({
		conditionId: condition,
		tokenId: token,
		walletAddress: paper,
		mode: "paper" as const,
	});
	const batch = (token: string = tokens[0]) => [
		{
			conditionId: condition,
			tokenId: token,
			wallet: paper,
			mode: "paper" as const,
		},
	];
	const value = (
		result: Awaited<ReturnType<typeof readPositionMetadata>>,
		token: string = tokens[0],
	) => result.get(positionMetadataRequestKey(key(token), accountScope) ?? "");
	const read = (
		connection: { execute(query: SQL): Promise<unknown> } = db,
		token: string = tokens[0],
	) =>
		readPositionMetadata({
			db: connection,
			keys: [key(token)],
			accountScope,
			capturedAt: at(30),
		});
	async function seed(
		overrides: {
			token?: string;
			targetId?: string;
			targetWallet?: string;
			mode?: "paper" | "live";
			conditionId?: string;
			orderId?: string | null;
			observedAt?: string;
			attributes?: Record<string, unknown>;
		} = {},
	) {
		await db.insert(polyCopyTradeFills).values({
			billingAccountId: account,
			createdByUserId: user,
			targetId: overrides.targetId ?? targetIdFromWallet(target),
			fillId: randomUUID(),
			marketId: `prediction-market:polymarket:${condition}`,
			observedAt: new Date(overrides.observedAt ?? at(10)),
			clientOrderId: randomUUID(),
			orderId:
				overrides.orderId === undefined ? randomUUID() : overrides.orderId,
			status: "filled",
			mode: overrides.mode ?? "paper",
			shares: "10",
			price: ".4",
			feesUsdc: "0",
			attributes: {
				side: "BUY",
				token_id: overrides.token ?? tokens[0],
				condition_id: overrides.conditionId ?? condition,
				target_wallet: overrides.targetWallet ?? target,
				...overrides.attributes,
			},
		});
	}
	async function publish(
		labels: readonly [string, string] = ["Sangal", "Over"],
		offset = 5,
	) {
		const saved = snapshot(offset, true);
		const market = saved.conditions[0];
		if (!market) throw new Error("Missing fixture market");
		await persistPositionGapTargetSnapshot({
			db,
			snapshot: {
				...saved,
				snapshotId: `${condition}-${offset}`,
				targetWallet: target,
				conditions: [
					{
						...market,
						conditionId: condition,
						marketTitle: metadata?.title ?? "Retained filled market",
						tokens: [
							{
								...market.tokens[0],
								tokenId: tokens[0],
								oppositeTokenId: tokens[1],
								shares: 10,
								outcome: labels[0],
							},
							{
								...market.tokens[1],
								tokenId: tokens[1],
								oppositeTokenId: tokens[0],
								shares: 10,
								outcome: labels[1],
							},
						],
					},
				],
			},
		});
	}
	async function cleanup() {
		await db.execute(
			sql`DELETE FROM poly_copy_trade_fills WHERE billing_account_id=${account}`,
		);
		await db.execute(
			sql`DELETE FROM poly_copy_trade_targets WHERE billing_account_id=${account}`,
		);
		await db.execute(sql`DELETE FROM billing_accounts WHERE id=${account}`);
		await db.execute(sql`DELETE FROM users WHERE id=${user}`);
		await db.execute(
			sql`DELETE FROM poly_trader_wallets WHERE lower(wallet_address) IN (${paper},${target})`,
		);
		await db.execute(
			sql`DELETE FROM poly_market_metadata WHERE lower(condition_id)=${condition}`,
		);
		await db.execute(
			sql`DELETE FROM poly_market_outcomes WHERE lower(condition_id)=${condition}`,
		);
	}
	return {
		user,
		account,
		accountScope,
		paper,
		paperRow,
		target,
		condition,
		tokens,
		key,
		batch,
		value,
		read,
		seed,
		publish,
		cleanup,
	};
}

describe("bounded PAPER saved-origin metadata authorization", () => {
	it("preserves the frozen additive eight exact-token names and index traps without changing denominators", async () => {
		const bytes = readFileSync(
			new URL(
				"../../../../packages/poly-market-provider/tests/fixtures/position-paper-metadata-oracle.v1.json",
				import.meta.url,
			),
		);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(
			"25e615d861e190ab91c095d30193a7b5f6f41c8a5294fc5d845aa4fb82c92bac",
		);
		const oracle = JSON.parse(bytes.toString()) as {
			cases: Array<{
				caseId: string;
				conditionId: string;
				tokenId: string;
				expectedNamedOutcome?: string;
				expectedMarketTitle?: string;
				candidateLabel?: string;
				expectedLabelIsNamedOutcome?: boolean;
			}>;
		};
		expect(oracle.cases).toHaveLength(8);
		const named = oracle.cases.filter(
			(c) => c.expectedNamedOutcome !== undefined,
		);
		expect(named).toHaveLength(4);
		for (const condition of [...new Set(named.map((c) => c.conditionId))]) {
			const pair = named.filter((c) => c.conditionId === condition);
			const [left, right] = pair;
			if (
				!left?.expectedNamedOutcome ||
				!right?.expectedNamedOutcome ||
				!left.expectedMarketTitle
			)
				throw new Error("Malformed frozen named pair");
			const f = await originFixture({
				condition,
				tokens: [left.tokenId, right.tokenId],
				title: left.expectedMarketTitle,
			});
			try {
				for (const token of f.tokens) {
					const trap = oracle.cases.find(
						(c) =>
							c.conditionId === condition &&
							c.tokenId === token &&
							c.candidateLabel !== undefined,
					);
					expect(trap?.expectedLabelIsNamedOutcome).toBe(false);
					await f.seed({
						token,
						attributes: {
							outcome: trap?.candidateLabel,
							position_gap_version: "3",
						},
					});
					await db.execute(sql`INSERT INTO poly_trader_current_positions
            (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,last_observed_at,raw)
            VALUES (${f.paperRow.id},${condition},${token},10,4,6,.4,${randomUUID()},${at(25)}::timestamptz,
              ${JSON.stringify({ outcome: trap?.candidateLabel, position_gap_version: "3" })}::jsonb)`);
					expect(
						f.value(
							await db.transaction((tx) => f.read(tx, token), {
								isolationLevel: "repeatable read",
								accessMode: "read only",
							}),
							token,
						)?.outcome,
					).toBeNull();
				}
				await f.publish([
					left.expectedNamedOutcome,
					right.expectedNamedOutcome,
				]);
				for (const expected of pair) {
					const result = f.value(
						await db.transaction((tx) => f.read(tx, expected.tokenId), {
							isolationLevel: "repeatable read",
							accessMode: "read only",
						}),
						expected.tokenId,
					);
					expect(result, expected.caseId).toMatchObject({
						marketTitle: expected.expectedMarketTitle,
						outcome: expected.expectedNamedOutcome,
						oppositeTokenId: null,
					});
				}
			} finally {
				await f.cleanup();
			}
		}
	});

	it("recovers both disabled filled legs through real intent, ledger, paper publication, orders and canonical readers without changing finance", async () => {
		const f = await originFixture();
		try {
			const log = pino({ enabled: false });
			const ledger = createOrderLedger({
				db: db as unknown as PostgresJsDatabase<Record<string, unknown>>,
				appDb: getAppDb() as unknown as PostgresJsDatabase<
					Record<string, unknown>
				>,
				logger: log,
				resolveExecutionMode: async () => "paper",
			});
      const [connection] = rows<{ id: string }>(await db.execute(sql`SELECT id FROM poly_wallet_connections WHERE billing_account_id=${f.account} AND kind='paper'`));
      if (!connection) throw new Error("metadata paper connection absent");
      await db.execute(sql`INSERT INTO poly_wallet_grants (billing_account_id,wallet_connection_id,created_by_user_id,scopes,per_order_usdc_cap,daily_usdc_cap,hourly_fills_cap)
        VALUES (${f.account},${connection.id},${f.user},ARRAY['poly:trade:buy'],10,1000,1000)`);
      const factory = createPolyTradeExecutorFactory({ logger: log, metrics: noopMetrics,
        paperSidecarUrl: "http://paper.metadata.test", paperVenue: createPaperVenue({ db }),
        resolveExecutionVenue: createExecutionVenueResolver({ db }) });
      const executor = await factory.getPolyTradeExecutorFor(f.account);
			const lineage = {
				algorithm_id: "poly.copy-mirror.position-gap" as const,
				algorithm_version_id: `sha256:${"a".repeat(64)}`,
				config_hash: `sha256:${"b".repeat(64)}`,
				input_snapshot_id: `sha256:${"c".repeat(64)}`,
				assignment_id: randomUUID(),
				correlation_id: randomUUID(),
			};
			// Old index and future literal named '1' serialize identically: extra DTO hints are discarded by the real ledger.
			for (const [index, token] of f.tokens.entries()) {
				const intent = buildPositionGapBuyIntent({
					marketId: `prediction-market:polymarket:${f.condition}`,
					outcome: "1",
					notionalUsdc: 4,
					limitPrice: 0.4,
					clientOrderId: randomUUID(),
					tokenId: token,
					conditionId: f.condition,
					cohortKey: randomUUID(),
					targetWallet: f.target,
					lineage,
				});
				if (index === 1)
					intent.attributes = {
						...intent.attributes,
						labelKind: "named",
						outcomeIndex: 1,
					};
				await ledger.insertPending({
					billing_account_id: f.account,
					created_by_user_id: f.user,
					target_id: targetIdFromWallet(f.target),
					fill_id: randomUUID(),
					observed_at: new Date(at(10)),
					intent,
				});
        const native: OrderReceipt = {
						order_id: randomUUID(),
						client_order_id: intent.client_order_id,
						status: "filled",
						filled_size_usdc: 4,
						fill_price: 0.4,
						total_shares: 10,
						fees_usdc: 0,
            submitted_at: at(10),
            attributes: { market: f.condition, tokenId: token, side: "BUY", sizeMatched: 10 },
        };
        const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
          const url = new URL(String(input));
          expect(url.origin).toBe("http://paper.metadata.test");
          expect(url.searchParams.get("account_id")).toBe(connection.id);
          expect(url.pathname).toBe(`/orders/${native.order_id}`);
          return Response.json(native);
        });
        // The native observation belongs before the existing projection cutoff.
        // Only the test clock changes; the factory still creates trusted context.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(at(10)));
        try {
          const actual = await executor.getOrder(native.order_id);
          if (!("found" in actual)) throw new Error("metadata native receipt absent");
          const accepted = await ledger.markOrderId({ client_order_id: intent.client_order_id, receipt: actual.found });
          if (!accepted) throw new Error("metadata accepted paper observation absent");
          expect(accepted.accepted).toBe(true);
        } finally { transport.mockRestore(); vi.useRealTimers(); }
			}
			const serialized = rows<{ attributes: Record<string, unknown> }>(
				await db.execute(
					sql`SELECT attributes FROM poly_copy_trade_fills WHERE billing_account_id=${f.account}`,
				),
			);
			expect(serialized).toHaveLength(2);
			for (const row of serialized) {
				expect(row.attributes.outcome).toBe("1");
				expect(row.attributes.labelKind).toBeUndefined();
				expect(row.attributes.outcomeIndex).toBeUndefined();
			}
			await observePaperWallet({
				db: db as unknown as Parameters<typeof observePaperWallet>[0]["db"],
				wallet: {
					traderWalletId: f.paperRow.id,
					account: {
						billingAccountId: f.account,
						address: f.paper,
						seedUsdc: "1000",
					},
				},
				readMidPrice: async () => 0.6,
				logger: log,
				now: new Date(at(15)),
			});
			const projected = rows<{ raw: Record<string, unknown> }>(
				await db.execute(
					sql`SELECT raw FROM poly_trader_fills WHERE trader_wallet_id=${f.paperRow.id}`,
				),
			);
			expect(projected).toHaveLength(2);
			for (const row of projected) {
				expect(row.raw.attributes).toMatchObject({ outcome: "1" });
				expect(
					(row.raw.attributes as Record<string, unknown>).labelKind,
				).toBeUndefined();
			}
			const readModels = (
				tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
			) =>
				Promise.all([
					readCurrentWalletPositionModel({
						db: tx,
						billingAccountId: f.account,
						walletAddress: f.paper,
						mode: "paper",
						capturedAt: new Date(at(30)),
					}),
					readEconomicPositionProjection({
						db: tx,
						billingAccountId: f.account,
						walletAddress: f.paper,
						connectionKind: "paper",
						capturedAt: new Date(at(30)),
						interval: "1W",
					}),
				]);
			const before = await db.transaction(readModels, {
				isolationLevel: "repeatable read",
				accessMode: "read only",
			});
			const unknown = await db.transaction((tx) => f.read(tx), {
				isolationLevel: "repeatable read",
				accessMode: "read only",
			});
			expect(f.value(unknown)?.outcome).toBeNull();
			const financialBytes = JSON.stringify(
				rows(
					await db.execute(
						sql`SELECT shares,price,fees_usdc,attributes FROM poly_copy_trade_fills WHERE billing_account_id=${f.account} ORDER BY fill_id`,
					),
				),
			);
			// This is saved metadata publication only: original filled rows and disabled target are retained unchanged.
			await f.publish();
			const after = await db.transaction(readModels, {
				isolationLevel: "repeatable read",
				accessMode: "read only",
			});
			expect(after[1].positionFacts).toEqual(before[1].positionFacts);
			expect(JSON.stringify(after[1].positionFacts)).toBe(
				JSON.stringify(before[1].positionFacts),
			);
			expect(
				after[0].positions.map(
					({
						marketTitle: _title,
						outcome: _outcome,
						eventTitle: _eventTitle,
						eventSlug: _eventSlug,
						marketSlug: _marketSlug,
						marketUrl: _url,
						...financial
					}) => financial,
				),
			).toEqual(
				before[0].positions.map(
					({
						marketTitle: _title,
						outcome: _outcome,
						eventTitle: _eventTitle,
						eventSlug: _eventSlug,
						marketSlug: _marketSlug,
						marketUrl: _url,
						...financial
					}) => financial,
				),
			);
			expect(after[0].positions.map((p) => p.outcome).sort()).toEqual([
				"Over",
				"Sangal",
			]);
			expect(financialBytes).toBe(
				JSON.stringify(
					rows(
						await db.execute(
							sql`SELECT shares,price,fees_usdc,attributes FROM poly_copy_trade_fills WHERE billing_account_id=${f.account} ORDER BY fill_id`,
						),
					),
				),
			);
			const orders = await withTenantScope(
				getAppDb(),
				userActor(toUserId(f.user)),
				async (tx) => {
					await tx.execute(
						sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
					);
					return listCopyTradeOrdersForAccount(
						tx,
						{ status: "all", limit: 200 },
						f.account,
					);
				},
			);
			expect(orders?.orders.map((order) => order.outcome).sort()).toEqual([
				"Over",
				"Sangal",
			]);
			expect(
				orders?.orders.every(
					(order) =>
						order.fill_accounting?.status === "pending" &&
						order.filled_size_usdc === null,
				),
			).toBe(true);
			const own = after[0].positions[0];
			if (!own) throw new Error("Missing filled own fixture position");
			await db.transaction(
				async (tx) => {
					const params = {
						db: tx,
						billingAccountId: f.account,
						walletAddress: f.paper,
						mode: "paper" as const,
						capturedAt: at(30),
						livePositions: [own],
						positionFacts: after[1].positionFacts,
					};
					const outputs = [
						await buildMarketExposureGroups(params),
						(await buildBoundedMarketExposureGroups(params)).groups,
						(
							await buildBoundedMarketExposureWithCoverage({
								...params,
								connectionKind: "paper",
							})
						).market.groups,
					];
					for (const groups of outputs) {
						expect(
							groups
								.flatMap((g) => g.lines)
								.flatMap((l) => l.participants)
								.find((p) => p.side === "our_wallet")?.primary?.outcome,
						).toBe(own.outcome);
					}
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
			expect(
				rows<{ disabled_at: unknown }>(
					await db.execute(
						sql`SELECT disabled_at FROM poly_copy_trade_targets WHERE billing_account_id=${f.account}`,
					),
				)[0]?.disabled_at,
			).not.toBeNull();
		} finally {
			await f.cleanup();
		}
	});

	it("classifies lossless numeric provider names before priority while preserving missing, primary conflict and opposite authority", async () => {
		const f = await originFixture();
		try {
			await f.seed();
			await f.publish(["1", "0"]);
			const first = await db.transaction((tx) => f.read(tx), {
				isolationLevel: "repeatable read",
				accessMode: "read only",
			});
			expect(f.value(first)).toMatchObject({
				outcome: "1",
				originAvailability: "available",
				oppositeTokenId: null,
			});
			const provider = await readPositionMetadata({
				db,
				keys: [
					{
						conditionId: f.condition,
						tokenId: f.tokens[0],
						walletAddress: f.target,
					},
				],
			});
			expect(
				provider.get(
					positionMetadataRequestKey({
						conditionId: f.condition,
						tokenId: f.tokens[0],
						walletAddress: f.target,
					}) ?? "",
				)?.outcome,
			).toBe("1");
			await db.execute(sql`INSERT INTO poly_trader_current_positions
        (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,last_observed_at,raw)
        VALUES (${f.paperRow.id},${f.condition},${f.tokens[0]},10,4,6,.4,'untyped-index',${at(25)}::timestamptz,'{"outcome":"1","position_gap_version":"3","title":"Own title"}'::jsonb)`);
			const newerUntyped = await db.transaction((tx) => f.read(tx), {
				isolationLevel: "repeatable read",
				accessMode: "read only",
			});
			expect(f.value(newerUntyped)).toMatchObject({
				outcome: "1",
				marketTitle: "Own title",
			});
			expect(f.value(newerUntyped)?.provenance.outcome?.source).toBe(
				"origin_current",
			);
			for (const label of ["Primary one", "Primary two"]) {
				await db.execute(sql`INSERT INTO poly_trader_position_snapshots
          (trader_wallet_id,condition_id,token_id,shares,cost_basis_usdc,current_value_usdc,avg_price,content_hash,captured_at,raw)
          VALUES (${f.paperRow.id},${f.condition},${f.tokens[0]},10,4,6,.4,${randomUUID()},${at(26)}::timestamptz,${JSON.stringify({ outcome: label })}::jsonb)`);
			}
			const conflict = await db.transaction((tx) => f.read(tx), {
				isolationLevel: "repeatable read",
				accessMode: "read only",
			});
			expect(f.value(conflict)).toMatchObject({
				outcome: null,
				availability: "conflict",
				oppositeTokenId: null,
				marketTitle: "Own title",
			});
			expect(f.value(await f.read())).toMatchObject({
				outcome: null,
				availability: "conflict",
			});
		} finally {
			await f.cleanup();
		}
	});
	it("denies wrong account, own wallet, mode, UUID, token, retained identity and future clocks while keeping primary titles", async () => {
		const f = await originFixture();
		try {
			await f.publish();
			await db.execute(sql`INSERT INTO poly_market_metadata (condition_id,market_title,fetched_at)
        VALUES (${f.condition},'Independent primary title',${at(1)}::timestamptz)`);
      const [retainedTarget] = rows<{ id: string }>(await db.execute(sql`SELECT id FROM poly_copy_trade_targets WHERE billing_account_id=${f.account}`));
      if (!retainedTarget) throw new Error("Missing retained target UUIDv4");
			const negatives: Array<Parameters<typeof f.seed>[0]> = [
				{ token: f.tokens[1] },
				{ targetId: randomUUID() },
        { targetId: retainedTarget.id },
				{ targetWallet: `0x${"f".repeat(40)}` },
				{ conditionId: `0x${"f".repeat(64)}` },
				{ mode: "live" },
				{ observedAt: at(31) },
				{ observedAt: at(20) },
				{ orderId: null },
				{ targetWallet: "malformed" },
			];
			for (const negative of negatives) {
				await db.execute(
					sql`DELETE FROM poly_copy_trade_fills WHERE billing_account_id=${f.account}`,
				);
				await f.seed(negative);
				const result = await db.transaction((tx) => f.read(tx), {
					isolationLevel: "repeatable read",
					accessMode: "read only",
				});
				expect(f.value(result), JSON.stringify(negative)).toMatchObject({
					outcome: null,
					marketTitle: "Independent primary title",
					originAvailability: "unavailable",
				});
			}
			await db.execute(
				sql`DELETE FROM poly_copy_trade_fills WHERE billing_account_id=${f.account}`,
			);
			await f.seed();
			for (const change of [
				sql`UPDATE poly_wallet_connections SET created_at=${at(11)}::timestamptz WHERE billing_account_id=${f.account}`,
				sql`UPDATE poly_wallet_connections SET revoked_at=${at(15)}::timestamptz WHERE billing_account_id=${f.account}`,
				sql`UPDATE poly_wallet_connections SET funder_address=NULL WHERE billing_account_id=${f.account}`,
				sql`UPDATE poly_copy_trade_targets SET created_at=${at(11)}::timestamptz WHERE billing_account_id=${f.account}`,
			]) {
				await db.execute(change);
				const result = await db.transaction((tx) => f.read(tx), {
					isolationLevel: "repeatable read",
					accessMode: "read only",
				});
				expect(f.value(result)).toMatchObject({
					outcome: null,
					marketTitle: "Independent primary title",
					originAvailability: "unavailable",
				});
				await db.execute(
					sql`UPDATE poly_wallet_connections SET created_at=${at(0)}::timestamptz,revoked_at=NULL,funder_address=${f.paper} WHERE billing_account_id=${f.account}`,
				);
				await db.execute(
					sql`UPDATE poly_copy_trade_targets SET created_at=${at(0)}::timestamptz WHERE billing_account_id=${f.account}`,
				);
			}
      await f.publish(["Future name", "Future other"], 31);
      expect(f.value(await db.transaction(tx => f.read(tx), { isolationLevel: "repeatable read", accessMode: "read only" }))?.outcome).toBe("Sangal");
			await db.transaction(
				async (tx) => {
					for (const key of [
						{ ...f.key(), walletAddress: f.target },
						{ ...f.key(), mode: "live" as const },
					]) {
						const result = await readPositionMetadata({
							db: tx,
							accountScope: f.accountScope,
							keys: [key],
							capturedAt: at(30),
						});
						expect(
							result.get(positionMetadataRequestKey(key, f.accountScope) ?? "")
								?.originAvailability,
						).toBe("unavailable");
					}
					const wrongScope = { billingAccountId: randomUUID() };
					const result = await readPositionMetadata({
						db: tx,
						accountScope: wrongScope,
						keys: [f.key()],
						capturedAt: at(30),
					});
					expect(
						result.get(positionMetadataRequestKey(f.key(), wrongScope) ?? ""),
					).toMatchObject({ outcome: null, originAvailability: "unavailable" });
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
			await db.execute(
				sql`UPDATE poly_trader_current_positions SET raw=raw||jsonb_build_object('asset',${f.tokens[1]}::text) WHERE lower(condition_id)=${f.condition}`,
			);
			await db.execute(
				sql`UPDATE poly_trader_position_snapshots SET raw=raw||jsonb_build_object('conditionId',${`0x${"f".repeat(64)}`}::text) WHERE lower(condition_id)=${f.condition}`,
			);
			expect(
				f.value(
					await db.transaction((tx) => f.read(tx), {
						isolationLevel: "repeatable read",
						accessMode: "read only",
					}),
				)?.outcome,
			).toBeNull();
		} finally {
			await f.cleanup();
		}
	});

	it("uses all retained origins and retains equal-time conflicts and agreement across physical siblings", async () => {
		const f = await originFixture();
		const second =
			`0x${randomUUID().replaceAll("-", "")}aabbccdd` as `0x${string}`;
		try {
			await f.seed({ attributes: { title: "Plausible legacy ledger headline" } });
			await f.publish();
			await db.insert(polyCopyTradeTargets).values({
				billingAccountId: f.account,
				createdByUserId: f.user,
				targetWallet: second,
				createdAt: new Date(at(0)),
				disabledAt: new Date(at(20)),
			});
			await db.execute(
				sql`INSERT INTO poly_trader_wallets (wallet_address,kind,label) VALUES (${second},'copy_target','Second retained origin')`,
			);
			await addCurrent(
				second,
				f.condition,
				f.tokens[0],
				{
					title: "Conflicting title",
					outcome: "Conflicting named origin",
					slug: "conflicting-slug",
				},
				5,
			);
			await f.seed({
				targetWallet: second,
				targetId: targetIdFromWallet(second),
			});
			const conflict = await db.transaction((tx) => f.read(tx), {
				isolationLevel: "repeatable read",
				accessMode: "read only",
			});
			expect(f.value(conflict)).toMatchObject({
				outcome: null,
				marketTitle: null,
				marketSlug: null,
				availability: "conflict",
				oppositeTokenId: null,
			});
			// A plausible legacy title must not revive the shared reader's rejected
			// tied-origin title through the public orders serialization path.
			const orders = await withTenantScope(
				getAppDb(),
				userActor(toUserId(f.user)),
				async (tx) => {
					await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
					return listCopyTradeOrdersForAccount(tx, { status: "all", limit: 200 }, f.account);
				},
			);
			expect(orders?.orders).toHaveLength(2);
			expect(orders?.orders.map(order => order.market_title)).toEqual([null, null]);

			await addCurrent(
				second,
				f.condition,
				f.tokens[0],
				{
					title: "Retained filled market",
					outcome: "Sangal",
					slug: "known-market",
				},
				5,
			);
			expect(
				f.value(
					await db.transaction((tx) => f.read(tx), {
						isolationLevel: "repeatable read",
						accessMode: "read only",
					}),
				),
			).toMatchObject({ outcome: "Sangal" });
		} finally {
			await f.cleanup();
			await db.execute(
				sql`DELETE FROM poly_trader_wallets WHERE wallet_address=${second}`,
			);
		}
	});

	it("bounds physical candidates before malformed eligibility, revalidates PKs, and proves two SELECTs in one read-only snapshot", async () => {
		const f = await originFixture();
		try {
			await f.seed();
			await f.publish();
			// A large unrelated physical market population makes a true account/market seek observable.
			await db.execute(sql`INSERT INTO poly_copy_trade_fills
        (billing_account_id,created_by_user_id,target_id,fill_id,market_id,observed_at,client_order_id,status,mode,attributes)
        SELECT ${f.account},${f.user},${targetIdFromWallet(f.target)}::uuid,'unrelated-'||n,
          'prediction-market:polymarket:unrelated-'||n,${at(10)}::timestamptz,${f.account}||'-unrelated-'||n,'filled','paper','{}'::jsonb
        FROM generate_series(1,5000) n`);
			await getAppDb().execute(sql`ANALYZE poly_copy_trade_fills`);
			const dialect = new PgDialect();
			const statements: string[] = [];
			await db.transaction(
				async (tx) => {
					const sameSnapshot = await f.read({
						execute: async (query) => {
							const text = dialect.sqlToQuery(query).sql;
							statements.push(text);
							const result = await tx.execute(query);
							if (statements.length === 1) {
								await db.execute(sql`UPDATE poly_trader_current_positions SET raw=raw||'{"outcome":"New concurrent label"}'::jsonb
              WHERE trader_wallet_id IN (SELECT id FROM poly_trader_wallets WHERE wallet_address=${f.target})`);
							}
							return result;
						},
					});
					expect(f.value(sameSnapshot)?.outcome).toBe("Sangal");
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
			expect(statements).toHaveLength(2);
			expect(
				statements.every(
					(text) => !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(text),
				),
			).toBe(true);
			expect(f.value(await f.read())).toMatchObject({
				outcome: null,
				originAvailability: "unavailable",
			});
			await db.transaction(
				async (tx) => {
					const descriptorQuery = positionMetadataOriginSelect(
						f.batch(),
						f.account,
						at(30),
					);
					const descriptors = rows<OriginDescriptor>(
						await tx.execute(descriptorQuery),
					);
					expect(descriptors).toHaveLength(1);
					const metadataQuery = positionMetadataSelect(
						f.batch(),
						at(30),
						descriptors,
					);
					const evidence = rows<{ raw: Record<string, unknown> }>(
						await tx.execute(metadataQuery),
					);
					expect(evidence.length).toBeLessThanOrEqual(24);
					const plans: Plan[][] = [];
					for (const query of [descriptorQuery, metadataQuery]) {
						const result = rows<{ "QUERY PLAN": Array<{ Plan: Plan }> }>(
							await tx.execute(
								sql`EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) ${query}`,
							),
						);
						const plan = result[0]?.["QUERY PLAN"][0]?.Plan;
						if (!plan) throw new Error("Missing origin query plan");
						plans.push(planNodes(plan));
					}
					expect(
						plans[0]?.some(
							(node) =>
								node["Index Name"] ===
								"poly_copy_trade_fills_investigation_idx",
						),
					).toBe(true);
					expect(
						plans[1]?.some((node) =>
							String(node["Index Name"]).includes(
								"poly_copy_trade_fills_billing_account_id_target_id_fill_id_pk",
							),
						),
					).toBe(true);
					for (const nodes of plans) {
						for (const node of nodes.filter(
							(node) => node["Relation Name"] === "poly_copy_trade_fills",
						)) {
							expect(String(node["Node Type"])).not.toBe("Seq Scan");
						}
					}
					const tampered = descriptors.map((d) => ({
						...d,
						order_id: randomUUID(),
					}));
					expect(
						rows(
							await tx.execute(
								positionMetadataSelect(f.batch(), at(30), tampered),
							),
						),
					).toHaveLength(0);
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
			// 257 wrong-token/malformed records must consume the physical budget, even with a valid row deeper in history.
			await db.execute(sql`INSERT INTO poly_copy_trade_fills
        (billing_account_id,created_by_user_id,target_id,fill_id,market_id,observed_at,client_order_id,order_id,status,mode,attributes)
        SELECT ${f.account},${f.user},${targetIdFromWallet(f.target)}::uuid,'overflow-'||n,
          ${`prediction-market:polymarket:${f.condition}`},${at(15)}::timestamptz,${f.account}||'-overflow-'||n,NULL,'filled','paper',
          CASE WHEN n%2=0 THEN '{}'::jsonb ELSE jsonb_build_object('token_id','wrong-token') END
        FROM generate_series(1,257) n`);
			await getAppDb().execute(sql`ANALYZE poly_copy_trade_fills`);
			await db.transaction(
				async (tx) => {
					const query = positionMetadataOriginSelect(
						f.batch(),
						f.account,
						at(30),
					);
					const descriptors = rows<OriginDescriptor>(await tx.execute(query));
					expect(descriptors).toHaveLength(257);
					const result = await f.read(tx);
					expect(f.value(result)).toMatchObject({
						outcome: null,
						originAvailability: "overflow",
					});
					const explain = rows<{ "QUERY PLAN": Array<{ Plan: Plan }> }>(
						await tx.execute(
							sql`EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) ${query}`,
						),
					);
					const plan = explain[0]?.["QUERY PLAN"][0]?.Plan;
					if (!plan) throw new Error("Missing overflow plan");
					const candidateLimits = planNodes(plan).filter(node =>
						node["Node Type"] === "Limit" && planNodes(node).some(child => child["Relation Name"] === "poly_copy_trade_fills"));
					// Keep CI diagnostics bounded and omit account, wallet, token and raw values.
					const physicalPlan = planNodes(plan).filter(node =>
						node["Relation Name"] === "poly_copy_trade_fills" || ["Limit", "Sort", "Incremental Sort"].includes(String(node["Node Type"])))
						.slice(0, 12).map(node => ({
							node: node["Node Type"], index: node["Index Name"], rows: node["Actual Rows"], loops: node["Actual Loops"],
							removed: node["Rows Removed by Filter"] ?? 0,
							seekColumns: ["billing_account_id", "market_id", "mode", "observed_at"].filter(column => String(node["Index Cond"] ?? "").includes(column)),
							blocks: Number(node["Shared Hit Blocks"] ?? 0) + Number(node["Shared Read Blocks"] ?? 0),
						}));
					const planEvidence = JSON.stringify({ probe: "metadata_origin_physical_budget", nodes: physicalPlan });
					console.info(planEvidence);
					expect(candidateLimits, planEvidence).toHaveLength(1);
					for (const limit of candidateLimits) {
						expect(Number(limit["Actual Rows"]), planEvidence).toBe(257);
						expect(planNodes(limit).some(node => ["Sort", "Incremental Sort"].includes(String(node["Node Type"]))), planEvidence).toBe(false);
					}
					const ledgerNodes = planNodes(plan).filter(
						(node) => node["Relation Name"] === "poly_copy_trade_fills",
					);
					expect(ledgerNodes.length).toBeGreaterThan(0);
					for (const node of ledgerNodes) {
						expect(node["Index Name"]).toBe(
							"poly_copy_trade_fills_investigation_idx",
						);
						expect(
							Number(node["Actual Rows"]) +
								Number(node["Rows Removed by Filter"] ?? 0),
						).toBeLessThanOrEqual(257);
						expect(
							Number(node["Shared Hit Blocks"] ?? 0) +
								Number(node["Shared Read Blocks"] ?? 0),
						).toBeGreaterThan(0);
					}
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
			// Keys are batched physically (100 + 1), never silently truncated.
			await db.transaction(
				async (tx) => {
					let calls = 0;
					const result = await readPositionMetadata({
						db: {
							execute: async (query) => {
								calls++;
								return tx.execute(query);
							},
						},
						accountScope: f.accountScope,
						capturedAt: at(30),
						keys: Array.from({ length: 101 }, (_, n) => ({
							...f.key(),
							tokenId: String(n + 1),
						})),
					});
					expect(calls).toBe(4);
					expect(result.size).toBe(101);
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
		} finally {
			await f.cleanup();
		}
	});
});

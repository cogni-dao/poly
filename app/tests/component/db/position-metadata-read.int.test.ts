// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Real saved publication -> per-field reader -> bounded comparison assembly. */
import { randomUUID } from "node:crypto";
import { toUserId, userActor } from "@cogni/ids";
import type { TargetBookSnapshotV1 } from "@cogni/poly-market-provider";
import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { persistPositionGapTargetSnapshot } from "@/features/wallet-analysis/server/copy-target-position-hydration-service";
import { getRecentAttemptsForAccount } from "@/features/wallet-analysis/server/copy-trade-attempts-read";
import {
  buildBoundedMarketExposureGroups,
  buildBoundedMarketExposureWithCoverage,
} from "@/features/wallet-analysis/server/market-exposure-service";
import { refreshMarketMetadata } from "@/features/wallet-analysis/server/poly-market-metadata-service";
import {
  positionMetadataRequestKey,
  positionMetadataSelect,
  readPositionMetadata,
} from "@/features/wallet-analysis/server/position-metadata-read";
import { getTargetPositionsForAccount } from "@/features/wallet-analysis/server/target-positions-read";
import {
  billingAccounts,
  polyCopyTradeTargets,
  users,
} from "@/shared/db/schema";

const unique = randomUUID().replaceAll("-", "");
const conditionId = `0x${unique}${unique}`;
const fieldCondition = `0x${unique}${"a".repeat(32)}`;
const planCondition = `0x${unique}${"b".repeat(32)}`;
const tiedCondition = `0x${unique}${"c".repeat(32)}`;
const attemptCondition = `0x${unique}${"d".repeat(32)}`;
const wallet = `0x${unique}aabbccdd`;
const ownWallet = `0x${unique}eeff0011`;
const unknownWallet = `0x${unique}11223344`;
const tokenId = "6789012345678901234567890";
const oppositeTokenId = "6789012345678901234567891";
const thirdTokenId = "6789012345678901234567892";
const userId = `metadata-user-${unique}`;
const accountId = `metadata-account-${unique}`;
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
    FROM poly_trader_wallets WHERE wallet_address=${address}
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
    await db.execute(
      sql`INSERT INTO poly_trader_wallets (wallet_address,kind,label) VALUES (${ownWallet},'cogni_wallet','Our wallet')`,
    );
  });
  afterAll(async () => {
    await db.execute(
      sql`DELETE FROM poly_market_metadata WHERE lower(condition_id) IN (${conditionId},${fieldCondition},${planCondition},${tiedCondition},${attemptCondition})`,
    );
    await db.execute(
      sql`DELETE FROM poly_market_outcomes WHERE lower(condition_id) IN (${conditionId},${fieldCondition},${planCondition},${tiedCondition},${attemptCondition})`,
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

  it("does not leak a future-only canonical title through the actual attempts entrypoint", async () => {
    await db.execute(sql`INSERT INTO poly_market_metadata (condition_id,market_title,fetched_at)
      VALUES (${attemptCondition},'Future-only title',${at(40)}::timestamptz)`);
    await db.execute(sql`INSERT INTO poly_copy_trade_decisions
      (billing_account_id,created_by_user_id,target_id,fill_id,outcome,reason,intent,decided_at,mode)
      VALUES (${accountId},${userId},${randomUUID()}::uuid,${randomUUID()},'skipped','cutoff-test',
        ${JSON.stringify({ market_id: `prediction-market:polymarket:${attemptCondition}`, token_id: tokenId, side: "BUY", target_wallet: wallet })}::jsonb,
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
    await db.insert(polyCopyTradeTargets).values({
      billingAccountId: accountId,
      createdByUserId: userId,
      targetWallet: wallet,
    });
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

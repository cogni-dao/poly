// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Bounded dashboard market mode: cardinality and canonical semantic parity. */
import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildBoundedMarketExposureGroups, type ComparisonEconomicFact } from "@/features/wallet-analysis/server/market-exposure-service";

const OUR = `0x${"1".repeat(40)}`;
const TARGET = `0x${"2".repeat(40)}`;

function position(index = 0): WalletExecutionPosition {
  return {
    positionId: `condition-${index}:our-${index}`,
    conditionId: `condition-${index}`,
    asset: `our-${index}`,
    marketTitle: `Market ${index}`,
    eventTitle: `Event ${index}`,
    marketSlug: `market-${index}`,
    eventSlug: `event-${index}`,
    marketUrl: null,
    outcome: "Yes",
    status: "open",
    lifecycleState: "open",
    openedAt: "2026-10-03T00:00:00.000Z",
    closedAt: null,
    resolvesAt: null,
    size: 10,
    entryPrice: 0.5,
    currentPrice: 0.6,
    currentValue: 6,
    pnlUsd: 1,
    pnlPct: 20,
    heldMinutes: 1,
    timeline: [],
    events: [],
  };
}

function targetParticipant(overrides?: Record<string, unknown>) {
  return {
    total_participants: 1,
    group_truncated: false,
    group_key: "event:event-0",
    wallet_address: TARGET,
    label: "Target",
    condition_id: "condition-0",
    legs: [
      {
        token_id: "target-primary",
        market_title: "Market 0",
        event_title: "Event 0",
        market_slug: "market-0",
        event_slug: "event-0",
        outcome: "Yes",
        shares: "16",
        cost_basis_usdc: "8",
        current_value_usdc: "10",
        avg_price: "0.5",
        last_observed_at: "2026-10-03T00:00:00.000Z",
        lifecycle: "active",
      },
      {
        token_id: "target-hedge",
        market_title: "Market 0",
        event_title: "Event 0",
        market_slug: "market-0",
        event_slug: "event-0",
        outcome: "No",
        shares: "6",
        cost_basis_usdc: "3",
        current_value_usdc: "2",
        avg_price: "0.5",
        last_observed_at: "2026-10-03T00:00:00.000Z",
        lifecycle: "active",
      },
    ],
    ...overrides,
  };
}

function fakeDb(targetRows: unknown[], rollupRows: unknown[] = [], metadataRows: unknown[] = []) {
  const sql: string[] = [];
  let call = 0;
  return {
    sql,
    execute: async (query: unknown) => {
      const statement = new PgDialect().sqlToQuery(query as never).sql;
      sql.push(statement);
      if (statement.includes("jsonb_to_recordset")) return metadataRows;
      call += 1;
      if (call === 1) return targetRows;
      if (call === 2) return [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }];
      return rollupRows;
    },
  };
}

describe("bounded market exposure", () => {
  it("hydrates one SQL participant with canonical primary+hedge and keeps gross BUY distinct from snapshot cost", async () => {
    const db = fakeDb([targetParticipant()], [
      {
        wallet_address: TARGET,
        condition_id: "condition-0",
        token_id: "target-primary",
        total_buy_notional: "30",
        realized_cash: "0",
        net_shares: "16",
        market_outcome: "unknown",
      },
      {
        wallet_address: TARGET,
        condition_id: "condition-0",
        token_id: "target-hedge",
        total_buy_notional: "5",
        realized_cash: "0",
        net_shares: "6",
        market_outcome: "unknown",
      },
    ]);

    const read = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: "tenant-a",
      walletAddress: OUR,
      livePositions: [position()],
    });

    const line = read.groups[0]?.lines[0];
    const target = line?.participants.find((row) => row.side === "copy_target");
    expect(target?.primary?.tokenId).toBe("target-primary");
    expect(target?.hedge?.tokenId).toBe("target-hedge");
    expect(line?.targetEntryValueUsdc).toBe(11);
    expect(line?.targetGrossBuyNotionalUsdc).toBe(35);
    expect(read.truncated).toBe(false);
    expect(db.sql[0]).toContain("jsonb_agg");
    expect(db.sql[0]).toContain("group_rank <=");
    expect(db.sql[2]).toContain("selected_keys");
  });

  it("matches our exact target token only in the third leg and conserves all exposure", async () => {
    const conditionId = `0x${"ab".repeat(32)}`;
    const own = { ...position(), conditionId, asset: "111", positionId: `${conditionId}:111`, eventSlug: "event-0" };
    const base = targetParticipant();
    const legs = base.legs.map((leg, i) => ({ ...leg, token_id: i === 0 ? "222" : "333" }));
    legs.push({ ...legs[1]!, token_id: "111", current_value_usdc: "7", cost_basis_usdc: "2", outcome: "Additional" });
    const db = fakeDb([{ ...base, condition_id: conditionId, legs }]);
    const read = await buildBoundedMarketExposureGroups({db,billingAccountId:"tenant-a",walletAddress:OUR,livePositions:[own]});
    const line = read.groups[0]?.lines[0];
    const target = line?.participants.find(p => p.side === "copy_target");
    expect(target?.primary?.tokenId).toBe("222");
    expect(target?.hedge?.tokenId).toBe("333");
    expect(target?.legs).toHaveLength(3);
    expect(target?.net.currentValueUsdc).toBe(19);
    expect(target?.net.pnlUsdc).toBeNull();
    expect(line?.tokenComparisons).toEqual([expect.objectContaining({ourTokenId:"111",targetTokenId:"111",relation:"same",targetWallet:TARGET})]);
    // Ours +20% (saved pnlPct) vs target 111: (7 - 2) / 2 = +250% → gap 2.3.
    expect(line?.edgeGapPct).toBe(2.3);
    expect(line?.edgeGapUsdc).toBe(11.5);
  });

  it("retains closed exact-token identity when valuation and lifetime PnL are unavailable", async () => {
    const conditionId=`0x${"cd".repeat(32)}`;
    const own={...position(),conditionId,asset:"111",positionId:`${conditionId}:111`,status:"closed" as const,currentPrice:null,currentValue:null,pnlUsd:null,pnlPct:null};
    const target=targetParticipant();
    const db=fakeDb([{...target,condition_id:conditionId,legs:[{...target.legs[0]!,token_id:"111"}]}]);
    const read=await buildBoundedMarketExposureGroups({db,billingAccountId:"tenant-a",walletAddress:OUR,livePositions:[],closedPositions:[own]});
    const line=read.groups[0]?.lines[0];
    expect(line?.tokenComparisons?.[0]).toMatchObject({ourTokenId:"111",targetTokenId:"111",relation:"same",economicsAvailability:"unavailable"});
    expect(line?.ourValueUsdc).toBeNull();
    expect(line?.participants.find(p=>p.side==="our_wallet")?.primary?.pnlUsdc).toBeNull();
  });

  it.each(["live", "paper"] as const)(
    "selects only %s canonical economics for an exact token",
    async (mode) => {
      const conditionId = `0x${"ef".repeat(32)}`;
      const own = {
        ...position(),
        conditionId,
        asset: "111",
        positionId: `${conditionId}:111`,
      };
      const fact = (
        factMode: "live" | "paper",
        amount: number,
      ): ComparisonEconomicFact => ({
        mode: factMode,
        conditionId,
        tokenId: "111",
        heldShares: 10,
        currentValueUsdc: amount + 1,
        remainingBasisUsdc: amount,
        unrealizedPnlUsdc: 1,
        lifetimePnlUsdc: amount + 2,
        inventoryCoverage: "complete",
        economicsCoverage: "complete",
      });
      const read = await buildBoundedMarketExposureGroups({
        db: fakeDb([]),
        billingAccountId: "tenant-a",
        walletAddress: OUR,
        mode,
        livePositions: [own],
        positionFacts: [fact("paper", 40), fact("live", 10)],
      });
      const leg = read.groups[0]?.lines[0]?.participants[0]?.primary;
      expect(leg).toMatchObject({
        currentValueUsdc: mode === "live" ? 11 : 41,
        costBasisUsdc: mode === "live" ? 10 : 40,
        pnlUsdc: mode === "live" ? 12 : 42,
      });
    },
  );

  it("never consumes a sole paper fact for the default live request", async () => {
    const conditionId = `0x${"ef".repeat(32)}`;
    const read = await buildBoundedMarketExposureGroups({
      db: fakeDb([]),
      billingAccountId: "tenant-a",
      walletAddress: OUR,
      livePositions: [{ ...position(), conditionId, asset: "111" }],
      positionFacts: [
        {
          mode: "paper",
          conditionId,
          tokenId: "111",
          heldShares: 10,
          currentValueUsdc: 999,
          remainingBasisUsdc: 998,
          unrealizedPnlUsdc: 1,
          lifetimePnlUsdc: 997,
          inventoryCoverage: "complete",
          economicsCoverage: "complete",
        },
      ],
    });
    expect(read.groups[0]?.lines[0]?.participants[0]?.primary).toMatchObject({
      currentValueUsdc: null,
      costBasisUsdc: null,
      pnlUsdc: null,
    });
  });

  describe("exact-token return gap (bug.5061: the |Δ| chart must not be empty)", () => {
    const closedOwn = (conditionId: string, asset: string, pnlPct: number | null) => ({
      ...position(),
      conditionId,
      asset,
      positionId: `${conditionId}:${asset}`,
      status: "closed" as const,
      size: 20,
      entryPrice: 0.5,
      currentValue: 0,
      currentPrice: 0,
      pnlUsd: pnlPct === null ? null : (pnlPct / 100) * 10,
      pnlPct,
    });
    const targetRow = (conditionId: string, legs: Record<string, unknown>[], wallet = TARGET) => ({
      ...targetParticipant(),
      wallet_address: wallet,
      condition_id: conditionId,
      legs: legs.map((leg) => ({ ...targetParticipant().legs[0]!, ...leg })),
    });
    const rollup = (conditionId: string, tokenId: string, outcome: string) => ({
      wallet_address: TARGET,
      condition_id: conditionId,
      token_id: tokenId,
      total_buy_notional: "1",
      realized_cash: "0",
      net_shares: "1",
      market_outcome: outcome,
    });

    it("plots a closed position against the target's resolved outcome, not a stale mark", async () => {
      const c = `0x${"a1".repeat(32)}`;
      // Target held 10 sh at $0.40 (cost 4) and the market resolved a winner:
      // value = shares = 10 → +150%. Snapshot mark was stale at 0.9 (value 9).
      const db = fakeDb(
        [targetRow(c, [{ token_id: "111", shares: "10", cost_basis_usdc: "4", current_value_usdc: "9", lifecycle: "inactive" }])],
        [rollup(c, "111", "winner")]
      );
      const read = await buildBoundedMarketExposureGroups({
        db, billingAccountId: "tenant-a", walletAddress: OUR,
        livePositions: [], closedPositions: [closedOwn(c, "111", 100)],
      });
      const line = read.groups[0]?.lines[0];
      expect(line?.status).toBe("closed");
      expect(line?.edgeGapPct).toBe(0.5); // 1.5 - 1.0
      expect(read.groups[0]?.edgeGapPct).toBe(0.5);
      expect(line?.edgeGapUsdc).toBe(5); // 0.5 × our $10 lifetime BUY
    });

    it("uses 0 value for a resolved loser and the last mark when unresolved", async () => {
      const c1 = `0x${"b1".repeat(32)}`;
      const c2 = `0x${"b2".repeat(32)}`;
      const db = fakeDb(
        [
          targetRow(c1, [{ token_id: "111", shares: "10", cost_basis_usdc: "4", current_value_usdc: "1", lifecycle: "inactive" }]),
          targetRow(c2, [{ token_id: "222", shares: "10", cost_basis_usdc: "4", current_value_usdc: "6", lifecycle: "inactive" }]),
        ],
        [rollup(c1, "111", "loser")]
      );
      const read = await buildBoundedMarketExposureGroups({
        db, billingAccountId: "tenant-a", walletAddress: OUR,
        livePositions: [],
        closedPositions: [closedOwn(c1, "111", -100), closedOwn(c2, "222", 25)],
      });
      const byCondition = new Map(read.groups.flatMap((g) => g.lines).map((l) => [l.conditionId, l]));
      expect(byCondition.get(c1)?.edgeGapPct).toBe(0); // target -100%, ours -100%
      expect(byCondition.get(c2)?.edgeGapPct).toBe(0.25); // target +50%, ours +25%
    });

    it("never fabricates a delta from unknown economics, opposite tokens, or a zero target basis", async () => {
      const unknownOwn = `0x${"c1".repeat(32)}`;
      const oppositeOnly = `0x${"c2".repeat(32)}`;
      const zeroBasis = `0x${"c3".repeat(32)}`;
      const db = fakeDb([
        targetRow(unknownOwn, [{ token_id: "111", lifecycle: "inactive" }]),
        targetRow(oppositeOnly, [{ token_id: "999", lifecycle: "inactive" }]),
        targetRow(zeroBasis, [{ token_id: "333", cost_basis_usdc: "0", lifecycle: "inactive" }]),
      ]);
      const read = await buildBoundedMarketExposureGroups({
        db, billingAccountId: "tenant-a", walletAddress: OUR,
        livePositions: [],
        closedPositions: [
          closedOwn(unknownOwn, "111", null),
          closedOwn(oppositeOnly, "222", 10),
          closedOwn(zeroBasis, "333", 10),
        ],
      });
      expect(read.groups.flatMap((g) => g.lines).map((l) => l.edgeGapPct)).toEqual([null, null, null]);
      expect(read.groups.map((g) => g.edgeGapPct)).toEqual([null, null, null]);
    });

    it("cost-weights several targets that hold the same exact token", async () => {
      const c = `0x${"d1".repeat(32)}`;
      const OTHER = `0x${"3".repeat(40)}`;
      const db = fakeDb([
        targetRow(c, [{ token_id: "111", cost_basis_usdc: "10", current_value_usdc: "12", lifecycle: "inactive" }]),
        targetRow(c, [{ token_id: "111", cost_basis_usdc: "30", current_value_usdc: "45", lifecycle: "inactive" }], OTHER),
      ]);
      const read = await buildBoundedMarketExposureGroups({
        db, billingAccountId: "tenant-a", walletAddress: OUR,
        livePositions: [], closedPositions: [closedOwn(c, "111", 0)],
      });
      // (0.2 * 10 + 0.5 * 30) / 40 = 0.425 target vs 0 ours.
      expect(read.groups[0]?.lines[0]?.edgeGapPct).toBe(0.425);
    });
  });

  it("marks partial when a group exceeds ten target participants", async () => {
    const db = fakeDb([
      targetParticipant({ total_participants: 10, group_truncated: true }),
    ]);
    const read = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: "tenant-a",
      walletAddress: OUR,
      livePositions: [position()],
    });
    expect(read.truncated).toBe(true);
  });

  it("keeps target entry/value but marks lifetime BUY unavailable without a complete fill rollup", async () => {
    const db = fakeDb([targetParticipant()]);
    const read = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: "tenant-a",
      walletAddress: OUR,
      livePositions: [position()],
    });

    expect(read.groups[0]?.lines[0]).toMatchObject({
      targetEntryValueUsdc: 11,
      targetValueUsdc: 12,
      targetGrossBuyNotionalUsdc: null,
    });
  });

  it("keeps a measured target value but makes a zero entry basis unavailable", async () => {
    const zeroEntry = targetParticipant();
    zeroEntry.legs = zeroEntry.legs.map((leg) => ({
      ...leg,
      cost_basis_usdc: "0",
    }));
    const db = fakeDb([zeroEntry]);
    const read = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: "tenant-a",
      walletAddress: OUR,
      livePositions: [position()],
    });

    expect(read.groups[0]).toMatchObject({
      targetEntryValueUsdc: null,
      targetValueUsdc: 12,
    });
    expect(read.groups[0]?.lines[0]).toMatchObject({
      targetEntryValueUsdc: null,
      targetValueUsdc: 12,
      edgeGapPct: null,
    });
  });

  it("does not render an inactive saved target snapshot on the live fallback path", async () => {
    const inactive = targetParticipant();
    inactive.legs = inactive.legs.map((leg) => ({
      ...leg,
      lifecycle: "inactive",
    }));
    const db = fakeDb([inactive]);
    const read = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: "tenant-a",
      walletAddress: OUR,
      livePositions: [position()],
    });

    expect(read.groups[0]?.lines[0]).toMatchObject({
      targetEntryValueUsdc: null,
      targetValueUsdc: null,
      targetGrossBuyNotionalUsdc: null,
      edgeGapPct: null,
    });
  });

  it("marks partial when the global participant budget truncates selected rows", async () => {
    const db = fakeDb([
      targetParticipant({ total_participants: 2_000, group_truncated: false }),
    ]);
    const read = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: "tenant-a",
      walletAddress: OUR,
      livePositions: [position()],
    });
    expect(read.truncated).toBe(true);
  });

  it("caps our event groups at 200 and marks the preview partial", async () => {
    const db = fakeDb([]);
    const read = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: "tenant-a",
      walletAddress: OUR,
      livePositions: Array.from({ length: 201 }, (_, index) => position(index)),
    });
    expect(read.groups).toHaveLength(200);
    expect(read.truncated).toBe(true);
    expect(read.groups[0]).toMatchObject({
      targetEntryValueUsdc: null,
      targetValueUsdc: null,
      targetGrossBuyNotionalUsdc: null,
      edgeGapUsdc: null,
      edgeGapPct: null,
    });
  });

  it("null-propagates group target totals when any child line lacks target facts", async () => {
    const identity = (index: number) => ({ conditionId: `0x${String(index + 1).padStart(64, "0")}`, tokenId: String(index + 1) });
    const identities = [identity(0), identity(1)];
    const db = fakeDb([targetParticipant({ condition_id: identity(0).conditionId, legs: targetParticipant().legs.map((leg, index) => ({ ...leg, token_id: String(11 + index) })) })], [], identities.map(identity => ({
      condition_id: identity.conditionId, token_id: identity.tokenId,
      requested_wallet: OUR, requested_mode: "live", source: "current",
      observed_at: "2026-10-03T00:00:00.000Z", raw: { eventSlug: "event-0", eventTitle: "Event 0" },
    })));
    const second = {
      ...position(1),
      conditionId: identity(1).conditionId, asset: identity(1).tokenId,
      eventTitle: "Event 0",
      eventSlug: "event-0",
    };
    const read = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: "tenant-a",
      walletAddress: OUR,
      livePositions: [{ ...position(), conditionId: identity(0).conditionId, asset: identity(0).tokenId }, second],
    });

    expect(read.groups).toHaveLength(1);
    expect(read.groups[0]?.lines).toHaveLength(2);
    expect(read.groups[0]).toMatchObject({
      targetEntryValueUsdc: null,
      targetValueUsdc: null,
      targetGrossBuyNotionalUsdc: null,
    });
  });
});

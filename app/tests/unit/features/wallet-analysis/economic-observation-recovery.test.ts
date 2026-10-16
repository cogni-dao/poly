// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { readFileSync } from "node:fs";
import type {
  PolymarketActivityV2,
  PolymarketUserPositionV2,
} from "@cogni/poly-market-provider/adapters/polymarket";
import type { TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildEconomicObservations,
  verifyEconomicSettlement,
} from "@/features/wallet-analysis/server/economic-observation-recovery";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../_fixtures/poly/economic-recovery-bcgame.json", import.meta.url),
    "utf8",
  ),
);
const positions = fixture.positions as PolymarketUserPositionV2[];
const activity = fixture.activity as PolymarketActivityV2[];
const wallet = "0x41a7ec25dc776bc364452c5c5cc936ffc6d5f296";
const conditionId = fixture.provenance.conditionId as string;
const winner = positions.find((row) => row.current_price === 1)!;
const receipt = {
  ...fixture.receipt,
  status: "success",
  blockNumber: BigInt(fixture.receipt.blockNumber),
  logs: fixture.receipt.logs.map((log: Record<string, unknown>) => ({
    ...log,
    logIndex: Number(log.logIndex),
    blockNumber: BigInt(String(log.blockNumber)),
  })),
} as TransactionReceipt;
const proofInput = {
  receipt,
  walletAddress: wallet,
  conditionId,
  tokenId: winner.token_id,
  expectedAtomic: 229280000n,
  canonicalBlockHash: receipt.blockHash,
  head: receipt.blockNumber + 5n,
};
const proof = verifyEconomicSettlement(proofInput)!;
const source = {
  walletAddress: wallet,
  conditionId,
  positions,
  activity,
  fetchedAt: new Date("2026-10-16T07:00:00Z"),
  windowStart: new Date("2026-09-11T07:00:00Z"),
  settlements: [proof],
};

describe("independent native economic recovery oracle", () => {
  it("traces the routed payout and preserves colliding venue matches without changing fill IDs", () => {
    expect(proof).not.toBeNull();
    expect(proof).toMatchObject({
      atomicAmount: "229280000",
      recipient: wallet,
      tokenId: winner.token_id,
    });
    const observations = buildEconomicObservations(source);
    expect(observations).toHaveLength(2);
    expect(observations.every((row) => row.coverage === "complete")).toBe(true);
    const winning = observations.find((row) => row.tokenId === winner.token_id)!;
    expect(winning).toMatchObject({
      lifetimeBuyUsdc: 49.23874,
      lifetimeBuyShares: 229.28,
      redeemUsdc: 229.28,
      lifetimePnlUsdc: 180.04126,
    });
    expect(winning.constituents).toHaveLength(30);
    expect(
      new Set(
        winning.constituents.map(
          (row) => `${row.transaction_hash}:${row.token_id}:${row.side}:${row.timestamp}`,
        ),
      ).size,
    ).toBe(22);
    expect(observations.reduce((sum, row) => sum + row.redeemUsdc, 0)).toBe(229.28);
    expect(observations.reduce((sum, row) => sum + (row.lifetimePnlUsdc ?? 0), 0)).toBeCloseTo(
      178.19326,
      6,
    );
    expect(buildEconomicObservations(source)).toEqual(observations);
  });

  it("withholds completeness for repeated anonymous records, missing fills or an incomplete window", () => {
    for (const bad of [
      { ...source, activity: [...activity, activity.find((row) => row.type === "TRADE")!] },
      {
        ...source,
        activity: activity.filter(
          (_, index) => index !== activity.findIndex((row) => row.type === "TRADE"),
        ),
      },
      { ...source, settlements: [] },
      { ...source, windowStart: new Date("2026-10-16T00:00:00Z") },
    ]) {
      expect(buildEconomicObservations(bad).some((row) => row.coverage === "partial")).toBe(true);
    }
    expect(
      buildEconomicObservations({ ...source, settlements: [] }).every(
        (row) => row.lifetimePnlUsdc === null,
      ),
    ).toBe(true);
  });

  it("rejects wrong-token, wrong-wallet, wrong-condition, unfinalized and reorged payout evidence", () => {
    for (const bad of [
      { ...proofInput, tokenId: "1" },
      { ...proofInput, walletAddress: `0x${"ab".repeat(20)}` },
      { ...proofInput, conditionId: `0x${"ab".repeat(32)}` },
      { ...proofInput, head: receipt.blockNumber + 4n },
      { ...proofInput, canonicalBlockHash: `0x${"00".repeat(32)}` },
      { ...proofInput, expectedAtomic: 229280001n },
    ])
      expect(verifyEconomicSettlement(bad)).toBeNull();
  });
});

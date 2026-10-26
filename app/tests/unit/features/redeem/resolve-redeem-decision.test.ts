// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/redeem/resolve-redeem-decision`
 * Purpose: Unit tests for the collateral-probe DEFER wiring in
 *   `resolveRedeemCandidatesForCondition` (bug.5027). A winning vanilla-CTF
 *   position whose collateral probe hits an RPC read failure must be
 *   downgraded from `redeem` to the transient, never-persisted
 *   `skip:read_failed` so the pipeline defers + retries rather than enqueuing
 *   a redeem with a guessed collateral. A successful probe forwards the
 *   inferred token.
 * Scope: Pure unit test; mocks `publicClient` (decideRedeem multicall + probe
 *   reads) and `dataApiClient.listUserPositions`.
 * Invariants: No network. First multicall = the 4 decideRedeem reads; second
 *   multicall = the probe's 2 getPositionId reads.
 * Side-effects: none
 * Links: work/items/bug.5027
 * @public
 */

import {
  POLYGON_PUSD,
  type PolymarketDataApiClient,
  type PolymarketUserPosition,
} from "@cogni/poly-market-provider/adapters/polymarket";
import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { resolveRedeemCandidatesForCondition } from "@/features/redeem/resolve-redeem-decision";

const CONDITION_ID =
  "0x3333333333333333333333333333333333333333333333333333333333333333" as const;
const FUNDER =
  "0x000000000000000000000000000000000000dEaD" as `0x${string}`;
const POSITION_ID = 42n;
const COLLECTION_ID =
  "0x4444444444444444444444444444444444444444444444444444444444444444" as const;

/** A winning binary CTF position — decideRedeem returns `redeem`. */
function winningPosition(): PolymarketUserPosition {
  return {
    asset: POSITION_ID.toString(),
    conditionId: CONDITION_ID,
    outcomeIndex: 0,
    negativeRisk: false,
  } as unknown as PolymarketUserPosition;
}

/** decideRedeem reads: balance>0, numerator>0, denominator>0, slotCount=2. */
const DECIDE_REDEEM_READS = [
  { status: "success" as const, result: 1_000_000n }, // balanceOf
  { status: "success" as const, result: 1n }, // payoutNumerators
  { status: "success" as const, result: 1n }, // payoutDenominator
  { status: "success" as const, result: 2n }, // getOutcomeSlotCount
];

function makeDataApi(): PolymarketDataApiClient {
  return {
    listUserPositions: vi.fn(() => Promise.resolve([winningPosition()])),
  } as unknown as PolymarketDataApiClient;
}

function resolve(client: PublicClient) {
  return resolveRedeemCandidatesForCondition({
    funderAddress: FUNDER,
    conditionId: CONDITION_ID,
    publicClient: client,
    dataApiClient: makeDataApi(),
  });
}

describe("resolveRedeemCandidatesForCondition — collateral probe failure (bug.5027)", () => {
  it("downgrades redeem → skip:read_failed when getCollectionId throws (defer, don't guess)", async () => {
    const client = {
      // First (and only) multicall = decideRedeem reads. The probe never
      // reaches its multicall because getCollectionId throws first.
      multicall: vi.fn(() => Promise.resolve(DECIDE_REDEEM_READS)),
      readContract: vi.fn(() => Promise.reject(new Error("RPC 429"))),
    } as unknown as PublicClient;

    const [candidate] = await resolve(client);
    expect(candidate?.decision).toEqual({
      kind: "skip",
      reason: "read_failed",
    });
  });

  it("downgrades redeem → skip:read_failed when a probe multicall leg fails", async () => {
    const multicall = vi
      .fn()
      .mockResolvedValueOnce(DECIDE_REDEEM_READS)
      .mockResolvedValueOnce([
        { status: "failure", error: new Error("node timeout") },
        { status: "success", result: 999n },
      ]);
    const client = {
      multicall,
      readContract: vi.fn(() => Promise.resolve(COLLECTION_ID)),
    } as unknown as PublicClient;

    const [candidate] = await resolve(client);
    expect(candidate?.decision).toEqual({
      kind: "skip",
      reason: "read_failed",
    });
  });

  it("keeps redeem + forwards the probed token on a successful probe", async () => {
    const multicall = vi
      .fn()
      .mockResolvedValueOnce(DECIDE_REDEEM_READS)
      .mockResolvedValueOnce([
        { status: "success", result: POSITION_ID }, // pUSD hashes → match
        { status: "success", result: 999n },
      ]);
    const client = {
      multicall,
      readContract: vi.fn(() => Promise.resolve(COLLECTION_ID)),
    } as unknown as PublicClient;

    const [candidate] = await resolve(client);
    expect(candidate?.decision.kind).toBe("redeem");
    expect(candidate?.collateralToken).toBe(POLYGON_PUSD);
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/redeem/infer-collateral-token`
 * Purpose: Unit tests for the collateral-token probe's success and FAILURE
 *   branches (bug.5027). Asserts that an RPC read failure defers
 *   (`ok: false`) instead of guessing USDC.e, and that a genuine no-match
 *   defaults to pUSD (post-V2-cutover reality) — with the worker's
 *   `bleed_detected` invariant as the backstop.
 * Scope: Pure unit test; mocks `publicClient.readContract` + `.multicall`.
 * Invariants: No network. Mirrors the probe's two candidates [pUSD, USDC.e].
 * Side-effects: none
 * Links: work/items/bug.5027, work/items/bug.0428
 * @public
 */

import {
  POLYGON_PUSD,
  POLYGON_USDC_E,
} from "@cogni/poly-market-provider/adapters/polymarket";
import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { inferCollateralTokenForPosition } from "@/features/redeem/infer-collateral-token";

const CONDITION_ID =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const COLLECTION_ID =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as const;
const EXPECTED_POSITION_ID = 42n;

/** A viem multicall result cell: pUSD's getPositionId then USDC.e's. */
type MulticallCell =
  | { status: "success"; result: bigint }
  | { status: "failure"; error: Error };

function makeClient(opts: {
  getCollectionId?: () => Promise<`0x${string}`>;
  multicall?: MulticallCell[];
}): PublicClient {
  return {
    readContract: vi.fn(
      opts.getCollectionId ?? (() => Promise.resolve(COLLECTION_ID))
    ),
    multicall: vi.fn(() =>
      Promise.resolve(
        opts.multicall ?? [
          { status: "success", result: EXPECTED_POSITION_ID },
          { status: "success", result: 999n },
        ]
      )
    ),
  } as unknown as PublicClient;
}

function probe(client: PublicClient) {
  return inferCollateralTokenForPosition({
    publicClient: client,
    conditionId: CONDITION_ID,
    outcomeIndex: 0,
    expectedPositionId: EXPECTED_POSITION_ID,
  });
}

describe("inferCollateralTokenForPosition", () => {
  it("returns pUSD when the pUSD candidate hashes to the positionId", async () => {
    const client = makeClient({
      multicall: [
        { status: "success", result: EXPECTED_POSITION_ID },
        { status: "success", result: 999n },
      ],
    });
    await expect(probe(client)).resolves.toEqual({
      ok: true,
      collateralToken: POLYGON_PUSD,
    });
  });

  it("returns USDC.e when the USDC.e candidate hashes to the positionId", async () => {
    const client = makeClient({
      multicall: [
        { status: "success", result: 999n },
        { status: "success", result: EXPECTED_POSITION_ID },
      ],
    });
    await expect(probe(client)).resolves.toEqual({
      ok: true,
      collateralToken: POLYGON_USDC_E,
    });
  });

  it("DEFERS (ok:false) when getCollectionId throws — no USDC.e guess (bug.5027)", async () => {
    const client = makeClient({
      getCollectionId: () => Promise.reject(new Error("RPC 429")),
    });
    await expect(probe(client)).resolves.toEqual({ ok: false });
  });

  it("DEFERS (ok:false) when a candidate multicall leg fails — can't distinguish flake from no-match (bug.5027)", async () => {
    const client = makeClient({
      multicall: [
        { status: "failure", error: new Error("node timeout") },
        { status: "success", result: 999n },
      ],
    });
    await expect(probe(client)).resolves.toEqual({ ok: false });
  });

  it("defaults to pUSD on a genuine no-match (both reads succeed, neither hashes)", async () => {
    const client = makeClient({
      multicall: [
        { status: "success", result: 111n },
        { status: "success", result: 222n },
      ],
    });
    await expect(probe(client)).resolves.toEqual({
      ok: true,
      collateralToken: POLYGON_PUSD,
    });
  });
});

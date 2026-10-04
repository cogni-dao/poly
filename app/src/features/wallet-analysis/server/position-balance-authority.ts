// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/position-balance-authority`
 * Purpose: Construct the shared Polygon CTF `balanceOfBatch` reader used by
 *   both scheduled and explicit current-position observation.
 * Scope: One read-only Polygon adapter. Writer sequencing, chunk bounds,
 *   deadlines, validation, and publication remain in the observation service.
 * Invariants:
 *   - EXACT_BIGINT_AUTHORITY: balances remain bigint through the publication
 *     decision; no number conversion or dust threshold can prove closure.
 *   - FIVE_SECOND_TRANSPORT_BOUND: the viem HTTP transport is bounded to the
 *     same per-chunk ceiling enforced by the writer.
 * Side-effects: read-only Polygon RPC.
 * Links: work item subtask.5000
 * @public
 */

import { POLYGON_CONDITIONAL_TOKENS } from "@cogni/poly-market-provider/adapters/polymarket";
import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";
import type { PositionBalanceBatchReader } from "./trader-observation-service";

const CTF_BALANCE_OF_BATCH_ABI = parseAbi([
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
]);

export function createPolygonPositionBalanceBatchReader(input: {
  rpcUrl: string;
}): PositionBalanceBatchReader {
  const client = createPublicClient({
    chain: polygon,
    transport: http(input.rpcUrl, { timeout: 5_000 }),
  });

  return async ({ walletAddress, tokenIds, signal }) => {
    signal.throwIfAborted();
    const account = walletAddress as `0x${string}`;
    const balances = await client.readContract({
      address: POLYGON_CONDITIONAL_TOKENS,
      abi: CTF_BALANCE_OF_BATCH_ABI,
      functionName: "balanceOfBatch",
      args: [
        tokenIds.map(() => account),
        tokenIds.map((tokenId) => BigInt(tokenId)),
      ],
    });
    signal.throwIfAborted();
    return balances;
  };
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `features/redeem/infer-collateral-token`
 * Purpose: Pick the right ERC-20 `collateralToken` for `redeemPositions(...)` on a vanilla CTF position by chain-probing both candidates (pUSD, USDC.e) and matching the one whose `(token, collectionId)` hashes to the funder's known on-chain positionId. Mismatch silently zero-burns (bug.0428).
 * Scope: Two CTF view calls. No DB, no writes.
 * Invariants:
 *   - PROBE_FAILURE_DEFERS_NOT_GUESSES — an RPC read failure (getCollectionId
 *     throw, or a candidate's multicall leg failing so we can't distinguish
 *     match from RPC flake) returns `{ ok: false }` so the caller defers the
 *     redeem to a retry rather than enqueuing with a guessed collateral. Post
 *     V2-cutover most winners are pUSD-backed, so the old USDC.e-on-failure
 *     default enqueued a pUSD winner with USDC.e collateral → `redeemPositions`
 *     succeeds with zero burn, wasting gas + delaying payout until the
 *     bleed-detector re-drives it (bug.5027).
 *   - NO_MATCH_DEFAULTS_PUSD — when both candidate reads succeed but neither
 *     hashes to the expected positionId, default to pUSD (post-cutover
 *     reality). The worker's `bleed_detected` backstop still catches a wrong
 *     inference, so this can never silently corrupt.
 * Side-effects: IO (Polygon RPC view calls).
 * Links: docs/spec/poly-tenant-and-collateral.md, work/items/bug.0428.poly-redeem-worker-hardcodes-usdce.md, work/items/bug.5027
 * @public
 */

import {
  PARENT_COLLECTION_ID_ZERO,
  POLYGON_CONDITIONAL_TOKENS,
  POLYGON_PUSD,
  POLYGON_USDC_E,
  polymarketCtfPositionIdAbi,
} from "@cogni/poly-market-provider/adapters/polymarket";
import type { PublicClient } from "viem";

// pUSD first — post-V2-cutover positions are pUSD-backed; USDC.e is the
// legacy fallback for V1 mints.
const CANDIDATES: ReadonlyArray<`0x${string}`> = [POLYGON_PUSD, POLYGON_USDC_E];

/**
 * Result of a collateral-token probe.
 * - `ok: true`  — a concrete `collateralToken` to forward to `redeemPositions`.
 * - `ok: false` — an RPC read failed; the caller MUST NOT guess a collateral.
 *   It should defer (skip:read_failed) so a later ConditionResolution event,
 *   the ~10-min chain-log catchup, or the hourly Layer-3 position-diff
 *   re-probes and enqueues with the correct token.
 */
export type CollateralProbeResult =
  | { ok: true; collateralToken: `0x${string}` }
  | { ok: false };

/**
 * Probe the collateral that minted `expectedPositionId`.
 *
 * Returns `{ ok: true }` with the matching token, `{ ok: true }` with a pUSD
 * default on a genuine no-match (both reads succeeded, neither hashed), or
 * `{ ok: false }` when any read failed so the caller can defer instead of
 * enqueuing a redeem with a guessed collateral (bug.5027). The worker's
 * `bleed_detected` invariant remains the backstop for a wrong inference.
 */
export async function inferCollateralTokenForPosition(deps: {
  publicClient: PublicClient;
  conditionId: `0x${string}`;
  outcomeIndex: number;
  expectedPositionId: bigint;
}): Promise<CollateralProbeResult> {
  const indexSet = 1n << BigInt(deps.outcomeIndex);

  let collectionId: `0x${string}`;
  try {
    collectionId = (await deps.publicClient.readContract({
      address: POLYGON_CONDITIONAL_TOKENS as `0x${string}`,
      abi: polymarketCtfPositionIdAbi,
      functionName: "getCollectionId",
      args: [PARENT_COLLECTION_ID_ZERO, deps.conditionId, indexSet],
    })) as `0x${string}`;
  } catch {
    // RPC read failure — defer, don't guess. bug.5027.
    return { ok: false };
  }

  const positionIds = await deps.publicClient.multicall({
    contracts: CANDIDATES.map((token) => ({
      address: POLYGON_CONDITIONAL_TOKENS as `0x${string}`,
      abi: polymarketCtfPositionIdAbi,
      functionName: "getPositionId" as const,
      args: [token, collectionId] as const,
    })),
    allowFailure: true,
  });

  let anyReadFailed = false;
  for (let i = 0; i < CANDIDATES.length; i++) {
    const read = positionIds[i];
    const token = CANDIDATES[i];
    if (read?.status !== "success" || !token) {
      anyReadFailed = true;
      continue;
    }
    if ((read.result as bigint) === deps.expectedPositionId) {
      return { ok: true, collateralToken: token };
    }
  }

  // No candidate matched. If a leg failed we cannot distinguish "genuine
  // no-match" from "RPC flake hid the real match" — defer rather than guess.
  if (anyReadFailed) return { ok: false };

  // Both reads succeeded and neither hashed to the expected positionId. This
  // is a genuine no-match; default to pUSD (post-V2-cutover reality). The
  // worker's bleed-detector still flags a wrong inference. bug.5027.
  return { ok: true, collateralToken: POLYGON_PUSD };
}

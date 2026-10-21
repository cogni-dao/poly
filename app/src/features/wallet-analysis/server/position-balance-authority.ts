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
 *   - ONE_WIRE_ATTEMPT: the durable observer cadence owns retries. Hidden
 *     transport retries must not multiply a bounded balance batch on outage.
 * Side-effects: read-only Polygon RPC.
 * Links: work item subtask.5000
 * @public
 */

import { POLYGON_CONDITIONAL_TOKENS } from "@cogni/poly-market-provider/adapters/polymarket";
import {
  BaseError,
  HttpRequestError,
  TimeoutError,
  createPublicClient,
  http,
  parseAbi,
} from "viem";
import { polygon } from "viem/chains";
import { PositionBalanceTransportError } from "./position-observation-control";
import type { PositionBalanceBatchReader } from "./trader-observation-service";

const CTF_BALANCE_OF_BATCH_ABI = parseAbi([
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
]);

export function createPolygonPositionBalanceBatchReader(input: {
  rpcUrl: string;
}): PositionBalanceBatchReader {
  return async ({ walletAddress, tokenIds, signal }) => {
    signal.throwIfAborted();
    // The installed viem version prefers fetchOptions.signal to its own
    // timeout signal. Own that combined deadline and await real settlement.
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const timer = setTimeout(
      () =>
        controller.abort(
          new PositionBalanceTransportError(
            "Polygon position transport timed out"
          )
        ),
      5_000
    );
    timer.unref?.();
    const client = createPublicClient({
      chain: polygon,
      transport: http(input.rpcUrl, {
        timeout: 0,
        retryCount: 0,
        fetchOptions: { signal: controller.signal },
      }),
    });
    const account = walletAddress as `0x${string}`;
    try {
      const balances = await client.readContract({
        address: POLYGON_CONDITIONAL_TOKENS,
        abi: CTF_BALANCE_OF_BATCH_ABI,
        functionName: "balanceOfBatch",
        args: [
          tokenIds.map(() => account),
          tokenIds.map((tokenId) => BigInt(tokenId)),
        ],
      });
      controller.signal.throwIfAborted();
      return balances;
    } catch (err) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (
        err instanceof SyntaxError ||
        (err instanceof BaseError &&
          err.walk((cause) => cause instanceof SyntaxError) instanceof
            SyntaxError)
      )
        throw err;
      const retryableTransport = (cause: unknown) =>
        cause instanceof TimeoutError ||
        (cause instanceof HttpRequestError &&
          (cause.status === undefined ||
            cause.status === 408 ||
            cause.status >= 500));
      const transport =
        err instanceof BaseError ? err.walk(retryableTransport) : err;
      if (retryableTransport(transport)) {
        throw new PositionBalanceTransportError(
          "Polygon position transport unavailable"
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}

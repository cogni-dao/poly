// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { readFileSync } from "node:fs";
import type {
  PolymarketActivityV2,
  PolymarketUserPositionV2,
} from "@cogni/poly-market-provider/adapters/polymarket";
import type { TransactionReceipt } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEconomicObservations,
  createEconomicSettlementReader,
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
  chainId: 137,
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

  it("retains all 31 trades and hedge cash when CLOSED omits the losing token", () => {
    const result = buildEconomicObservations({
      ...source,
      positions: [winner],
    });
    expect(result).toHaveLength(2);
    expect(result.flatMap((row) => row.constituents)).toHaveLength(31);
    expect(
      result.reduce((sum, row) => sum + row.lifetimeBuyUsdc, 0),
    ).toBeCloseTo(51.08674, 6);
    expect(
      result.every(
        (row) => row.coverage === "partial" && row.lifetimePnlUsdc === null,
      ),
    ).toBe(true);
    expect(result.find((row) => row.tokenId !== winner.token_id)).toMatchObject(
      { closedPosition: null, lifetimeBuyUsdc: 1.848 },
    );
    const extra = {
      ...activity.find((row) => row.type === "TRADE")!,
      token_id: "987654321",
      id: "unrepresented-token",
    };
    const missing = buildEconomicObservations({
      ...source,
      activity: [...activity, extra],
    });
    expect(missing.flatMap((row) => row.constituents)).toHaveLength(32);
    expect(missing.every((row) => row.coverage === "partial")).toBe(true);
  });

  it("rejects unsupported collateral, unrelated mint, missing conversion and duplicate relevant logs", () => {
    const payoutIndex = receipt.logs.findIndex(
      (log) =>
        log.topics[0] ===
        "0x2682012a4a4f1973119f1c9b90745d1bd91fa2bab387344f044cb3586864d18d",
    );
    const payout = receipt.logs[payoutIndex]!;
    const mintIndex = receipt.logs.findIndex(
      (log) =>
        log.address.toLowerCase() ===
          "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb" &&
        log.topics[0]?.startsWith("0xddf252"),
    );
    const mint = receipt.logs[mintIndex]!;
    const replace = (index: number, log: typeof payout) =>
      receipt.logs.map((old, i) => (i === index ? log : old));
    for (const logs of [
      replace(payoutIndex, {
        ...payout,
        topics: [
          payout.topics[0]!,
          payout.topics[1]!,
          `0x${"ab".repeat(32)}`,
          payout.topics[3]!,
        ],
      }),
      replace(payoutIndex, {
        ...payout,
        topics: [
          payout.topics[0]!,
          payout.topics[1]!,
          payout.topics[2]!,
          `0x${"ab".repeat(32)}`,
        ],
      }),
      replace(mintIndex, {
        ...mint,
        topics: [mint.topics[0]!, `0x${"ab".repeat(32)}`, mint.topics[2]!],
      }),
      receipt.logs.filter((_, i) => i !== payoutIndex + 1),
      [...receipt.logs, payout],
      [...receipt.logs, { ...payout, logIndex: 9999 }],
      receipt.logs.filter((log) => log.logIndex !== 1822), // Wrapped
    ])
      expect(
        verifyEconomicSettlement({
          ...proofInput,
          receipt: { ...receipt, logs },
        }),
      ).toBeNull();
    expect(verifyEconomicSettlement({ ...proofInput, chainId: 1 })).toBeNull();
    // A decoded but unsupported partition must not establish this binary token's payout.
    const badPartition =
      `${payout.data.slice(0, -64)}${"3".padStart(64, "0")}` as `0x${string}`;
    expect(
      verifyEconomicSettlement({
        ...proofInput,
        receipt: {
          ...receipt,
          logs: replace(payoutIndex, { ...payout, data: badPartition }),
        },
      }),
    ).toBeNull();
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

describe("bounded settlement transport", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses three network requests and rejects actual wrong-chain identity", async () => {
    for (const chainId of ["0x89", "0x1"]) {
      const calls: string[][] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init: RequestInit) => {
          const payload = JSON.parse(String(init.body));
          const batch = Array.isArray(payload) ? payload : [payload];
          calls.push(batch.map((rpc: { method: string }) => rpc.method));
          const replies = batch.map((rpc: { id: number; method: string }) => ({
            jsonrpc: "2.0",
            id: rpc.id,
            result:
              rpc.method === "eth_getTransactionReceipt"
                ? fixture.receipt
                : rpc.method === "eth_getBlockByNumber"
                  ? {
                      hash: receipt.blockHash,
                      number: fixture.receipt.blockNumber,
                    }
                  : rpc.method === "eth_chainId"
                    ? chainId
                    : `0x${(receipt.blockNumber + 5n).toString(16)}`,
          }));
          return new Response(
            JSON.stringify(Array.isArray(payload) ? replies : replies[0]),
            { headers: { "content-type": "application/json" } },
          );
        }),
      );
      const reader = createEconomicSettlementReader({
        rpcUrl: "https://rpc.example.invalid",
      });
      const result = await reader({
        walletAddress: wallet,
        conditionId,
        tokenId: winner.token_id,
        txHash: receipt.transactionHash,
        expectedAtomic: 229280000n,
      });
      expect(result !== null).toBe(chainId === "0x89");
      expect(calls).toHaveLength(3);
      expect(calls[2]?.slice().sort()).toEqual([
        "eth_blockNumber",
        "eth_chainId",
      ]);
    }
  });
  it("does not request RPC after caller cancellation", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort(new Error("caller aborted"));
    await expect(
      createEconomicSettlementReader({ rpcUrl: "https://rpc.example.invalid" })(
        {
          walletAddress: wallet,
          conditionId,
          tokenId: winner.token_id,
          txHash: receipt.transactionHash,
          expectedAtomic: 229280000n,
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow("caller aborted");
    expect(fetch).not.toHaveBeenCalled();
  });
});

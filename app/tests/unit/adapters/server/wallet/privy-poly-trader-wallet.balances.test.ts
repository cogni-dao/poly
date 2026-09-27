// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/wallet/privy-poly-trader-wallet.balances`
 * Purpose: Prove the task.5010 balance-read hardening on
 *   `PrivyPolyTraderWalletAdapter.getBalances`: the Polygon PublicClient is
 *   built once per adapter (not per call), its HTTP transport carries a
 *   bounded timeout, and an RPC failure/timeout degrades to null legs plus a
 *   `polygon_rpc:` error (never a throw) — the overview route's
 *   PARTIAL_FAILURE_NEVER_THROWS warning path.
 * Scope: Unit — viem's `createPublicClient`/`http` are mocked; `getAddress`
 *   (a DB read) is stubbed. No Privy, no DB, no network.
 * Invariants:
 *   - SINGLETON_CLIENT: two `getBalances` calls construct one PublicClient
 *   - BOUNDED_TIMEOUT: transport is built with `timeout` (3s) + `retryCount: 1`
 *   - TIMEOUT_DEGRADES: a rejected RPC read yields nulls + `polygon_rpc:` error
 *   - PUSD_LEG_KEPT: a successful read returns BOTH usdcE and pusd legs
 *   - RPC_UNCONFIGURED: no `polygonRpcUrl` → nulls + `polygon_rpc_unconfigured`
 * Side-effects: none
 * Links: src/adapters/server/wallet/privy-poly-trader-wallet.adapter.ts,
 *        src/app/api/v1/poly/wallet/overview/route.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createPublicClientMock, httpMock, fakeClient } = vi.hoisted(() => {
  const fakeClient = {
    readContract: vi.fn(),
    getBalance: vi.fn(),
  };
  return {
    fakeClient,
    createPublicClientMock: vi.fn(() => fakeClient),
    httpMock: vi.fn((url: string, config?: unknown) => ({
      __fakeTransport: true,
      url,
      config,
    })),
  };
});

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: createPublicClientMock,
    http: httpMock,
  };
});

import { PrivyPolyTraderWalletAdapter } from "@/adapters/server/wallet/privy-poly-trader-wallet.adapter";

const WALLET_ADDRESS =
  "0x1111111111111111111111111111111111111111" as `0x${string}`;
const RPC_URL = "https://polygon-rpc.example.test";
const BILLING_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function buildAdapter(polygonRpcUrl?: string): PrivyPolyTraderWalletAdapter {
  const leafLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const logger = {
    ...leafLogger,
    child: vi.fn(() => leafLogger),
  };
  const adapter = new PrivyPolyTraderWalletAdapter({
    privyClient: {} as never,
    privySigningKey: "test-authorization-key",
    serviceDb: {} as never,
    encryptionKey: Buffer.alloc(32),
    encryptionKeyId: "test-key-id",
    clobCredsFactory: async () => {
      throw new Error("unused in balance tests");
    },
    polygonRpcUrl,
    logger: logger as never,
  });
  // getBalances resolves the wallet address via a DB read; stub it so the
  // test exercises only the RPC path.
  vi.spyOn(adapter, "getAddress").mockResolvedValue(WALLET_ADDRESS);
  return adapter;
}

describe("PrivyPolyTraderWalletAdapter balance reads (task.5010)", () => {
  beforeEach(() => {
    createPublicClientMock.mockClear();
    httpMock.mockClear();
    fakeClient.readContract.mockReset();
    fakeClient.getBalance.mockReset();
  });

  it("an RPC timeout degrades to null legs + a polygon_rpc error, never a throw", async () => {
    const adapter = buildAdapter(RPC_URL);
    fakeClient.readContract.mockRejectedValue(
      new Error("HTTP request timed out")
    );
    fakeClient.getBalance.mockRejectedValue(new Error("HTTP request timed out"));

    const balances = await adapter.getBalances(BILLING_ACCOUNT);

    expect(balances).not.toBeNull();
    expect(balances?.address).toBe(WALLET_ADDRESS);
    expect(balances?.usdcE).toBeNull();
    expect(balances?.pusd).toBeNull();
    expect(balances?.pol).toBeNull();
    expect(balances?.errors).toHaveLength(1);
    expect(balances?.errors[0]).toMatch(/^polygon_rpc: /);
  });

  it("builds ONE PublicClient across repeated getBalances calls", async () => {
    const adapter = buildAdapter(RPC_URL);
    fakeClient.readContract.mockResolvedValue(1_500_000n); // 1.50 (6dp)
    fakeClient.getBalance.mockResolvedValue(420_000_000_000_000_000n); // 0.42 POL

    await adapter.getBalances(BILLING_ACCOUNT);
    await adapter.getBalances(BILLING_ACCOUNT);

    expect(createPublicClientMock).toHaveBeenCalledTimes(1);
    expect(httpMock).toHaveBeenCalledTimes(1);
  });

  it("transport is bounded: 3s timeout + single retry on the balance client", async () => {
    const adapter = buildAdapter(RPC_URL);
    fakeClient.readContract.mockResolvedValue(0n);
    fakeClient.getBalance.mockResolvedValue(0n);

    await adapter.getBalances(BILLING_ACCOUNT);

    expect(httpMock).toHaveBeenCalledWith(RPC_URL, {
      timeout: 3_000,
      retryCount: 1,
    });
  });

  it("a successful read keeps BOTH cash legs (USDC.e AND pUSD) plus POL", async () => {
    const adapter = buildAdapter(RPC_URL);
    fakeClient.readContract
      .mockResolvedValueOnce(1_500_000n) // USDC.e balanceOf → 1.5
      .mockResolvedValueOnce(987_650_000n); // pUSD balanceOf → 987.65
    fakeClient.getBalance.mockResolvedValue(420_000_000_000_000_000n); // 0.42

    const balances = await adapter.getBalances(BILLING_ACCOUNT);

    expect(balances?.usdcE).toBe(1.5);
    expect(balances?.pusd).toBe(987.65);
    expect(balances?.pol).toBe(0.42);
    expect(balances?.errors).toHaveLength(0);
  });

  it("no polygonRpcUrl → nulls + polygon_rpc_unconfigured, no client built", async () => {
    const adapter = buildAdapter(undefined);

    const balances = await adapter.getBalances(BILLING_ACCOUNT);

    expect(balances?.usdcE).toBeNull();
    expect(balances?.pusd).toBeNull();
    expect(balances?.pol).toBeNull();
    expect(balances?.errors).toEqual(["polygon_rpc_unconfigured"]);
    expect(createPublicClientMock).not.toHaveBeenCalled();
  });
});

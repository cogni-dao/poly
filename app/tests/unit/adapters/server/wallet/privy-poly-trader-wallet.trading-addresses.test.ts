// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/wallet/privy-poly-trader-wallet.trading-addresses`
 * Purpose: Prove SINGLE_TRADING_ADDRESS_RESOLUTION — `getAddress` and
 *   `listActiveTradingAddresses` resolve a `poly_wallet_connections` row to the
 *   SAME address. Two derivations is what put the observer on the Privy signer
 *   EOA while the executor traded from the V2 funder, blanking the dashboard
 *   for every V2 tenant.
 * Scope: Unit — the service DB is a thenable-chain fake returning fixed
 *   connection rows. No Privy, no RPC, no network.
 * Invariants:
 *   - FUNDER_WINS: `funder_address` set → that is the resolved address.
 *   - PRE_V2_ROW: `funder_address` null → the signer `address`, which for rows
 *     minted before migration 0066 WAS the funder.
 *   - LIST_MATCHES_GET: the list method agrees with `getAddress`, lowercased.
 *   - LIST_IS_DEDUPED: two connections on one funder yield one entry.
 * Side-effects: none
 * Links: src/adapters/server/wallet/privy-poly-trader-wallet.adapter.ts,
 *        src/features/wallet-analysis/server/trader-observation-service.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import { PrivyPolyTraderWalletAdapter } from "@/adapters/server/wallet/privy-poly-trader-wallet.adapter";

const BILLING_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// Checksummed, as the column stores them — resolution must lowercase for the
// list (observed-wallet rows are keyed lowercase) and checksum for getAddress.
const SIGNER = "0xd9Dd919ADE271716b9E2AB5F653E2FA1293e0562";
const FUNDER = "0x8ca45685c5827f7ACFdd890214180C4EA9d0Bf58";

type ConnectionRow = {
  id: string;
  billingAccountId: string;
  address: string;
  funderAddress: string | null;
};

/** Thenable-chain fake db whose every SELECT resolves the given rows. */
function fakeDb(rows: readonly ConnectionRow[]) {
  const makeChain = () => {
    // biome-ignore lint/suspicious/noExplicitAny: duck-typed drizzle chain
    const chain: any = {};
    for (const method of ["from", "where", "limit", "orderBy"]) {
      chain[method] = () => chain;
    }
    // biome-ignore lint/suspicious/noThenProperty: fake drizzle chain must be thenable to emulate awaitable query builders
    chain.then = (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (err: unknown) => unknown
    ) => Promise.resolve(rows).then(onFulfilled, onRejected);
    return chain;
  };
  return { select: () => makeChain() } as never;
}

function buildAdapter(rows: readonly ConnectionRow[]) {
  const leafLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return new PrivyPolyTraderWalletAdapter({
    privyClient: {} as never,
    privySigningKey: "test-authorization-key",
    serviceDb: fakeDb(rows),
    encryptionKey: Buffer.alloc(32),
    encryptionKeyId: "test-key-id",
    clobCredsFactory: async () => {
      throw new Error("unused in address-resolution tests");
    },
    logger: { ...leafLogger, child: vi.fn(() => leafLogger) } as never,
  });
}

const row = (
  id: string,
  address: string,
  funderAddress: string | null
): ConnectionRow => ({
  id,
  billingAccountId: BILLING_ACCOUNT,
  address,
  funderAddress,
});

describe("PrivyPolyTraderWalletAdapter — SINGLE_TRADING_ADDRESS_RESOLUTION", () => {
  it("resolves a V2 connection to the funder, never the signer EOA", async () => {
    const adapter = buildAdapter([row("c1", SIGNER, FUNDER)]);

    const single = await adapter.getAddress(BILLING_ACCOUNT);
    const listed = await adapter.listActiveTradingAddresses();

    expect(single).toBe(FUNDER);
    expect(listed).toEqual([FUNDER.toLowerCase()]);
    expect(listed).not.toContain(SIGNER.toLowerCase());
  });

  it("resolves a pre-V2 connection to its signer address", async () => {
    const adapter = buildAdapter([row("c1", SIGNER, null)]);

    expect(await adapter.getAddress(BILLING_ACCOUNT)).toBe(SIGNER);
    expect(await adapter.listActiveTradingAddresses()).toEqual([
      SIGNER.toLowerCase(),
    ]);
  });

  it("dedupes two connections that resolve to one funder", async () => {
    const adapter = buildAdapter([
      row("c1", SIGNER, FUNDER),
      row("c2", FUNDER, FUNDER),
    ]);

    expect(await adapter.listActiveTradingAddresses()).toEqual([
      FUNDER.toLowerCase(),
    ]);
  });

  it("returns an empty list when no tenant has an active connection", async () => {
    const adapter = buildAdapter([]);

    expect(await adapter.listActiveTradingAddresses()).toEqual([]);
  });
});

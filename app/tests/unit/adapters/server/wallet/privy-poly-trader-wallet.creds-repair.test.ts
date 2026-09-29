// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/wallet/privy-poly-trader-wallet.creds-repair`
 * Purpose: Prove `repairClobCreds` re-derives ONLY unreadable credentials, on
 *          the EXISTING connection, and refuses when the creds still decrypt
 *          (bug.5305).
 * Scope: Real AES-256-GCM round-trips against a fake db that records the
 *        update. Privy `createViemAccount` is mocked — the repair needs a
 *        signer, not a network call.
 * Invariants:
 *   - NEVER_CHURN_WORKING_CREDS: readable creds are left untouched.
 *   - SAME_CONNECTION_SAME_WALLET: repair updates the existing row; it never
 *     mints a new wallet, which would strand the funded one.
 *   - REPAIRED_BLOB_IS_READABLE: the row written back decrypts to the fresh
 *     creds under the current key.
 * Side-effects: none
 * Links: src/adapters/server/wallet/privy-poly-trader-wallet.adapter.ts
 * @public
 */

import { aeadDecrypt, aeadEncrypt } from "@cogni/node-shared/crypto/aead";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createViemAccountMock } = vi.hoisted(() => ({
  createViemAccountMock: vi.fn(() => ({ address: "0xsigner" })),
}));
vi.mock("@privy-io/node/viem", () => ({
  createViemAccount: createViemAccountMock,
}));

import { PrivyPolyTraderWalletAdapter } from "@/adapters/server/wallet/privy-poly-trader-wallet.adapter";

const BILLING_ACCOUNT = "207795de-891c-4791-9f8b-aa0f0bcc4911";
const CONNECTION_ID = "49cfd0b4-1e6f-4832-8fe8-4579e6ae7bb5";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const KEY = Buffer.alloc(32, 7);
const AAD = {
  billing_account_id: BILLING_ACCOUNT,
  connection_id: CONNECTION_ID,
  provider: "polymarket_clob",
} as const;
const FRESH = { key: "fresh-key", secret: "fresh-secret", passphrase: "fresh-pp" };

function harness(ciphertext: Buffer, rowKeyId = "retired-key") {
  const updates: Array<Record<string, unknown>> = [];
  const row = {
    id: CONNECTION_ID,
    billingAccountId: BILLING_ACCOUNT,
    clobApiKeyCiphertext: ciphertext,
    encryptionKeyId: rowKeyId,
    privyWalletId: "privy-wallet-1",
    address: ADDRESS,
    revokedAt: null,
  };
  const selectChain = (() => {
    // biome-ignore lint/suspicious/noExplicitAny: duck-typed drizzle chain
    const c: any = {};
    for (const m of ["from", "where", "limit"]) c[m] = () => c;
    // biome-ignore lint/suspicious/noThenProperty: fake builder must be awaitable
    c.then = (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (err: unknown) => unknown
    ) => Promise.resolve([row]).then(onFulfilled, onRejected);
    return c;
  })();
  const serviceDb = {
    select: () => selectChain,
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: async () => undefined };
      },
    }),
  } as never;

  const leafLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const clobCredsFactory = vi.fn(async () => FRESH);
  const adapter = new PrivyPolyTraderWalletAdapter({
    privyClient: {} as never,
    privySigningKey: "test-authorization-key",
    serviceDb,
    encryptionKey: KEY,
    encryptionKeyId: "current-key",
    clobCredsFactory: clobCredsFactory as never,
    logger: { ...leafLogger, child: vi.fn(() => leafLogger) } as never,
  });
  return { adapter, updates, clobCredsFactory, leafLogger };
}

describe("repairClobCreds re-derives only unreadable creds (bug.5305)", () => {
  beforeEach(() => createViemAccountMock.mockClear());

  it("re-derives on the SAME connection when the blob cannot be decrypted", async () => {
    // The prod fault: encrypted under a key whose bytes no longer authenticate.
    const unreadable = aeadEncrypt(
      JSON.stringify({ key: "old", secret: "old", passphrase: "old" }),
      AAD,
      Buffer.alloc(32, 9)
    );
    const { adapter, updates, clobCredsFactory } = harness(unreadable);

    const result = await adapter.repairClobCreds(BILLING_ACCOUNT);

    expect(result).toEqual({ ok: true, connectionId: CONNECTION_ID });
    // Derived from the signer alone — never from the unreadable old creds.
    expect(clobCredsFactory).toHaveBeenCalledTimes(1);
    // The funded wallet is reused, not replaced.
    expect(createViemAccountMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ walletId: "privy-wallet-1", address: ADDRESS })
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.encryptionKeyId).toBe("current-key");

    // The whole point: the row written back is readable again.
    const written = updates[0]?.clobApiKeyCiphertext as Buffer;
    expect(JSON.parse(aeadDecrypt(written, AAD, KEY))).toEqual(FRESH);
  });

  it("REFUSES when the stored creds still decrypt", async () => {
    // Guard against this becoming a way to churn a live Polymarket API key.
    const readable = aeadEncrypt(
      JSON.stringify({ key: "live", secret: "live", passphrase: "live" }),
      AAD,
      KEY
    );
    const { adapter, updates, clobCredsFactory } = harness(readable);

    const result = await adapter.repairClobCreds(BILLING_ACCOUNT);

    expect(result).toEqual({ ok: false, reason: "creds_already_valid" });
    expect(updates).toHaveLength(0);
    expect(clobCredsFactory).not.toHaveBeenCalled();
    expect(createViemAccountMock).not.toHaveBeenCalled();
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/wallet/privy-poly-trader-wallet.resolve-flood-guard`
 * Purpose: Prove the mirror-flood guard — a connection whose CLOB creds can no
 *          longer be AEAD-decrypted logs at WARN at most once per connection per
 *          process, instead of an ERROR every mirror poll; transient
 *          (`backend_unreachable`) faults are NOT throttled.
 * Scope: Real AES-256-GCM ciphertext (wrong key → permanent aead_decrypt
 *        fault) and a rejecting fake db (transient fault) through the production
 *        `resolve` path. No network, no Privy, no viem.
 * Invariants:
 *   - PERMANENT_FAULT_WARNS_ONCE: repeated resolves of the same un-decryptable
 *     connection emit a single WARN resolve_error, never ERROR.
 *   - TRANSIENT_FAULT_NOT_THROTTLED: a DB-unreachable resolve logs ERROR on
 *     every call (no suppression).
 * Side-effects: none
 * Links: src/adapters/server/wallet/privy-poly-trader-wallet.adapter.ts
 * @public
 */

import { aeadEncrypt } from "@cogni/node-shared/crypto/aead";
import { describe, expect, it, vi } from "vitest";
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

const RESOLVE_ERROR_EVENT = "adapter.poly_wallet.resolve_error";

/** Thenable-chain fake db that resolves one connection row (or rejects). */
function fakeDb(behavior: { reject: boolean; ciphertext?: Buffer }) {
  const row = {
    id: CONNECTION_ID,
    billingAccountId: BILLING_ACCOUNT,
    clobApiKeyCiphertext: behavior.ciphertext ?? Buffer.alloc(0),
    encryptionKeyId: "test-key-id",
    privyWalletId: "privy-wallet-1",
    address: ADDRESS,
    revokedAt: null,
  };
  // biome-ignore lint/suspicious/noExplicitAny: duck-typed drizzle chain
  const chain: any = {};
  for (const method of ["from", "where", "limit", "orderBy"]) {
    chain[method] = () => chain;
  }
  // biome-ignore lint/suspicious/noThenProperty: fake drizzle builder must be awaitable
  chain.then = (
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (err: unknown) => unknown
  ) =>
    behavior.reject
      ? Promise.reject(new Error("db down")).then(onFulfilled, onRejected)
      : Promise.resolve([row]).then(onFulfilled, onRejected);
  return { select: () => chain } as never;
}

function buildAdapter(serviceDb: never) {
  const leafLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const logger = { ...leafLogger, child: vi.fn(() => leafLogger) };
  const adapter = new PrivyPolyTraderWalletAdapter({
    privyClient: {} as never,
    privySigningKey: "test-authorization-key",
    serviceDb,
    encryptionKey: KEY,
    encryptionKeyId: "test-key-id",
    clobCredsFactory: async () => {
      throw new Error("unused — resolve fails before creds are minted");
    },
    logger: logger as never,
  });
  return { adapter, leafLogger };
}

function resolveErrorCalls(
  sink: ReturnType<typeof vi.fn>
): Array<Record<string, unknown>> {
  return sink.mock.calls
    .filter(
      (call) => (call[0] as { event?: string }).event === RESOLVE_ERROR_EVENT
    )
    .map((call) => call[0] as Record<string, unknown>);
}

describe("resolve mirror-flood guard", () => {
  it("logs an un-decryptable connection ONCE at WARN across repeated polls", async () => {
    // Prod shape: the mirror re-resolves tenant 207795de every ~minute and the
    // stored creds were encrypted under a key whose bytes no longer
    // authenticate — a permanent fault until repair/reset.
    const wrongKeyCiphertext = aeadEncrypt(
      JSON.stringify({ key: "k", secret: "s", passphrase: "p" }),
      AAD,
      Buffer.alloc(32, 9)
    );
    const { adapter, leafLogger } = buildAdapter(
      fakeDb({ reject: false, ciphertext: wrongKeyCiphertext })
    );

    // Three consecutive mirror polls on the same process.
    await expect(adapter.resolve(BILLING_ACCOUNT)).resolves.toBeNull();
    await expect(adapter.resolve(BILLING_ACCOUNT)).resolves.toBeNull();
    await expect(adapter.resolve(BILLING_ACCOUNT)).resolves.toBeNull();

    // The flood is gone: one WARN, zero ERROR, for the whole burst.
    const warnCalls = resolveErrorCalls(leafLogger.warn);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatchObject({
      reasonCode: "clob_creds_invalid",
      connection_id: CONNECTION_ID,
      billing_account_id: BILLING_ACCOUNT,
      throttled: true,
    });
    expect(String(warnCalls[0]?.detail)).toMatch(/^aead_decrypt: /);
    expect(resolveErrorCalls(leafLogger.error)).toHaveLength(0);
  });

  it("does NOT throttle a transient backend_unreachable fault", async () => {
    // A DB blip is retryable — every occurrence must stay visible at ERROR.
    const { adapter, leafLogger } = buildAdapter(fakeDb({ reject: true }));

    await expect(adapter.resolve(BILLING_ACCOUNT)).resolves.toBeNull();
    await expect(adapter.resolve(BILLING_ACCOUNT)).resolves.toBeNull();

    const errorCalls = resolveErrorCalls(leafLogger.error);
    expect(errorCalls).toHaveLength(2);
    expect(errorCalls[0]).toMatchObject({ reasonCode: "backend_unreachable" });
    expect(resolveErrorCalls(leafLogger.warn)).toHaveLength(0);
  });
});

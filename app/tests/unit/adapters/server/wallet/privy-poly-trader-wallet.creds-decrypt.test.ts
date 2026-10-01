// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/wallet/privy-poly-trader-wallet.creds-decrypt`
 * Purpose: Prove `clob_creds_invalid` names WHICH decryption step failed
 *          (bug.5304), and that no credential plaintext reaches the log.
 * Scope: Builds real AES-256-GCM ciphertexts so each of the three failure
 *        stages is reached through the production code path, with a thenable
 *        fake db. No network, no Privy, no viem (resolve returns before them).
 * Invariants:
 *   - DECRYPT_STAGE_IS_LOGGED: the resolve_error line carries `detail` naming
 *     the failing stage, because the remedy differs per stage.
 *   - NEVER_LOG_PLAINTEXT: a non-JSON plaintext logs the stage only — the
 *     `JSON.parse` message quotes decrypted credential bytes.
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

/** Thenable-chain fake db resolving one un-revoked connection row. */
function fakeDb(clobApiKeyCiphertext: Buffer, rowKeyId = "test-key-id") {
  const row = {
    id: CONNECTION_ID,
    billingAccountId: BILLING_ACCOUNT,
    clobApiKeyCiphertext,
    encryptionKeyId: rowKeyId,
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
  ) => Promise.resolve([row]).then(onFulfilled, onRejected);
  return { select: () => chain } as never;
}

function buildAdapter(ciphertext: Buffer, rowKeyId?: string) {
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
    serviceDb: fakeDb(ciphertext, rowKeyId),
    encryptionKey: KEY,
    encryptionKeyId: "test-key-id",
    clobCredsFactory: async () => {
      throw new Error("unused — resolve fails before creds are minted");
    },
    logger: logger as never,
  });
  return { adapter, leafLogger };
}

// `clob_creds_invalid` is a permanent, operator-fixable fault; the adapter
// logs it at WARN (throttled once per connection per process) rather than ERROR
// every mirror poll, so the stage-naming assertions read the warn sink.
function resolveErrorCall(leafLogger: { warn: ReturnType<typeof vi.fn> }) {
  const calls = leafLogger.warn.mock.calls.filter(
    (call) =>
      (call[0] as { event?: string }).event ===
      "adapter.poly_wallet.resolve_error"
  );
  expect(calls).toHaveLength(1);
  return calls[0]?.[0] as Record<string, unknown>;
}

describe("clob_creds_invalid names the failing decrypt stage (bug.5304)", () => {
  it("reports aead_decrypt when the ciphertext cannot be authenticated", async () => {
    // Prod signature: `reasonCode: clob_creds_invalid` every 60s with no way to
    // tell a rotated key from a malformed row. This is the wrong-key/tampered
    // case — remedy is key restore or re-encrypt, NOT re-provisioning.
    const wrongKeyCiphertext = aeadEncrypt(
      JSON.stringify({ key: "k", secret: "s", passphrase: "p" }),
      AAD,
      Buffer.alloc(32, 9)
    );
    const { adapter, leafLogger } = buildAdapter(wrongKeyCiphertext);

    await expect(adapter.resolve(BILLING_ACCOUNT)).resolves.toBeNull();

    const line = resolveErrorCall(leafLogger);
    expect(line).toMatchObject({
      reasonCode: "clob_creds_invalid",
      connection_id: CONNECTION_ID,
      billing_account_id: BILLING_ACCOUNT,
    });
    expect(String(line.detail)).toMatch(/^aead_decrypt: /);
    // Same key id, so the operator learns the key is NOT the variable here.
    expect(String(line.detail)).toContain("[key_id=current]");
  });

  it("names a stale key id, which decides rotation vs re-provision", async () => {
    // The whole point: an AEAD failure on a row encrypted under a RETIRED key
    // is a restore/rotate problem. Without the key id it is indistinguishable
    // from a corrupt row, whose remedy would destroy recoverable credentials.
    const { adapter, leafLogger } = buildAdapter(
      aeadEncrypt(
        JSON.stringify({ key: "k", secret: "s", passphrase: "p" }),
        AAD,
        Buffer.alloc(32, 9)
      ),
      "retired-key-2025"
    );

    await expect(adapter.resolve(BILLING_ACCOUNT)).resolves.toBeNull();

    const line = resolveErrorCall(leafLogger);
    expect(String(line.detail)).toContain(
      "[key_id=stale(row=retired-key-2025,current=test-key-id)]"
    );
  });

  it("reports json_parse WITHOUT echoing the decrypted plaintext", async () => {
    // The key is right and the AAD matches, so this row needs re-provisioning,
    // not a key rotation — the opposite remedy from the case above.
    const secretish = "sk_live_super_secret_value_do_not_log";
    const { adapter, leafLogger } = buildAdapter(
      aeadEncrypt(secretish, AAD, KEY)
    );

    await expect(adapter.resolve(BILLING_ACCOUNT)).resolves.toBeNull();

    const line = resolveErrorCall(leafLogger);
    expect(line).toMatchObject({ reasonCode: "clob_creds_invalid" });
    expect(line.detail).toBe("json_parse: plaintext is not JSON");
    // The guarantee that matters: `JSON.parse` quotes its input, so a naive
    // `err.message` would publish decrypted credential bytes to the log.
    expect(JSON.stringify(line)).not.toContain(secretish);
  });

  it("reports which required fields are absent, by name only", async () => {
    const { adapter, leafLogger } = buildAdapter(
      aeadEncrypt(
        JSON.stringify({ key: "present-key", secret: "" }),
        AAD,
        KEY
      )
    );

    await expect(adapter.resolve(BILLING_ACCOUNT)).resolves.toBeNull();

    const line = resolveErrorCall(leafLogger);
    expect(line.detail).toBe("missing_fields: absent: secret,passphrase");
    // Field names are safe; values never are.
    expect(JSON.stringify(line)).not.toContain("present-key");
  });
});

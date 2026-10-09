// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/paper-accounts/paper-account-address`
 * Purpose: Derive the synthetic address a paper trading account trades under.
 *   A paper account has no key material and no on-chain presence, but
 *   `poly_wallet_connections.address` is NOT NULL and CHECK-constrained to the
 *   0x-40-hex shape, so paper must supply something address-shaped.
 * Scope: Pure function. No I/O, no DB, no crypto beyond a hash.
 * Invariants:
 *   - DETERMINISTIC_PER_TENANT: the same billing account always derives the
 *     same address. Re-creating a paper account after a revoke therefore
 *     reuses it, which keeps any address-keyed history coherent across the
 *     revoke. The partial unique index is on un-revoked rows only, so the
 *     revoked row does not block the re-insert.
 *   - SHAPE_SATISFIES_THE_EXISTING_CHECK: lowercase `0x` + exactly 40 hex
 *     chars, so `poly_wallet_connections_address_shape` and the
 *     `(chain_id, address)` unique index accept it with no DDL carve-out.
 *   - NOT_A_KEYPAIR: this is the low 20 bytes of a SHA-256 digest, not a
 *     secp256k1 public-key hash. No private key exists for it and none can be
 *     found. Nothing may ever try to sign for, fund, or observe this address.
 *   - NO_TYPE_INFO_IN_THE_ADDRESS: deliberately NOT given a recognizable
 *     prefix. `kind` is the discriminator (KIND_IS_THE_DISCRIMINATOR); encoding
 *     paper-ness in the address too would invite readers to sniff the string
 *     instead of reading the column, and would be the first thing to rot.
 * Side-effects: none
 * Links: docs/spec/poly-tenant-and-collateral.md, migration 0082
 * @public
 */

import { createHash } from "node:crypto";

/**
 * Domain-separation tag. Versioned so a future derivation change is an
 * explicit `v2` rather than a silent reassignment of every tenant's address.
 */
const PAPER_ADDRESS_NAMESPACE = "cogni:poly:paper-account:v1";

/**
 * The deterministic synthetic address for one tenant's paper account.
 *
 * @param billingAccountId - The tenant the paper account belongs to.
 * @returns Lowercase `0x`-prefixed 40-hex-character address.
 * @public
 */
export function derivePaperAccountAddress(
  billingAccountId: string
): `0x${string}` {
  if (!billingAccountId) {
    throw new Error(
      "derivePaperAccountAddress requires a non-empty billingAccountId"
    );
  }
  const digest = createHash("sha256")
    .update(`${PAPER_ADDRESS_NAMESPACE}:${billingAccountId}`, "utf8")
    .digest();
  // 20 bytes -> 40 lowercase hex chars, matching EVM address width so the
  // existing shape CHECK and every `lower(address)` join keep working.
  return `0x${digest.subarray(0, 20).toString("hex")}` as `0x${string}`;
}

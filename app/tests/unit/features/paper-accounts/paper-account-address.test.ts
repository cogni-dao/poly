// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/paper-accounts/paper-account-address`
 * Purpose: Pin the synthetic address a paper trading account trades under.
 * Scope: Pure function. No DB, no I/O.
 * Invariants:
 *   - SHAPE_SATISFIES_THE_EXISTING_CHECK — the value is written to
 *     `poly_wallet_connections.address`, which is NOT NULL and CHECK-constrained
 *     to `^0x[a-fA-F0-9]{40}$`, and is joined elsewhere via `lower(address)`.
 *     A wrong width or an uppercase digit is a write failure or a silent join
 *     miss, so the shape is asserted rather than assumed.
 *   - DETERMINISTIC_PER_TENANT — re-creating a paper account after a revoke must
 *     land on the same address, otherwise address-keyed history splits across
 *     the revoke.
 *   - DISTINCT_PER_TENANT — two tenants must never collide, or one tenant's
 *     paper account would trip the other's (chain_id, address) unique index.
 * Side-effects: none
 * Links: migration 0082, app/src/features/paper-accounts/paper-account-address.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import { derivePaperAccountAddress } from "@/features/paper-accounts";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

describe("derivePaperAccountAddress", () => {
  it("produces a lowercase 0x-prefixed 40-hex address", () => {
    const addr = derivePaperAccountAddress(TENANT_A);
    expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
    // Also satisfies the DB CHECK's broader character class.
    expect(addr).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(addr).toBe(addr.toLowerCase());
  });

  it("is deterministic for one tenant", () => {
    expect(derivePaperAccountAddress(TENANT_A)).toBe(
      derivePaperAccountAddress(TENANT_A)
    );
  });

  it("is distinct across tenants", () => {
    expect(derivePaperAccountAddress(TENANT_A)).not.toBe(
      derivePaperAccountAddress(TENANT_B)
    );
  });

  it("is pinned, so a derivation change is a deliberate v2", () => {
    // Guards against an accidental namespace/hash edit silently reassigning
    // every existing tenant's paper address. If this fails on purpose, bump
    // PAPER_ADDRESS_NAMESPACE to v2 rather than editing the expectation.
    expect(derivePaperAccountAddress(TENANT_A)).toBe(
      "0xf4b486b029baa003720e81b5d5e165c1d18fcee3"
    );
  });

  it("refuses an empty tenant id rather than hashing the namespace alone", () => {
    expect(() => derivePaperAccountAddress("")).toThrow(
      /non-empty billingAccountId/
    );
  });
});

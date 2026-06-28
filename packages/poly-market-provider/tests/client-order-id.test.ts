// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/tests/client-order-id`
 * Purpose: Determinism + pin-by-example + multi-tenant non-collision tests for `clientOrderIdFor`.
 * Scope: Pure function tests. Does not hit any SDK or network.
 * Invariants:
 *   - HASH_IS_PINNED — the golden vector below MUST NOT change without a DB backfill.
 *   - MULTI_TENANT_NON_COLLISION — N tenants mirroring the SAME (target_wallet, fill_id)
 *     produce N DIFFERENT client_order_ids. Asserts the property the legacy
 *     2-arg form silently violated (regression-guard for multi-tenant correctness fix).
 * Side-effects: none
 * Links: work/items/task.0315.poly-copy-trade-prototype.md (Phase 1 CP3.3),
 *   work/projects/proj.poly-paper-trading.md (multi-tenant fills PK + clientOrderId fix)
 * @internal
 */

import { keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";

import { clientOrderIdFor } from "../src/domain/client-order-id.js";

/**
 * Inline reproduction of the pre-fix `clientOrderIdFor` implementation —
 * 2-arg `(targetId, fillId)` shape, hashing only the (target, fill) pair.
 * Captured here as a fixture so the regression suite can show, side-by-side,
 * the property the legacy form silently violated. NOT exported.
 */
function legacyClientOrderId(targetId: string, fillId: string): `0x${string}` {
  return keccak256(stringToHex(`${targetId}:${fillId}`));
}

// Reused fixtures — kept verbatim across blocks so a reader can see exactly
// what changes from case to case.
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const TARGET_SWISSTONY = "473e0467-8257-583e-ac93-dea278662cb2"; // uuidv5(swisstony_wallet)
const FILL_1 = "data-api:0xabc:0x7e:BUY:1713302400";
const FILL_2 = "data-api:0xdef:0x7e:BUY:1713302500";

describe("clientOrderIdFor — core invariants", () => {
  it("is deterministic — same inputs → same output", () => {
    const a = clientOrderIdFor(TENANT_A, TARGET_SWISSTONY, FILL_1);
    const b = clientOrderIdFor(TENANT_A, TARGET_SWISSTONY, FILL_1);
    expect(a).toBe(b);
  });

  it("returns a 0x-prefixed 32-byte hex (66 chars total)", () => {
    const id = clientOrderIdFor(TENANT_A, "t", "f");
    expect(id).toMatch(/^0x[a-f0-9]{64}$/);
    expect(id.length).toBe(66);
  });

  it("distinguishes different (target, fill) combinations within a tenant", () => {
    const a = clientOrderIdFor(TENANT_A, "target-1", "fill-1");
    const b = clientOrderIdFor(TENANT_A, "target-2", "fill-1");
    const c = clientOrderIdFor(TENANT_A, "target-1", "fill-2");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it("rejects empty billingAccountId, targetId, or fillId", () => {
    expect(() => clientOrderIdFor("", "t", "f")).toThrow(/billingAccountId/);
    expect(() => clientOrderIdFor("b", "", "f")).toThrow(/targetId/);
    expect(() => clientOrderIdFor("b", "t", "")).toThrow(/fillId/);
  });
});

describe("clientOrderIdFor — MULTI_TENANT_NON_COLLISION (regression guard)", () => {
  // Background: before the multi-tenant fills PK fix, `clientOrderIdFor` took
  // only (target_id, fill_id). Because `target_id = uuidv5(target_wallet)` is
  // deterministic and shared across tenants, two tenants mirroring the same
  // target's same fill produced the SAME client_order_id — colliding at the
  // CLOB's idempotency layer. At the DB level the `ON CONFLICT (target_id,
  // fill_id) DO NOTHING` clause silently dropped the second tenant's row,
  // breaking per-tenant copy-trade observability. The fix adds
  // `billing_account_id` as the first input + `(billing_account_id, target_id,
  // fill_id)` PK on `poly_copy_trade_fills`. These tests assert the property
  // the legacy form lacked.

  it("LEGACY-BROKEN: two tenants computed the SAME client_order_id for the same (target_wallet, fill_id)", () => {
    // Reproduces the pre-fix behavior via `legacyClientOrderId(target, fill)`.
    // Both tenants A and B, mirroring swisstony's same fill, would collide.
    // The CLOB would treat the second tenant's order as a duplicate; on the
    // DB side, `ON CONFLICT (target_id, fill_id) DO NOTHING` silently dropped
    // the second tenant's row → broken per-tenant copy-trade observability.
    const legacyA = legacyClientOrderId(TARGET_SWISSTONY, FILL_1);
    const legacyB = legacyClientOrderId(TARGET_SWISSTONY, FILL_1);
    expect(legacyA).toBe(legacyB);
    // Pin the exact legacy value so any future ambiguity is caught.
    expect(legacyA).toMatchInlineSnapshot(
      `"0xca8afc98fc35789887262bf0cea92244ab6de0b35fb0b8fd716b8c0e8ef42ea6"`
    );
  });

  it("FIXED: tenant A and tenant B mirroring the same (target, fill) get DIFFERENT keys", () => {
    const keyA = clientOrderIdFor(TENANT_A, TARGET_SWISSTONY, FILL_1);
    const keyB = clientOrderIdFor(TENANT_B, TARGET_SWISSTONY, FILL_1);
    expect(keyA).not.toBe(keyB);
  });

  it("FIXED: same tenant mirroring the same (target, fill) twice gets the SAME key (intra-tenant idempotency preserved)", () => {
    const k1 = clientOrderIdFor(TENANT_A, TARGET_SWISSTONY, FILL_1);
    const k2 = clientOrderIdFor(TENANT_A, TARGET_SWISSTONY, FILL_1);
    expect(k1).toBe(k2);
  });

  it("FIXED: many tenants on same (target, fill) all produce pairwise-distinct keys", () => {
    const tenants = Array.from(
      { length: 8 },
      (_, i) => `00000000-0000-0000-0000-00000000000${i}`
    );
    const keys = tenants.map((t) =>
      clientOrderIdFor(t, TARGET_SWISSTONY, FILL_1)
    );
    expect(new Set(keys).size).toBe(tenants.length);
  });

  it("FIXED: each tenant independently distinguishes their own fills", () => {
    const a1 = clientOrderIdFor(TENANT_A, TARGET_SWISSTONY, FILL_1);
    const a2 = clientOrderIdFor(TENANT_A, TARGET_SWISSTONY, FILL_2);
    const b1 = clientOrderIdFor(TENANT_B, TARGET_SWISSTONY, FILL_1);
    expect(a1).not.toBe(a2);
    expect(a1).not.toBe(b1);
    expect(a2).not.toBe(b1);
  });
});

describe("clientOrderIdFor — golden vector (HASH_IS_PINNED)", () => {
  it("pins the new 3-arg shape (billing + target + fill)", () => {
    // Regenerate this vector ONLY if changing the hash function (requires a
    // DB backfill migration). Sourced once by running the fn and pasting.
    const id = clientOrderIdFor(
      TENANT_A,
      TARGET_SWISSTONY,
      "data-api:0xabc…def:0x7e…9a:BUY:1713302400"
    );
    expect(id).toMatchInlineSnapshot(`"0xf727a3ae60ce320ad55405ee51c3e3c0b51f099dee20ece239deadb0c020fed3"`);
  });
});

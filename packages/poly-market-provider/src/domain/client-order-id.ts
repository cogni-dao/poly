// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/domain/client-order-id`
 * Purpose: Pinned idempotency-key function for the copy-trade `client_order_id` field.
 * Scope: Pure function. Does not perform I/O, does not import any SDK, does not know about CLOB internals.
 * Invariants:
 *   - IDEMPOTENT_BY_CLIENT_ID: the function is deterministic from
 *     `(billing_account_id, target_id, fill_id)`. The triple matches the
 *     composite PK on `poly_copy_trade_fills` after the multi-tenant fix —
 *     N tenants mirroring the same wallet's same fill produce N distinct
 *     client_order_ids and N independent CLOB-side placements.
 *   - HASH_IS_PINNED: task.0315 CP3.3 migration header cites this exact function — the
 *     executor (CP4) AND any future WS path MUST use this helper, never a local copy.
 * Side-effects: none
 * Links: work/items/task.0315.poly-copy-trade-prototype.md (Phase 1 CP3.3)
 * @public
 */

import { keccak256, stringToHex } from "viem";

/**
 * Deterministic idempotency key =
 *   `keccak256(utf8Bytes(billing_account_id + ':' + target_id + ':' + fill_id))`
 * as a 0x-prefixed 32-byte hex (66 chars including `0x`).
 *
 * Pinned function — never inline or fork the implementation. If the shape needs
 * to change (e.g., different separator, prefix), update this file + write a
 * migration that backfills existing rows; do NOT rev it in a caller.
 */
export function clientOrderIdFor(
  billingAccountId: string,
  targetId: string,
  fillId: string
): `0x${string}` {
  if (!billingAccountId)
    throw new Error("clientOrderIdFor: billingAccountId required");
  if (!targetId) throw new Error("clientOrderIdFor: targetId required");
  if (!fillId) throw new Error("clientOrderIdFor: fillId required");
  return keccak256(stringToHex(`${billingAccountId}:${targetId}:${fillId}`));
}

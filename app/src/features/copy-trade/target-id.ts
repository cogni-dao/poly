// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/copy-trade/target-id`
 * Purpose: Deterministic UUIDv5 derivation from a target wallet address. The
 *          poly_copy_trade_fills `target_id` column uses this helper so
 *          `client_order_id = clientOrderIdFor(target_id, fill_id)` stays
 *          stable across pod restarts and across multiple tenants tracking
 *          the same wallet.
 * Scope: Pure helper. No I/O, no env reads.
 * Invariants: TARGET_ID_DETERMINISTIC — same wallet, same uuid (case-insensitive
 *             on the input). Namespace UUID is fixed; never change it.
 * Side-effects: none
 * Links: docs/spec/poly-copy-trade-execution.md (IDEMPOTENT_BY_CLIENT_ID), docs/spec/poly-tenant-and-collateral.md
 * @public
 */

export { targetIdFromWallet } from "@/shared/util/poly-target-id";

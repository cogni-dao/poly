// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/financial-ledger`
 * Purpose: Double-entry financial ledger — port interface, domain constants, and conversion utilities.
 * Scope: Re-exports only. Adapter (TigerBeetle) available via subpath `@cogni/financial-ledger/adapters`. Does not contain implementations or load N-API addons.
 * Invariants:
 *   - This barrel does NOT export adapters (N-API isolation)
 *   - All public types and constants exported here
 * Side-effects: none
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/financial-ledger.md, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/packages-architecture.md
 * @public
 */

export * from "./domain/index.js";
export * from "./port/financial-ledger.port.js";

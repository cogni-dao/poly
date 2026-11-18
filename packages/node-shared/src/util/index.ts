// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-shared/util`
 * Purpose: Pure utility functions (UUID validation).
 * Scope: cn() stays app-local (UI dep). accountId uses node:crypto, not re-exported here.
 * Invariants: PURE_LIBRARY — no UI deps, no framework deps.
 * Side-effects: none
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/packages-architecture.md
 * @public
 */

export { isValidUuid } from "./uuid";

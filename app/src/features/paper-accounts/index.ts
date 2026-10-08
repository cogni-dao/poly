// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/paper-accounts`
 * Purpose: Canonical entry point for the paper-trading-account feature slice.
 * Scope: Re-exports only. Defines no behavior.
 * Invariants: Callers import from here, not from internal paths.
 * Side-effects: none
 * Links: docs/spec/capability-plane.md, migration 0082
 * @public
 */

export { derivePaperAccountAddress } from "./paper-account-address";
export {
  PAPER_CONNECTION_KIND,
  provisionPaperAccount,
  type ProvisionPaperAccountInput,
  type ProvisionPaperAccountResult,
} from "./server/provision-paper-account";

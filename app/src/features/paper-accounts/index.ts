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
  createExecutionVenueResolver,
  type ExecutionVenue,
  type ExecutionVenueResolver,
  ExecutionVenueUnresolvedError,
  type ExecutionVenueUnresolvedReason,
  LIVE_CONNECTION_KIND,
} from "./server/execution-venue";
export {
  createPaperVenue,
  evaluatePaperCapWindows,
  evaluatePaperGrantPreconditions,
  type PaperAccountIdentity,
  PaperAccountUnavailableError,
  type PaperAuthorizeResult,
  type PaperGrantFacts,
  type PaperVenuePort,
} from "./server/paper-venue";
export {
  PAPER_CONNECTION_KIND,
  provisionPaperAccount,
  type ProvisionPaperAccountInput,
  type ProvisionPaperAccountResult,
} from "./server/provision-paper-account";

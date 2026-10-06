// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/capability-plane`
 * Purpose: Public surface of the account-read capability plane — the executor,
 *   its types, the app-local handler bindings, and the discovery projection.
 *   Sibling tasks adding capabilities code against this barrel.
 * Scope: Re-exports only.
 * Invariants: the executor is the only account-read entry point; nothing here
 *   exposes a service-role handle or an authorization decision cache.
 * Side-effects: none
 * Links: story.5006, task.1791070961
 * @public
 */

export {
  accountReadDiscoveryActions,
  type AccountReadDiscoveryAction,
  accountReadDiscoveryEndpoints,
} from "./discovery";
export {
  ACCOUNT_READ_ERROR_CODES,
  ACCOUNT_READ_HTTP_STATUS,
  type AccountReadCache,
  type AccountReadHandler,
  type AccountReadOutcome,
  type AccountReadStatus,
  executeAccountRead,
  type ExecuteAccountReadArgs,
} from "./execute-account-read";
export {
  classifyRecentAttemptsError,
  copySetupAccountReadHandler,
  copySetupExtra,
  copyTradeOrdersAccountReadHandler,
  copyTradeOrdersExtra,
  recentAttemptsAccountReadHandler,
  recentAttemptsExtra,
} from "./copy-operations-handlers";
export {
  PORTFOLIO_SNAPSHOT_TERMINAL_EVENT,
  portfolioSnapshotAccountReadHandler,
  portfolioSnapshotExtra,
  type PortfolioSnapshotBinding,
  type WalletDashboardReadDiagnostics,
} from "./portfolio-snapshot";
export {
  ACCOUNT_READ_TERMINAL_EVENTS,
  classifyInvestigationEvidenceError,
  copyTradeInvestigationAccountReadHandler,
  copyTradeInvestigationEvidenceAccountReadHandler,
  copyTradeInvestigationEvidenceExtra,
  copyTradeInvestigationExtra,
  copyTradePnlAccountReadHandler,
  copyTradePnlExtra,
} from "./handlers";

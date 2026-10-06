// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/agent-tools`
 * Purpose: Public surface of the INTERNAL-AGENT transport for the capability
 *   plane — LangGraph tool contracts plus the thin functions that invoke an
 *   account-read capability on behalf of the signed-in user's principal.
 * Scope: Re-exports only. The per-request wiring that closes a principal over
 *   these transports lives in `@bootstrap/ai/principal-tool-source`, because
 *   features must not reach into `@/bootstrap` for a database handle.
 * Invariants: nothing exported here holds a principal, a database handle, or a
 *   service-role connection. Each transport takes them as arguments.
 * Side-effects: none
 * Links: task.1791070967, story.5006, docs/spec/capability-plane.md
 * @public
 */

export {
  POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
  polyAccountCopyTradeOrdersBoundTool,
  polyAccountCopyTradeOrdersToolContract,
  type PolyAccountCopyTradeOrdersToolDeps,
  type PolyAccountCopyTradeOrdersToolInput,
  PolyAccountCopyTradeOrdersToolInputSchema,
  type PolyAccountCopyTradeOrdersToolOutput,
  PolyAccountCopyTradeOrdersToolOutputSchema,
  type PolyAccountCopyTradeOrdersToolRedacted,
  PolyAccountReadUnavailableReasonSchema,
  runPolyAccountCopyTradeOrdersTool,
} from "./copy-trade-orders-tool";

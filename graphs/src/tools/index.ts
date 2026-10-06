// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-graphs/tools`
 * Purpose: Tool CONTRACTS this node's graphs may call. Contracts only —
 *   schemas, descriptions, redaction, and throwing stubs. Implementations are
 *   injected at bootstrap.
 * Scope: Re-exports only. Nothing here does IO, reads env, or imports `src/**`.
 * Invariants: contracts are expressed in zod **v3**, matching
 *   `@cogni/ai-tools`. `app` and `@cogni/poly-node-contracts` are on v4, and a
 *   v4 schema compiles to an EMPTY JSON Schema through `toToolSpec`, so a tool
 *   contract cannot be authored app-side. See
 *   `./poly-account-copy-trade-orders` for the full reasoning.
 * Side-effects: none
 * Links: task.1791070967, story.5006
 * @public
 */

export {
  POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
  polyAccountCopyTradeOrdersBoundTool,
  polyAccountCopyTradeOrdersToolContract,
  type PolyAccountCopyTradeOrdersToolInput,
  PolyAccountCopyTradeOrdersToolInputSchema,
  type PolyAccountCopyTradeOrdersToolOutput,
  PolyAccountCopyTradeOrdersToolOutputSchema,
  type PolyAccountCopyTradeOrdersToolRedacted,
  type PolyAccountReadUnavailableReason,
  PolyAccountReadUnavailableReasonSchema,
} from "./poly-account-copy-trade-orders";

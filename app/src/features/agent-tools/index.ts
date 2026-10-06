// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/agent-tools`
 * Purpose: Public surface of the INTERNAL-AGENT transport for the capability
 *   plane — thin functions that invoke ONE account-read capability on behalf of
 *   the signed-in user's principal, for a LangGraph tool to call.
 * Scope: Re-exports only. The tool CONTRACTS live in `@cogni/poly-graphs/tools`
 *   (they must be zod v3 to satisfy `@cogni/ai-tools`; this app is on v4), and
 *   the per-request wiring that closes a principal over these transports lives
 *   in `@bootstrap/ai/principal-tool-source` (features must not reach into
 *   `@/bootstrap` for a database handle).
 * Invariants: nothing exported here holds a principal, a database handle, or a
 *   service-role connection. Each transport takes them as arguments.
 * Side-effects: none
 * Links: task.1791070967, story.5006, docs/spec/capability-plane.md
 * @public
 */

export {
  type PolyAccountCopyTradeOrdersToolDeps,
  runPolyAccountCopyTradeOrdersTool,
} from "./copy-trade-orders-tool";

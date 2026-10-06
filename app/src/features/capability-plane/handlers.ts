// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/capability-plane/handlers`
 * Purpose: App-local runtime binding for the pure account-read catalog. Each
 *   binding joins one descriptor to the existing feature query, its terminal
 *   feature event, and the transport-specific counts that event carries.
 * Scope: Wiring only. Adds no query, changes no business logic, and owns no
 *   authorization — `executeAccountRead` does all of that.
 * Invariants:
 *   - NO_HANDLER_REGISTRY_IN_PACKAGES — this binding is deliberately app-local;
 *     `@cogni/poly-node-contracts` stays importable without a DB client.
 *   - BUSINESS_QUERIES_UNCHANGED — handlers call the existing services with the
 *     same arguments the routes used, so response contracts are untouched.
 *   - TERMINAL_EVENT_PER_OPERATION — `ACCOUNT_READ_TERMINAL_EVENTS` is keyed by
 *     the catalog's id union, so a new capability cannot ship without one.
 * Side-effects: none at module load; handlers do IO when invoked.
 * Links: task.1791070961
 * @public
 */

import type {
  PolyAccountReadOperationId,
  PolyResearchCopyTradeInvestigationEvidenceQuery,
  PolyResearchCopyTradeInvestigationEvidenceResponse,
  PolyResearchCopyTradeInvestigationQuery,
  PolyResearchCopyTradeInvestigationResponse,
  PolyResearchCopyTradePnlQuery,
  PolyResearchCopyTradePnlResponse,
} from "@cogni/poly-node-contracts";

import type { AgentGrantTransaction } from "@/features/agent-grants/authorization";
import {
  getCopyTradeInvestigationEvidence,
  getCopyTradeInvestigationSummary,
  InvalidInvestigationCapturedAtError,
  InvalidInvestigationCursorError,
} from "@/features/wallet-analysis/server/copy-trade-investigation-service";
import { getCopyTradePnlForTenant } from "@/features/wallet-analysis/server/copy-trade-pnl-service";
import { EVENT_NAMES, type EventName } from "@/shared/observability";

import type {
  AccountReadHandler,
  AccountReadStatus,
} from "./execute-account-read";

/**
 * Terminal feature event per capability. Keyed by the catalog's id union, so
 * adding a descriptor without an event is a compile error. The two
 * investigation reads intentionally share one event name — that is the existing
 * Loki contract, and the `operationId` field now disambiguates them.
 */
export const ACCOUNT_READ_TERMINAL_EVENTS: Record<
  PolyAccountReadOperationId,
  EventName
> = {
  "poly.research-copy-trade-pnl.v1":
    EVENT_NAMES.POLY_RESEARCH_COPY_TRADE_PNL_COMPLETE,
  "poly.research-copy-trade-investigation.v1":
    EVENT_NAMES.POLY_RESEARCH_COPY_TRADE_INVESTIGATION_COMPLETE,
  "poly.research-copy-trade-investigation-evidence.v1":
    EVENT_NAMES.POLY_RESEARCH_COPY_TRADE_INVESTIGATION_COMPLETE,
  // Both portfolio-snapshot transports reuse the existing dashboard event, for
  // the same reason the two investigation reads share one: it is the live Loki
  // contract. `routeId` separates the owner and agent transports and
  // `operationId` proves they are one capability.
  "poly.account.portfolio-snapshot.v1":
    EVENT_NAMES.POLY_WALLET_DASHBOARD_COMPLETE,
};

/**
 * `getCopyTradePnlForTenant` is a frozen port entry (`exact` in
 * docs/porting/poly-port-inventory.json) whose `db` parameter is declared as a
 * `NodePgDatabase | PostgresJsDatabase` union rather than a transaction type. A
 * `PgTransaction` is not structurally assignable to either (it carries no
 * `$client`), so the boundary needs one narrowing. It lives here, once, at the
 * call site the task amendment sanctioned — rather than being repeated in all
 * three route modules as it was before. The service only calls `.select()` and
 * `.execute()` on the handle, both of which a transaction provides.
 */
function asPnlServiceDb(
  tx: AgentGrantTransaction
): Parameters<typeof getCopyTradePnlForTenant>[0] {
  return tx as unknown as Parameters<typeof getCopyTradePnlForTenant>[0];
}

/** Per-market copy-trade execution rollup. Arity adapted; query unchanged. */
export const copyTradePnlAccountReadHandler: AccountReadHandler<
  PolyResearchCopyTradePnlQuery,
  PolyResearchCopyTradePnlResponse
> = (tx, input) =>
  getCopyTradePnlForTenant(
    asPnlServiceDb(tx),
    input.billing_account_id,
    input.mode,
    {
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
    }
  );

/** Terminal-event counts for the P/L rollup. */
export function copyTradePnlExtra(context: {
  data: PolyResearchCopyTradePnlResponse | null;
}): Record<string, unknown> {
  return {
    marketsCount: context.data?.markets.length ?? 0,
    fillsCount: context.data?.summary.fills_count ?? 0,
  };
}

/** Bounded saved-facts snapshot for one market. Already `(tx, query)`. */
export const copyTradeInvestigationAccountReadHandler: AccountReadHandler<
  PolyResearchCopyTradeInvestigationQuery,
  PolyResearchCopyTradeInvestigationResponse
> = (tx, input) => getCopyTradeInvestigationSummary(tx, input);

/** Terminal-event counts for the investigation snapshot. */
export function copyTradeInvestigationExtra(context: {
  status: AccountReadStatus;
  data: PolyResearchCopyTradeInvestigationResponse | null;
}): Record<string, unknown> {
  const data = context.data;
  return {
    evidenceCount: data
      ? data.aggregates.fills.count + data.aggregates.decisions.count
      : 0,
    ...(context.status === "ok" && data
      ? { complete: data.completeness.complete }
      : {}),
  };
}

/** One cursor-paginated evidence page. Already `(tx, query)`. */
export const copyTradeInvestigationEvidenceAccountReadHandler: AccountReadHandler<
  PolyResearchCopyTradeInvestigationEvidenceQuery,
  PolyResearchCopyTradeInvestigationEvidenceResponse
> = (tx, input) => getCopyTradeInvestigationEvidence(tx, input);

/**
 * An unparseable cursor or `captured_at` is a caller problem, not an outage.
 * The executor turns this into the same 400 the route used to raise by hand.
 */
export function classifyInvestigationEvidenceError(
  error: unknown
): "invalid_input" | undefined {
  return error instanceof InvalidInvestigationCursorError ||
    error instanceof InvalidInvestigationCapturedAtError
    ? "invalid_input"
    : undefined;
}

/** Terminal-event counts for one evidence page. */
export function copyTradeInvestigationEvidenceExtra(context: {
  status: AccountReadStatus;
  input: PolyResearchCopyTradeInvestigationEvidenceQuery | null;
  data: PolyResearchCopyTradeInvestigationEvidenceResponse | null;
}): Record<string, unknown> {
  const data = context.data;
  return {
    ...(context.input ? { evidenceKind: context.input.kind } : {}),
    evidenceCount: context.status === "ok" && data ? data.items.length : 0,
    ...(context.status === "ok" && data ? { truncated: data.truncated } : {}),
  };
}

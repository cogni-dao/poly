// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/capability-plane/portfolio-snapshot`
 * Purpose: App-local binding of `poly.account.portfolio-snapshot.v1` — ONE
 *   handler body serving both transports, so the owner dashboard and an
 *   approved delegated agent cannot diverge. This is the agent-first
 *   inversion: the capability owns the read, and the routes own nothing.
 * Scope: Wiring plus account resolution. Every business query stays in
 *   `@features/wallet-analysis/server/tenant-wallet-dashboard-service`; this
 *   module adds no SQL of its own beyond reading the tenant GUC.
 * Invariants:
 *   - ONE_HANDLER_TWO_TRANSPORTS — both descriptors bind the same
 *     `portfolioSnapshotFor`, so parity is structural. The ONLY difference is
 *     where the billing account comes from, and in both cases the account the
 *     snapshot is computed for is the account `authorize()` allowed.
 *   - ACCOUNT_FILTER_IMPOSSIBLE_TO_OMIT — the account id is a required
 *     positional argument threaded into every read. This matters more than
 *     usual here: the snapshot reads `poly_trader_*`, which per the spec's
 *     Carve-out 1 has NO row-level security at all, so for those tables this
 *     capability is the only tenant clamp. There is no RLS underneath to catch
 *     a missing filter.
 *   - NO_GET_CREATES_AN_ACCOUNT — resolution is `resolvePrincipalAccountId`,
 *     a pure SELECT. `resolveBillingAccountId` (which lazily INSERTs a billing
 *     account on miss) is deliberately NOT imported. An unknown principal
 *     yields null, which the executor renders as a non-disclosing 404 instead
 *     of silently manufacturing an empty tenant of its own — the exact
 *     mechanism behind the fabricated-balance incident.
 *   - AUTHORIZE_BEFORE_CACHE — the snapshot cache is entered inside the
 *     handler, which the executor reaches only after `authorize()` returned an
 *     allow (`if (!access) return null` precedes the handler call). See the
 *     note on `AccountReadCache` below for why the typed hook is not used.
 *   - SAVED_FACTS_ONLY / PAGE_LOAD_DB_ONLY — no upstream API, no Polygon RPC,
 *     no Privy call. `adapterConfigured` is a deployment flag supplied by the
 *     transport, not a fact read from anywhere.
 *   - READ_ONLY_IS_NOT_A_LIE — every leg is a SELECT, so the operation is
 *     honestly `readOnly: true` and runs under the executor's
 *     `REPEATABLE READ READ ONLY`. (This is precisely why `/wallet/overview`,
 *     whose `coalesceWalletBalances` performs live Polygon RPC, is deferred to
 *     a follow-up rather than migrated here.)
 * Side-effects: IO (bounded Postgres reads), module-scope cache writes.
 * Links: story.5004, story.5006, task.1791070962
 * @public
 */

import type {
  PolyAccountPortfolioSnapshotOutput,
  PolyAccountPortfolioSnapshotOwnerQuery,
  PolyAccountPortfolioSnapshotQuery,
} from "@cogni/poly-node-contracts";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  type AgentGrantTransaction,
  resolvePrincipalAccountId,
} from "@/features/agent-grants/authorization";
import { coalescePortfolioSnapshot } from "@/features/wallet-analysis/server/portfolio-snapshot-cache";
import { readTenantWalletDashboardIn } from "@/features/wallet-analysis/server/tenant-wallet-dashboard-service";

import type { AccountReadHandler, AccountReadStatus } from "./execute-account-read";

/**
 * Deployment affordance, injected by the transport.
 *
 * `isPolyTraderWalletConfigured()` lives in `@/bootstrap`, which a feature must
 * not import, and it is an environment property rather than a saved fact or an
 * authorization input — so it travels as a parameter. It reaches the payload
 * only through the pre-existing `overview.configured` and
 * `facts.positions.actionsAllowed` fields, both of which are owner-UI
 * affordances and neither of which confers write authority on any principal.
 */
export type PortfolioSnapshotBinding = { adapterConfigured: boolean };

/**
 * The single handler body. `billingAccountId` is always the account the
 * executor authorized.
 *
 * The cache sits here rather than in `executeAccountRead`'s typed
 * `AccountReadCache`, for one structural reason worth recording: the seam
 * hands neither the handler nor the cache hooks the authorized account id —
 * `AccountReadCache.lookup(input, access)` receives only the parsed input and
 * `{ accessKind, grantId }`. A TENANT_KEYED cache is therefore expressible via
 * that hook only for `accountFrom: "input"` operations. Using it for the agent
 * transport alone would leave the owner dashboard's 30-second tick uncached,
 * which is a real latency regression on the heaviest read in the node. Caching
 * here keeps one tenant-keyed entry shared by both transports — and the
 * handler is unreachable before an allow, so AUTHORIZE_BEFORE_CACHE holds by
 * the executor's documented dispatch order. The clean fix is a seam change
 * (pass `{ accountId, access }` to the handler and the cache hooks); that is
 * flagged for the seam owner rather than worked around by weakening the cache.
 */
async function portfolioSnapshotFor(
  tx: AgentGrantTransaction,
  billingAccountId: string,
  interval: PolyAccountPortfolioSnapshotQuery["interval"],
  binding: PortfolioSnapshotBinding
): Promise<PolyAccountPortfolioSnapshotOutput> {
  return coalescePortfolioSnapshot(billingAccountId, interval, () =>
    readTenantWalletDashboardIn(
      // The read model is typed against the postgres-js database handle; a
      // transaction exposes the `execute`/`select`/`transaction` surface it
      // uses but is not structurally assignable. One narrowing, at one call
      // site, exactly as the frozen P/L service's binding does.
      tx as unknown as PostgresJsDatabase<Record<string, unknown>>,
      { billingAccountId, interval, adapterConfigured: binding.adapterConfigured }
    )
  );
}

/**
 * Delegated/agent transport. The account is named on the wire and has already
 * been authorized by the executor, so the handler can use it directly.
 */
export function portfolioSnapshotAccountReadHandler(
  binding: PortfolioSnapshotBinding
): AccountReadHandler<
  PolyAccountPortfolioSnapshotQuery,
  PolyAccountPortfolioSnapshotOutput
> {
  return (tx, input) =>
    portfolioSnapshotFor(
      tx,
      input.billing_account_id,
      input.interval,
      binding
    );
}

/**
 * Owner-session transport. No account on the wire, so the handler re-resolves
 * the principal's account.
 *
 * It calls the SAME `resolvePrincipalAccountId` the executor used for its
 * `accountFrom: "principal"` decision, against the same transaction, with the
 * same principal — read back from the tenant GUC that `withTenantScope` set.
 * Using the identical function is the point: a second, differently-written
 * lookup could in principle select a different row for a user owning more than
 * one account, and then the snapshot would describe an account that was never
 * authorized. Returning null here collapses to the same non-disclosing 404.
 */
export function portfolioSnapshotOwnerAccountReadHandler(
  binding: PortfolioSnapshotBinding
): AccountReadHandler<
  PolyAccountPortfolioSnapshotOwnerQuery,
  PolyAccountPortfolioSnapshotOutput
> {
  return async (tx, input) => {
    const principalId = await currentTenantPrincipalId(tx);
    if (principalId === null) return null;
    const billingAccountId = await resolvePrincipalAccountId(tx, principalId);
    if (billingAccountId === null) return null;
    return portfolioSnapshotFor(tx, billingAccountId, input.interval, binding);
  };
}

/**
 * The principal the surrounding tenant scope was opened for.
 *
 * `withTenantScope` issues `SET LOCAL app.current_user_id = '<principal>'` as
 * the transaction's first statement, and every RLS policy in the schema reads
 * that same GUC — so this is the authoritative principal for the transaction,
 * not a second opinion about it.
 */
async function currentTenantPrincipalId(
  tx: AgentGrantTransaction
): Promise<string | null> {
  const result: unknown = await tx.execute(
    sql`SELECT current_setting('app.current_user_id', true) AS principal_id`
  );
  const rows = Array.isArray(result)
    ? (result as Array<{ principal_id?: unknown }>)
    : ((result as { rows?: Array<{ principal_id?: unknown }> }).rows ?? []);
  const principalId = rows[0]?.principal_id;
  return typeof principalId === "string" && principalId.length > 0
    ? principalId
    : null;
}

/**
 * Terminal-event fields for the portfolio snapshot.
 *
 * This reproduces the field set the dashboard route used to log by hand, so
 * the existing Loki queries and the degraded-snapshot alerting keep working
 * after the inversion. One deliberate change: the envelope's `outcome` is
 * owned by the executor and is `success`/`error`, so the route's former
 * `outcome: "degraded"` third value is now carried by the `degraded` boolean
 * (which it always set alongside) rather than by `outcome`.
 */
export function portfolioSnapshotExtra(
  context: {
    status: AccountReadStatus;
    data: PolyAccountPortfolioSnapshotOutput | null;
  },
  buildSha: string
): Record<string, unknown> {
  const response = context.data;
  if (response === null) {
    // Parse failures, denials and not-founds have no snapshot to describe.
    // `degraded: true` keeps the existing alerting predicate honest, and the
    // executor supplies `status` / `errorCode` / `authorizationOutcome`.
    return { buildSha, degraded: true, warningCodes: [] };
  }
  const facts = response.facts;
  const coverage = response.execution.comparisonCoverage;
  const degraded =
    response.warnings.length > 0 ||
    Object.values(facts).some((fact) => fact.status !== "fresh");

  return {
    buildSha,
    snapshotId: response.snapshotId,
    capturedAt: response.capturedAt,
    interval: response.interval,
    ...factFields("wallet", facts.wallet),
    ...factFields("cash", facts.cash),
    ...factFields("order", facts.orders),
    ...factFields("position", facts.positions),
    ...factFields("history", facts.history),
    ...factFields("pnl", facts.pnl),
    ...factFields("activity", facts.activity),
    ...factFields("markets", facts.markets),
    ...factFields("total", facts.total),
    tradingReady: response.readiness.trading_ready,
    walletConnected: response.readiness.connected,
    openOrders: response.overview.open_orders,
    livePositionCount: response.execution.live_position_count,
    closedPositionCount: response.execution.closed_position_count,
    ...coverageFields("comparisonMarketsLive", coverage.markets.live),
    ...coverageFields("comparisonMarketsClosed", coverage.markets.closed),
    ...coverageFields("comparisonPositionsLive", coverage.positions.live),
    ...coverageFields("comparisonPositionsClosed", coverage.positions.closed),
    cashUsdc: response.overview.usdc_available,
    positionsMtmUsdc: response.overview.usdc_positions_mtm,
    totalUsdc: response.overview.usdc_total,
    warningCodes: response.warnings.map((entry) => entry.code),
    degraded,
  };
}

/** `<name>Status` / `Source` / `AgeMs` / `Complete`, the shape Loki already has. */
function factFields(
  name: string,
  fact: { status: string; source: string; ageMs: number | null; complete: boolean }
): Record<string, unknown> {
  return {
    [`${name}Status`]: fact.status,
    [`${name}Source`]: fact.source,
    [`${name}AgeMs`]: fact.ageMs,
    [`${name}Complete`]: fact.complete,
  };
}

/** Coverage leaf fields, with `reasons` flattened to the existing CSV shape. */
function coverageFields(
  name: string,
  leaf: {
    eligible: number | null;
    comparable: number | null;
    dropped: number | null;
    sampled: number | null;
    complete: boolean;
    reasons: readonly string[];
  }
): Record<string, unknown> {
  return {
    [`${name}Eligible`]: leaf.eligible,
    [`${name}Comparable`]: leaf.comparable,
    [`${name}Dropped`]: leaf.dropped,
    [`${name}Sampled`]: leaf.sampled,
    [`${name}Complete`]: leaf.complete,
    [`${name}Reasons`]: leaf.reasons.join(","),
  };
}

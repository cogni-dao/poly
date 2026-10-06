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

import type { AccountReadStatus } from "./execute-account-read";

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
 * Handler shape for this capability, widened by one optional argument.
 *
 * `executeAccountRead` resolves the authorized account id for authorize() but
 * does NOT currently forward it to the handler — `AccountReadHandler` is
 * `(tx, input)`. A seam fix to pass it as a third argument is in flight. This
 * type is deliberately compatible with BOTH shapes: `accountId` is optional, so
 * this remains assignable to today's two-argument `AccountReadHandler`, and it
 * starts using the authorized id the moment the seam supplies it.
 *
 * Crucially, the fallback is NOT "trust RLS". Relying on RLS alone would be
 * wrong here: a delegated agent's RLS legitimately spans its OWN billing
 * account (as owner) AND the account it holds a grant on, so an unfiltered read
 * would merge two tenants into one response. Worse, `poly_trader_*` has no RLS
 * at all. Every query therefore takes the account as an explicit, required
 * argument — see ACCOUNT_FILTER_IMPOSSIBLE_TO_OMIT above.
 */
export type PortfolioSnapshotHandler<TInput> = (
  tx: AgentGrantTransaction,
  input: TInput,
  /** The account `authorize()` allowed, once the seam forwards it. */
  accountId?: string
) => Promise<PolyAccountPortfolioSnapshotOutput | null>;

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
): PortfolioSnapshotHandler<PolyAccountPortfolioSnapshotQuery> {
  // `input.billing_account_id` IS the account the executor authorized for
  // `accountFrom: "input"`, so the two agree by construction; prefer the
  // authorized id when the seam forwards it.
  return (tx, input, accountId) =>
    portfolioSnapshotFor(
      tx,
      accountId ?? input.billing_account_id,
      input.interval,
      binding
    );
}

/**
 * Owner-session transport. The dashboard has no account id on the wire — the
 * browser never learns its own (inventory row 1.1, and there is no `whoami`
 * yet) — so the capability is inherently `accountFrom: "principal"`.
 *
 * When the seam forwards the authorized `accountId`, that is used verbatim and
 * is the ONLY source. The `ownerAccountId` fallback below exists solely because
 * the current seam calls `handler(tx, input)`; it is KNOWN INSUFFICIENT and is
 * deleted the moment the seam forwards the account (PR #144). See that
 * function for exactly why.
 */
export function portfolioSnapshotOwnerAccountReadHandler(
  binding: PortfolioSnapshotBinding
): PortfolioSnapshotHandler<PolyAccountPortfolioSnapshotOwnerQuery> {
  return async (tx, input, accountId) => {
    const billingAccountId = accountId ?? (await ownerAccountId(tx));
    if (billingAccountId === null) return null;
    return portfolioSnapshotFor(tx, billingAccountId, input.interval, binding);
  };
}

/**
 * Mirror of the dispatch-time account resolution, for as long as the seam does
 * not forward it. DO NOT build on this.
 *
 * It calls the SAME `resolvePrincipalAccountId` the executor called, on the
 * same transaction, with the principal read back from the tenant GUC — so the
 * handler cannot select a different row than the one `authorize()` ruled on.
 * That makes it *consistent* with dispatch. It does NOT make it *correct*,
 * because dispatch itself is not:
 *
 *   `resolvePrincipalAccountId` answers "which account does this principal
 *   OWN", and `POST /api/v1/agent/register` — which is `auth: { mode: "none" }`,
 *   i.e. unauthenticated — mints a fresh user and calls
 *   `getOrCreateBillingAccountForUser` for it. So EVERY agent principal owns an
 *   account. An agent bearer reaching this `accountFrom: "principal"` transport
 *   (and it can: `app/_lib/auth/session.ts` re-exports `resolveRequestIdentity`,
 *   so the route accepts bearers) therefore resolves its OWN empty account,
 *   passes `authorize()` as `accessKind: "owner"`, and receives a 200.
 *
 * The blast radius is bounded but the shape is wrong: the response is the
 * `emptyDashboard(...)` degradation — typed nulls plus a `no_trading_wallet`
 * warning, never zeroes, and never another tenant's rows — so it does not leak
 * and does not fabricate. But a well-formed empty answer where a denial belongs
 * is the "misleadingly present" delegation path story.5004 exists to remove.
 *
 * This cannot be fixed from inside the handler: the account is chosen by the
 * executor before the handler runs, and a transport must not branch on which
 * channel a principal arrived over (PRINCIPAL_CARRIES_PRIVILEGE). The fix is
 * PR #144's `resolveSubjectAccountId`, which resolves by REACHABILITY for the
 * required scope (live grants union owned): exactly one resolves, several are
 * `invalid_input`, none is denied. When it lands, `accountId` becomes a
 * required parameter and this function goes away.
 */
async function ownerAccountId(
  tx: AgentGrantTransaction
): Promise<string | null> {
  const principalId = await currentTenantPrincipalId(tx);
  return principalId === null
    ? null
    : resolvePrincipalAccountId(tx, principalId);
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

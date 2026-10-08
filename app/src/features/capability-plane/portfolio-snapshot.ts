// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/capability-plane/portfolio-snapshot`
 * Purpose: App-local binding of `poly.account.portfolio-snapshot.v1` — ONE
 *   handler body serving both transports, so the owner dashboard and an
 *   approved delegated agent cannot diverge. This is the agent-first
 *   inversion: the capability owns the read, and the routes own nothing.
 * Scope: Wiring only. Every business query stays in
 *   `@features/wallet-analysis/server/tenant-wallet-dashboard-service`; this
 *   module adds no SQL of its own at all.
 * Invariants:
 *   - ONE_HANDLER_TWO_TRANSPORTS — both descriptors bind the SAME factory,
 *     `portfolioSnapshotAccountReadHandler`, so parity is structural rather
 *     than asserted. Since the seam forwards the authorized account the two
 *     bindings are identical; there is no owner-specific variant to drift.
 *   - ACCOUNT_FILTER_IMPOSSIBLE_TO_OMIT — the account id is a required
 *     positional argument threaded into every read. This matters more than
 *     usual here: the snapshot reads `poly_trader_*`, which per the spec's
 *     Carve-out 1 has NO row-level security at all, so for those tables this
 *     capability is the only tenant clamp. There is no RLS underneath to catch
 *     a missing filter.
 *   - ACCOUNT_COMES_ONLY_FROM_THE_SEAM — this module performs NO account
 *     resolution of its own. `accountId` is the account `authorize()` actually
 *     allowed, handed down by `executeAccountRead`. One source, so the account
 *     the snapshot describes and the account that was authorized cannot drift.
 *     `resolveBillingAccountId` (which lazily INSERTs a billing account on
 *     miss) and `resolvePrincipalAccountId` (which answers the WRONG question —
 *     "which account does this principal own", and every agent principal owns
 *     one) are both deliberately absent.
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
  PolyAccountPortfolioSnapshotQuery,
} from "@cogni/poly-node-contracts";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { AgentGrantTransaction } from "@/features/agent-grants/authorization";
import { EVENT_NAMES, type EventName } from "@/shared/observability";
import { coalescePortfolioSnapshot } from "@/features/wallet-analysis/server/portfolio-snapshot-cache";
import {
  readTenantWalletDashboardIn,
  type WalletDashboardReadDiagnostics,
} from "@/features/wallet-analysis/server/tenant-wallet-dashboard-service";

import type {
  AccountReadHandler,
  AccountReadStatus,
} from "./execute-account-read";

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
/**
 * Terminal feature event for both transports.
 *
 * Declared here rather than in `ACCOUNT_READ_TERMINAL_EVENTS`, because that map
 * is keyed by the discoverable catalog's id union and this capability is
 * deliberately outside the catalog (see the descriptor for why). Reusing the
 * existing dashboard event keeps the live Loki contract intact; `routeId`
 * separates the owner and agent transports and `operationId` proves they are
 * one capability.
 */
export const PORTFOLIO_SNAPSHOT_TERMINAL_EVENT: EventName =
  EVENT_NAMES.POLY_WALLET_DASHBOARD_COMPLETE;

export type PortfolioSnapshotBinding = {
  adapterConfigured: boolean;
  diagnostics?: WalletDashboardReadDiagnostics;
};

export type { WalletDashboardReadDiagnostics };

/**
 * The single handler body. `billingAccountId` is always the account
 * `authorize()` allowed, forwarded by the executor.
 *
 * The cache sits here rather than in `executeAccountRead`'s typed
 * `AccountReadCache`, for one structural reason worth recording: the seam hands
 * the cache hooks no account id — `AccountReadCache.lookup(input, access)`
 * receives only the parsed input and `{ accessKind, grantId }`. A TENANT_KEYED
 * cache is therefore expressible via that hook only for `accountFrom: "input"`
 * operations. Using it for the agent transport alone would leave the owner
 * dashboard's 30-second tick uncached, which is a real latency regression on
 * the heaviest read in the node. Caching here keeps one tenant-keyed entry
 * shared by both transports — and the handler is unreachable before an allow,
 * so AUTHORIZE_BEFORE_CACHE holds by the executor's documented dispatch order.
 * The clean fix is the same shape as the account fix: hand the cache hooks the
 * authorized `accountId` too.
 */
async function portfolioSnapshotFor(
  tx: AgentGrantTransaction,
  billingAccountId: string,
  interval: PolyAccountPortfolioSnapshotQuery["interval"],
  binding: PortfolioSnapshotBinding
): Promise<PolyAccountPortfolioSnapshotOutput> {
  return coalescePortfolioSnapshot(billingAccountId, interval, () => {
    if (binding.diagnostics) {
      try {
        binding.diagnostics.comparisonPath = "unknown";
      } catch {
        // Diagnostics are fail-open and cannot alter wallet truth.
      }
    }
    return readTenantWalletDashboardIn(
      // The read model is typed against the postgres-js database handle; a
      // transaction exposes the `execute`/`select`/`transaction` surface it
      // uses but is not structurally assignable. One narrowing, at one call
      // site, exactly as the frozen P/L service's binding does.
      tx as unknown as PostgresJsDatabase<Record<string, unknown>>,
      {
        billingAccountId,
        interval,
        adapterConfigured: binding.adapterConfigured,
        ...(binding.diagnostics ? { diagnostics: binding.diagnostics } : {}),
      }
    );
  });
}

/**
 * ONE handler for both transports.
 *
 * Now that the seam forwards the authorized account (PR #144), the owner and
 * delegated bindings are character-for-character identical — neither needs to
 * know where the account came from, only that it was authorized. So they
 * collapse into this single factory, and ONE_HANDLER_TWO_TRANSPORTS stops
 * being a claim about two similar functions and becomes the same function
 * serving both routes.
 *
 * `TInput` need only carry `interval`. The delegated input also carries
 * `billing_account_id`, which the executor consumed before dispatch and which
 * this handler deliberately ignores in favour of `accountId` — ONE source for
 * the account, so the snapshot and the authorization cannot describe different
 * tenants.
 */
export function portfolioSnapshotAccountReadHandler<
  TInput extends { interval: PolyAccountPortfolioSnapshotQuery["interval"] },
>(
  binding: PortfolioSnapshotBinding
): AccountReadHandler<TInput, PolyAccountPortfolioSnapshotOutput> {
  return (tx, input, accountId) =>
    portfolioSnapshotFor(tx, accountId, input.interval, binding);
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
  buildSha: string,
  diagnostics?: WalletDashboardReadDiagnostics
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
    tradeActivityBucketUnit:
      response.execution.tradeActivity?.bucketUnit ?? null,
    tradeActivityBucketCount:
      response.execution.tradeActivity?.buckets.length ?? 0,
    tradeActivityTotal:
      response.execution.tradeActivity?.buckets.reduce(
        (sum, bucket) => sum + bucket.n,
        0
      ) ?? 0,
    ...coverageFields("comparisonMarketsLive", coverage.markets.live),
    ...coverageFields("comparisonMarketsClosed", coverage.markets.closed),
    ...coverageFields("comparisonPositionsLive", coverage.positions.live),
    ...coverageFields("comparisonPositionsClosed", coverage.positions.closed),
    cashUsdc: response.overview.usdc_available,
    positionsMtmUsdc: response.overview.usdc_positions_mtm,
    totalUsdc: response.overview.usdc_total,
    warningCodes: response.warnings.map((entry) => entry.code),
    comparisonReadPath: diagnostics?.comparisonPath ?? "unknown",
    comparisonIdentityMs: diagnostics?.comparisonIdentityMs ?? null,
    comparisonBundleTotalMs: diagnostics?.comparisonBundleTotalMs ?? null,
    comparisonBundleQueryMs: diagnostics?.comparisonBundleQueryMs ?? null,
    comparisonFillRollupMs: diagnostics?.comparisonFillRollupMs ?? null,
    comparisonFallbackTargetMs:
      diagnostics?.comparisonFallbackTargetMs ?? null,
    comparisonFallbackFillRollupMs:
      diagnostics?.comparisonFallbackFillRollupMs ?? null,
    comparisonFallbackMarketMs:
      diagnostics?.comparisonFallbackMarketMs ?? null,
    bundleQueryFailureClass: diagnostics?.bundleQueryFailureClass ?? null,
    bundleFillRollupFailureClass:
      diagnostics?.bundleFillRollupFailureClass ?? null,
    fallbackFillRollupFailureClass:
      diagnostics?.fallbackFillRollupFailureClass ?? null,
    fallbackTargetFailureClass:
      diagnostics?.fallbackTargetFailureClass ?? null,
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

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/wallet/_lib/dashboard-route-cache`
 * Purpose: Cache keys, TTLs, and invalidation for the coalesced dashboard
 *   route payloads (`/wallet/overview`, `/wallet/execution`) and the
 *   on-chain wallet-balances read. The routes recompute ~7 heavy statements
 *   per request; wrapping the post-auth payload computation in `coalesce`
 *   collapses a burst of requests into one computation per key per TTL
 *   window (task.5013). Balances additionally get their own longer-TTL
 *   entry so a cold route-cache hit does not block first paint on Polygon
 *   RPC (task.5010).
 * Scope: Key/TTL helpers over the wallet-analysis process TTL cache plus
 *   the balances coalescing wrapper. No IO of its own. Consumed by the
 *   overview + execution routes (read side) and the refresh route
 *   (invalidation side).
 * Invariants:
 *   - SINGLE_REPLICA: keys live in the in-process TTL cache (see
 *     `@features/wallet-analysis/server/coalesce`). As of task.5016,
 *     background WRITERS are single-pod via job-runner leader election
 *     (`@bootstrap/jobs/job-leader-elector`), but these read caches remain
 *     per-replica — scaling past one replica degrades to per-replica
 *     caches (lower hit rate, ~N× recompute; perf-only, never
 *     correctness: keys are tenant-scoped and recomputed from the DB, and
 *     `REFRESH_INVALIDATES` only evicts on the replica that served the
 *     POST, so cross-replica staleness is bounded by the TTLs below).
 *   - TENANT_KEYED: every key embeds the billing account id, so one
 *     tenant's cached payload can never be served to another tenant.
 *   - ERRORS_NOT_CACHED: `coalesce` evicts rejected fetchers
 *     (FAILED_FETCH_NOT_CACHED), so only successfully computed payloads —
 *     including partial-success payloads that degrade to warnings — are
 *     ever cached.
 *   - BALANCES_DEGRADED_NOT_CACHED: `coalesceWalletBalances` immediately
 *     evicts null (no wallet) and partial (RPC error/timeout leg) results,
 *     so a transient Polygon RPC blip is never pinned for the 30s balances
 *     TTL — the concurrent burst shares the degraded read, the next request
 *     retries. Real-money display: a fully-successful balance read may be
 *     up to `WALLET_BALANCES_CACHE_TTL_MS` (30s) stale on the dashboard.
 *   - REFRESH_INVALIDATES: POST /wallet/refresh calls
 *     `invalidateDashboardRouteCaches`, which evicts the route payloads AND
 *     the balances key, so the refresh button always produces fresh
 *     on-chain balances on the next read.
 * Side-effects: eviction mutates the shared module-scope TTL cache.
 * Links: src/features/wallet-analysis/server/coalesce.ts
 * @internal
 */

import {
  clearTtlCacheByPrefix,
  coalesce,
} from "@/features/wallet-analysis/server/coalesce";

/**
 * TTL for cached dashboard route payloads. Short enough that a manual
 * browser reload after ~5s sees fresh data; long enough to absorb the
 * dashboard's parallel-widget request bursts.
 */
export const DASHBOARD_ROUTE_CACHE_TTL_MS = 5_000;

/**
 * TTL for cached on-chain wallet balances (task.5010). Deliberately longer
 * than the route-payload TTL so a cold/expired route-cache hit is served
 * from warm balances instead of blocking first paint on 3 Polygon RPC
 * calls. 30s staleness is the accepted display bound for wallet cash/gas;
 * POST /wallet/refresh evicts this key for users who need fresher numbers.
 */
export const WALLET_BALANCES_CACHE_TTL_MS = 30_000;

const OVERVIEW_KEY_PREFIX = "route:wallet-overview:";
const EXECUTION_KEY_PREFIX = "route:wallet-execution:";
const BALANCES_KEY_PREFIX = "balances:";

/**
 * Overview payloads vary by interval (pnl chart window) and freshness
 * (`live` gates pnl_history computation), so both are part of the key.
 */
export function overviewRouteCacheKey(
  billingAccountId: string,
  interval: string,
  freshness: string
): string {
  return `${OVERVIEW_KEY_PREFIX}${billingAccountId}:${interval}:${freshness}`;
}

/**
 * The execution route's computation ignores `freshness` (it is only echoed
 * back on the payload, which the route re-stamps per request), so the key
 * is the billing account alone.
 */
export function executionRouteCacheKey(billingAccountId: string): string {
  return `${EXECUTION_KEY_PREFIX}${billingAccountId}`;
}

/** Cache key for one tenant's on-chain wallet balances (task.5010). */
export function walletBalancesCacheKey(billingAccountId: string): string {
  return `${BALANCES_KEY_PREFIX}${billingAccountId}`;
}

/**
 * Coalesce + cache one tenant's on-chain balance read for
 * `WALLET_BALANCES_CACHE_TTL_MS` (30s), so the overview route's first paint
 * never blocks on Polygon RPC when a warm read exists.
 *
 * BALANCES_DEGRADED_NOT_CACHED: only a fully-successful read (non-null,
 * empty `errors`) stays warm for the full TTL. A null result (no trading
 * wallet yet) or a partial read (an RPC leg errored or timed out) is
 * returned to the current burst — concurrent callers still share one
 * fetch — but evicted immediately, so the next request retries instead of
 * pinning a degraded snapshot for 30s. Wallet connect and RPC recovery are
 * therefore visible on the very next request.
 */
export async function coalesceWalletBalances<
  T extends { errors: readonly string[] } | null,
>(billingAccountId: string, fetcher: () => Promise<T>): Promise<T> {
  const key = walletBalancesCacheKey(billingAccountId);
  const balances = await coalesce(key, fetcher, WALLET_BALANCES_CACHE_TTL_MS);
  if (balances === null || balances.errors.length > 0) {
    clearTtlCacheByPrefix(key);
  }
  return balances;
}

/**
 * Evict every cached dashboard route payload for one tenant, plus the
 * tenant's cached on-chain balances (task.5010). Called by
 * POST /wallet/refresh (sibling of `invalidateWalletAnalysisCaches`, which
 * evicts the address-keyed slice caches).
 *
 * @returns number of cache entries removed.
 */
export function invalidateDashboardRouteCaches(
  billingAccountId: string
): number {
  return (
    clearTtlCacheByPrefix(`${OVERVIEW_KEY_PREFIX}${billingAccountId}`) +
    clearTtlCacheByPrefix(`${EXECUTION_KEY_PREFIX}${billingAccountId}`) +
    clearTtlCacheByPrefix(`${BALANCES_KEY_PREFIX}${billingAccountId}`)
  );
}

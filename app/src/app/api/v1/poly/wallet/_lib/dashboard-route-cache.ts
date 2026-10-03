// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/wallet/_lib/dashboard-route-cache`
 * Purpose: Cache keys, TTLs, and invalidation for the coalesced dashboard
 *   route payloads (`/wallet/overview`, `/wallet/execution`) and the
 *   on-chain wallet-balances read. The routes recompute ~7 heavy statements
 *   per request; wrapping the post-auth payload computation in `coalesceSwr`
 *   serves the previous payload instantly on every dashboard tick and kicks
 *   at most one background recompute per key (task.5013; SWR swap in the
 *   dashboard read-path floor fix — the old blocking 5s TTL hit ~0% of the
 *   client's 30s refetch ticks). Balances additionally get their own
 *   longer-TTL entry so a cold route-cache hit does not block first paint
 *   on Polygon RPC (task.5010). The two reads both routes perform
 *   byte-identically (`listTenantPositions`,
 *   `readCurrentWalletPositionModel`) each get ONE shared SWR entry so an
 *   initial page load computes them once, not twice.
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
 *   - ERRORS_NOT_CACHED: `coalesce`/`coalesceSwr` evict rejected fetchers
 *     (FAILED_FETCH_NOT_CACHED), so only successfully computed payloads —
 *     including partial-success payloads that degrade to warnings — are
 *     ever cached. In SWR mode a failed BACKGROUND refresh keeps the
 *     prior stale value (bounded by the stale horizon) and re-arms.
 *   - SWR_TICKS_SERVE_STALE: route payloads + shared reads use
 *     `coalesceSwr` (fresh 20s/15s, stale 5min) so the dashboard's 30s
 *     refetch tick is a stale-serve + one background recompute, never a
 *     blocking recompute. Displayed positions/orders may therefore be up
 *     to one tick older than the DB; POST /wallet/refresh evicts all keys
 *     for users who need synchronous freshness.
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
  coalesceSwr,
} from "@/features/wallet-analysis/server/coalesce";

/**
 * Fresh window for cached dashboard route payloads: a hit younger than
 * this is served with no recompute at all. Chosen below the client's 30s
 * refetch cadence so a manual reload shortly after a tick is still warm,
 * while every 30s tick lands in the stale window (serve-stale + one
 * background recompute) instead of blocking on the ~7-statement payload.
 */
export const DASHBOARD_ROUTE_CACHE_FRESH_MS = 20_000;

/**
 * Serve-stale horizon for route payloads. A hit older than
 * `DASHBOARD_ROUTE_CACHE_FRESH_MS` but younger than this is returned
 * instantly while a single background refresh recomputes; beyond it the
 * entry is dead and the request blocks on a fresh compute. 5min bounds the
 * worst-case display staleness after a quiet period (mirrors the
 * research-read-cache SWR pattern, with much tighter windows).
 */
export const DASHBOARD_ROUTE_CACHE_STALE_MS = 5 * 60_000;

/**
 * TTL for cached on-chain wallet balances (task.5010). Deliberately longer
 * than the route-payload fresh window so a cold/expired route-cache hit is
 * served from warm balances instead of blocking first paint on 3 Polygon
 * RPC calls. 30s staleness is the accepted display bound for wallet
 * cash/gas; POST /wallet/refresh evicts this key for users who need
 * fresher numbers.
 */
export const WALLET_BALANCES_CACHE_TTL_MS = 30_000;

/**
 * Fresh window for the two DB reads shared by BOTH dashboard routes
 * (`listTenantPositions` + `readCurrentWalletPositionModel`). Short —
 * these back real-money position displays — but wide enough that the
 * overview and execution routes' initial-load recomputes (and their
 * background SWR refreshes) reuse one read instead of issuing it twice.
 */
export const DASHBOARD_SHARED_READ_FRESH_MS = 15_000;

/** Serve-stale horizon for the shared reads; same bound as the payloads. */
export const DASHBOARD_SHARED_READ_STALE_MS = 5 * 60_000;

const OVERVIEW_KEY_PREFIX = "route:wallet-overview:";
const EXECUTION_KEY_PREFIX = "route:wallet-execution:";
const BALANCES_KEY_PREFIX = "balances:";
const LEDGER_POSITIONS_KEY_PREFIX = "ledger-positions:";
const CURRENT_POSITIONS_KEY_PREFIX = "current-positions:";
const UNIFIED_DASHBOARD_KEY_PREFIX = "route:wallet-dashboard:";

/** Hard TTL for the coherent snapshot: never serves stale while recomputing. */
export const UNIFIED_DASHBOARD_CACHE_TTL_MS = 15_000;

export function unifiedDashboardCacheKey(
  billingAccountId: string,
  interval: string
): string {
  return `${UNIFIED_DASHBOARD_KEY_PREFIX}${billingAccountId}:${interval}`;
}

export async function coalesceUnifiedDashboard<T>(
  key: string,
  fetcher: () => Promise<T>
): Promise<T> {
  return coalesce(key, fetcher, UNIFIED_DASHBOARD_CACHE_TTL_MS);
}

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

/** Cache key for the tenant's shared `listTenantPositions` ledger read. */
export function tenantLedgerPositionsCacheKey(
  billingAccountId: string
): string {
  return `${LEDGER_POSITIONS_KEY_PREFIX}${billingAccountId}`;
}

/**
 * Cache key for the shared `readCurrentWalletPositionModel` read. Prefixed
 * by billing account (so refresh invalidation can evict by tenant prefix)
 * and suffixed by the wallet address the model is actually keyed on.
 */
export function currentWalletPositionsCacheKey(
  billingAccountId: string,
  walletAddress: string
): string {
  return `${CURRENT_POSITIONS_KEY_PREFIX}${billingAccountId}:${walletAddress.toLowerCase()}`;
}

/**
 * SWR-cache one dashboard route payload (overview or execution). Fresh
 * hits recompute nothing; stale hits (every 30s dashboard tick) serve the
 * previous payload instantly and kick exactly one background recompute;
 * thrown errors are never cached (FAILED_FETCH_NOT_CACHED). Partial-success
 * payloads carrying warnings ARE cached, same as the pre-SWR behavior.
 */
export async function coalesceDashboardRoutePayload<T>(
  key: string,
  fetcher: () => Promise<T>
): Promise<T> {
  return coalesceSwr(key, fetcher, {
    freshMs: DASHBOARD_ROUTE_CACHE_FRESH_MS,
    staleMs: DASHBOARD_ROUTE_CACHE_STALE_MS,
  });
}

/**
 * SWR-cache the tenant's `listTenantPositions` ledger read — the overview
 * and execution routes issue this call byte-identically, so one shared
 * entry halves the DB reads on an initial page load. Callers must not
 * mutate the returned rows (both routes only map them).
 */
export async function coalesceTenantLedgerPositions<T>(
  billingAccountId: string,
  fetcher: () => Promise<T>
): Promise<T> {
  return coalesceSwr(tenantLedgerPositionsCacheKey(billingAccountId), fetcher, {
    freshMs: DASHBOARD_SHARED_READ_FRESH_MS,
    staleMs: DASHBOARD_SHARED_READ_STALE_MS,
  });
}

/**
 * SWR-cache the shared `readCurrentWalletPositionModel` read (same
 * dedupe rationale as `coalesceTenantLedgerPositions`). The cached model
 * bakes in the `capturedAt` of the request that computed it; its
 * staleness fields therefore lag by at most
 * `DASHBOARD_SHARED_READ_FRESH_MS` — negligible against the model's own
 * 10min staleness threshold. Callers must not mutate the returned model.
 */
export async function coalesceCurrentWalletPositions<T>(
  billingAccountId: string,
  walletAddress: string,
  fetcher: () => Promise<T>
): Promise<T> {
  return coalesceSwr(
    currentWalletPositionsCacheKey(billingAccountId, walletAddress),
    fetcher,
    {
      freshMs: DASHBOARD_SHARED_READ_FRESH_MS,
      staleMs: DASHBOARD_SHARED_READ_STALE_MS,
    }
  );
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
 * tenant's cached on-chain balances (task.5010) and the shared
 * ledger-positions / current-positions read entries. Called by
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
    clearTtlCacheByPrefix(`${BALANCES_KEY_PREFIX}${billingAccountId}`) +
    clearTtlCacheByPrefix(`${LEDGER_POSITIONS_KEY_PREFIX}${billingAccountId}`) +
    clearTtlCacheByPrefix(`${CURRENT_POSITIONS_KEY_PREFIX}${billingAccountId}`) +
    clearTtlCacheByPrefix(`${UNIFIED_DASHBOARD_KEY_PREFIX}${billingAccountId}`)
  );
}

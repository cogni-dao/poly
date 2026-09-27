// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/wallet/_lib/dashboard-route-cache`
 * Purpose: Cache keys, TTL, and invalidation for the coalesced dashboard
 *   route payloads (`/wallet/overview`, `/wallet/execution`). Those two
 *   routes recompute ~7 heavy statements per request; wrapping the post-auth
 *   payload computation in `coalesce` collapses a burst of requests into one
 *   computation per key per TTL window (task.5013).
 * Scope: Pure key/TTL helpers over the wallet-analysis process TTL cache.
 *   No IO of its own. Consumed by the overview + execution routes (read
 *   side) and the refresh route (invalidation side).
 * Invariants:
 *   - SINGLE_REPLICA: keys live in the in-process TTL cache (see
 *     `@features/wallet-analysis/server/coalesce`); nothing enforces this
 *     at boot — scaling past one replica degrades to per-replica caches.
 *   - TENANT_KEYED: every key embeds the billing account id, so one
 *     tenant's cached payload can never be served to another tenant.
 *   - ERRORS_NOT_CACHED: `coalesce` evicts rejected fetchers
 *     (FAILED_FETCH_NOT_CACHED), so only successfully computed payloads —
 *     including partial-success payloads that degrade to warnings — are
 *     ever cached.
 *   - REFRESH_INVALIDATES: POST /wallet/refresh calls
 *     `invalidateDashboardRouteCaches` so the next dashboard read
 *     recomputes from the refreshed read models.
 * Side-effects: eviction mutates the shared module-scope TTL cache.
 * Links: src/features/wallet-analysis/server/coalesce.ts
 * @internal
 */

import { clearTtlCacheByPrefix } from "@/features/wallet-analysis/server/coalesce";

/**
 * TTL for cached dashboard route payloads. Short enough that a manual
 * browser reload after ~5s sees fresh data; long enough to absorb the
 * dashboard's parallel-widget request bursts.
 */
export const DASHBOARD_ROUTE_CACHE_TTL_MS = 5_000;

const OVERVIEW_KEY_PREFIX = "route:wallet-overview:";
const EXECUTION_KEY_PREFIX = "route:wallet-execution:";

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

/**
 * Evict every cached dashboard route payload for one tenant. Called by
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
    clearTtlCacheByPrefix(`${EXECUTION_KEY_PREFIX}${billingAccountId}`)
  );
}

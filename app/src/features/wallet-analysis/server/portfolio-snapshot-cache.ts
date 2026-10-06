// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/portfolio-snapshot-cache`
 * Purpose: The ONE cache key, TTL, and coalescer for the coherent portfolio
 *   snapshot. Previously these lived in the dashboard route's `_lib`, which
 *   made the feature layer unable to reach them without importing from
 *   `app/api/**`. The capability-plane handler needs them, so they move down
 *   here and the route `_lib` re-exports them for its existing callers.
 * Scope: Keys and TTL over the shared wallet-analysis TTL cache. No IO, no
 *   authorization, no HTTP.
 * Invariants:
 *   - TENANT_KEYED: the billing account id is the first key segment, so one
 *     tenant's cached snapshot can never be served to another tenant, and
 *     `clearTtlCacheByPrefix(prefix + accountId)` evicts exactly one tenant.
 *   - AUTHORIZE_BEFORE_CACHE: nothing here authorizes anything, and nothing
 *     here is reachable from a transport. The only caller is the account-read
 *     handler, which the capability-plane executor invokes strictly AFTER
 *     `authorize()` has returned an allow (DISPATCH_ORDER_IS_THE_CONTRACT).
 *     The account id used in the key is the one the executor authorized.
 *   - NO_PRINCIPAL_SPECIFIC_FIELDS: the cached payload is saved facts plus the
 *     deployment-level `configured`/`actionsAllowed` affordances. It carries no
 *     principal id, no access kind, and no grant id, which is what makes it
 *     safe to share one entry between the owner session and a delegated agent
 *     — and is incidentally the strongest possible parity guarantee, since
 *     both principals are then served literally identical bytes.
 *   - HARD_TTL_NEVER_STALE: `coalesce` (not `coalesceSwr`). A coherent
 *     money snapshot is never served past its TTL while a refresh runs.
 * Side-effects: mutates the shared module-scope TTL cache.
 * Links: task.1791070962, @features/wallet-analysis/server/coalesce
 * @public
 */

import { coalesce } from "./coalesce";

/**
 * Key prefix. Unchanged from the route `_lib` original so
 * `invalidateDashboardRouteCaches` — and therefore `POST /wallet/refresh` —
 * keeps evicting these entries.
 */
export const PORTFOLIO_SNAPSHOT_KEY_PREFIX = "route:wallet-dashboard:";

/** Hard TTL for the coherent snapshot: never serves stale while recomputing. */
export const PORTFOLIO_SNAPSHOT_CACHE_TTL_MS = 15_000;

/**
 * Both the interval and the account are part of the key: the interval selects
 * the persisted P/L window, so two intervals are genuinely different snapshots.
 */
export function portfolioSnapshotCacheKey(
  billingAccountId: string,
  interval: string
): string {
  return `${PORTFOLIO_SNAPSHOT_KEY_PREFIX}${billingAccountId}:${interval}`;
}

/** Prefix that evicts every cached snapshot for one tenant. */
export function portfolioSnapshotTenantKeyPrefix(
  billingAccountId: string
): string {
  return `${PORTFOLIO_SNAPSHOT_KEY_PREFIX}${billingAccountId}`;
}

/**
 * Coalesce + cache one tenant's snapshot. Concurrent callers for the same
 * account+interval share one computation (CONCURRENT_DEDUP) and a thrown
 * fetcher is never cached (FAILED_FETCH_NOT_CACHED).
 */
export async function coalescePortfolioSnapshot<T>(
  billingAccountId: string,
  interval: string,
  fetcher: () => Promise<T>
): Promise<T> {
  return coalesce(
    portfolioSnapshotCacheKey(billingAccountId, interval),
    fetcher,
    PORTFOLIO_SNAPSHOT_CACHE_TTL_MS
  );
}

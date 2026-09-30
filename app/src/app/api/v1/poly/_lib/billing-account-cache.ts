// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/_lib/billing-account-cache`
 * Purpose: Short-TTL in-process userId→billingAccountId resolution for the
 *   poly dashboard read routes. Pre-fix, every poly route ran
 *   `getOrCreateBillingAccountForUser` before its payload cache — 5 DB
 *   round-trips (BEGIN + SET LOCAL + SELECT billing_accounts + SELECT
 *   virtual_keys + COMMIT) per request even on a warm cache hit. This
 *   helper collapses that to 0 round-trips on a warm hit and 1 on a cold
 *   hit (single transaction-free SELECT via
 *   `ServiceAccountService.findBillingAccountIdForUser`); the full
 *   transactional CREATE path runs only when the user genuinely has no
 *   billing account yet.
 * Scope: Read-path resolution only. Mutating wallet routes (connect,
 *   withdraw, refresh, …) keep the original uncached floor.
 * Invariants:
 *   - IDENTITY_IS_IMMUTABLE: a user's billing-account id never changes —
 *     `billing_accounts.owner_user_id` is written once at create and no
 *     code path updates it (all `UPDATE billing_accounts` statements touch
 *     `balance_credits` only) or deletes the row. Caching the id therefore
 *     needs NO invalidation hook; the TTL exists purely to bound memory
 *     and self-heal if that ever changes.
 *   - SINGLE_FLIGHT: concurrent requests for one user share one resolution
 *     (delegates to `coalesce`'s CONCURRENT_DEDUP).
 *   - CREATE_ONLY_ON_MISS: the transactional create branch runs only after
 *     the plain SELECT misses, so steady-state requests never open a
 *     transaction here.
 *   - SINGLE_REPLICA: in-process cache; >1 replica just lowers hit rate.
 * Side-effects: none of its own (delegates to the wallet-analysis
 *   module-scope TTL cache; DB IO happens inside the injected services).
 * Links: src/features/wallet-analysis/server/coalesce.ts,
 *   src/ports/accounts.port.ts
 * @internal
 */

import { coalesce } from "@/features/wallet-analysis/server/coalesce";
import type { ServiceAccountService } from "@/ports";

/**
 * TTL for the userId→billingAccountId entry. Identity is immutable (see
 * IDENTITY_IS_IMMUTABLE) so this could be ∞; 60s keeps the module-scope
 * Map bounded and any unforeseen account surgery self-healing.
 */
export const BILLING_ACCOUNT_ID_CACHE_TTL_MS = 60_000;

const BILLING_ACCOUNT_KEY_PREFIX = "billing-account-id:";

/** Cache key for one user's billing-account id. */
export function billingAccountIdCacheKey(userId: string): string {
  return `${BILLING_ACCOUNT_KEY_PREFIX}${userId}`;
}

type BillingAccountResolver = Pick<
  ServiceAccountService,
  "findBillingAccountIdForUser" | "getOrCreateBillingAccountForUser"
>;

/**
 * Resolve the caller's billing-account id with the read-optimized floor:
 * warm hit → 0 DB round-trips; cold hit → 1 (plain SELECT, no
 * transaction, no `virtual_keys`); genuine first-ever request → the full
 * idempotent create (same path the mutating routes use, via
 * `ServiceAccountService` — precedent: `/api/v1/agent/register`).
 */
export async function resolveBillingAccountId(
  accounts: BillingAccountResolver,
  userId: string
): Promise<string> {
  return coalesce(
    billingAccountIdCacheKey(userId),
    async () => {
      const existing = await accounts.findBillingAccountIdForUser(userId);
      if (existing !== null) return existing;
      const created = await accounts.getOrCreateBillingAccountForUser({
        userId,
      });
      return created.id;
    },
    BILLING_ACCOUNT_ID_CACHE_TTL_MS
  );
}

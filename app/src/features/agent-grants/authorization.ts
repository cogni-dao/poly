// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/agent-grants/authorization`
 * Purpose: The ONE authorization decision for every delegated account read.
 *   `authorize()` answers "may this principal read this billing account under
 *   this scope?" for owner sessions, approved external agents, and internal
 *   agents alike.
 * Scope: Read-only authorization seam. The caller must provide an app-role
 *   transaction whose tenant context is already set to the same principal.
 * Invariants:
 *   - ONE_AUTHORIZE_FN: no other module may decide account read access. Swap
 *     the substrate (OpenFGA is a named future story) behind this function.
 *   - SCOPE_ALIAS_TOLERANCE: `account:read` is canonical; `performance:read`
 *     is its retained legacy alias. A grant holding EITHER name authorizes
 *     EITHER name, matched by array OVERLAP (`&&`) — never containment (`@>`).
 *     The delegated SELECT policies on
 *     poly_copy_trade_{fills,decisions,targets} use the same overlap against
 *     the same alias set, so the app check and RLS can never disagree about
 *     which name counts (migration 0074).
 *   - RLS_BACKSTOP: both ownership and delegation reads remain RLS-clamped.
 *     An allow here is necessary, never sufficient.
 *   - FAIL_CLOSED: missing, expired, revoked, or wrong-scope grants return
 *     null, which every transport renders as the same non-disclosing 404.
 *   - NEVER_CACHED: access decisions are recomputed per request. Callers must
 *     authorize before touching any account-keyed cache.
 * Side-effects: IO (bounded Postgres reads)
 * Links: story.5006, task.1791070961, app/src/features/capability-plane
 * @public
 */

import type { Database } from "@cogni/db-client";
import { agentCapabilityGrants, billingAccounts } from "@cogni/db-schema";
import type { AgentCapabilityScope } from "@cogni/poly-node-contracts";
import { and, arrayOverlaps, eq, gt, isNull, sql } from "drizzle-orm";

export type AgentGrantTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export type AccountReadAccess = {
  accessKind: "owner" | "delegated";
  grantId: string | null;
};

/**
 * Scope aliases that are mutually interchangeable during the expand phase of
 * the `performance:read` -> `account:read` rename (story.5006).
 *
 * Holding any member of a set satisfies a requirement for any other member.
 * Deliberately NOT a general-purpose scope hierarchy: this is a rename
 * compatibility table that the contract-phase task deletes.
 */
const SCOPE_ALIAS_SETS: readonly (readonly AgentCapabilityScope[])[] = [
  ["account:read", "performance:read"],
];

/**
 * Every scope name that satisfies `requiredScope`, including itself.
 * Used for both the app-side grant lookup and the RLS policy bodies.
 */
export function aliasesFor(
  requiredScope: AgentCapabilityScope
): readonly AgentCapabilityScope[] {
  const set = SCOPE_ALIAS_SETS.find((candidate) =>
    candidate.includes(requiredScope)
  );
  return set ?? [requiredScope];
}

/**
 * The single account-read authorization decision.
 *
 * Returns `owner` when the principal owns the account, `delegated` when an
 * active non-revoked unexpired grant carries `requiredScope` (or one of its
 * aliases), and `null` for every denial — cross-tenant, unknown account,
 * revoked, expired, and wrong-scope are indistinguishable by design.
 */
export async function authorize(
  tx: AgentGrantTransaction,
  input: {
    principalId: string;
    accountId: string;
    requiredScope: AgentCapabilityScope;
  }
): Promise<AccountReadAccess | null> {
  const [ownedAccount] = await tx
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(
      and(
        eq(billingAccounts.id, input.accountId),
        eq(billingAccounts.ownerUserId, input.principalId)
      )
    )
    .limit(1);

  if (ownedAccount) {
    return { accessKind: "owner", grantId: null };
  }

  const [grant] = await tx
    .select({ id: agentCapabilityGrants.id })
    .from(agentCapabilityGrants)
    .where(
      and(
        eq(agentCapabilityGrants.billingAccountId, input.accountId),
        eq(agentCapabilityGrants.granteePrincipalId, input.principalId),
        isNull(agentCapabilityGrants.revokedAt),
        gt(agentCapabilityGrants.expiresAt, sql`now()`),
        // OVERLAP, not containment: the grant needs ANY alias of the required
        // scope, exactly matching the RLS policy bodies in migration 0074.
        arrayOverlaps(agentCapabilityGrants.scopes, [
          ...aliasesFor(input.requiredScope),
        ])
      )
    )
    .limit(1);

  return grant ? { accessKind: "delegated", grantId: grant.id } : null;
}

/**
 * The billing account the principal owns, for operations whose descriptor
 * declares `accountFrom: "principal"` (no account id on the wire).
 *
 * Returns null when the principal owns no account, which the executor renders
 * as the same non-disclosing denial.
 */
export async function resolvePrincipalAccountId(
  tx: AgentGrantTransaction,
  principalId: string
): Promise<string | null> {
  const [owned] = await tx
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(eq(billingAccounts.ownerUserId, principalId))
    .limit(1);
  return owned?.id ?? null;
}

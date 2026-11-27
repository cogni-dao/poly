// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/agent-grants/authorization`
 * Purpose: The ONE authorization decision for every delegated account read.
 *   `authorize()` answers "may this principal read this billing account under
 *   `account:read`?" for owner sessions, approved external agents, and internal
 *   agents alike.
 * Scope: Read-only seam over the shared grant plane. A delegated grant is one
 *   `agent_roles` row (`resource = 'account'`) of `@cogni/agent-grants`; the
 *   live test is its SQL function `agent_has_scope(account, scope)`, the same
 *   function the delegated SELECT policies call (migration 0093). The caller
 *   must provide an app-role transaction whose tenant context is already set
 *   to the same principal.
 * Invariants:
 *   - ONE_AUTHORIZE_FN: no other module may decide account read access.
 *   - ONE_LIVE_PREDICATE: this file never restates what "live" means. It asks
 *     `agent_has_scope()`, so the app check and row-level security cannot
 *     disagree ("zero rows" instead of "denied").
 *   - RLS_BACKSTOP: both ownership and delegation reads remain RLS-clamped.
 *     An allow here is necessary, never sufficient.
 *   - FAIL_CLOSED: missing, expired, revoked, and wrong-scope grants return
 *     null, which every transport renders as the same non-disclosing 404.
 *   - NEVER_CACHED: access decisions are recomputed per request. Callers must
 *     authorize before touching any account-keyed cache.
 *   - NO_ALIAS: `performance:read` is gone; migration 0093 copied every legacy
 *     grant forward as `account:read`.
 * Side-effects: IO (bounded Postgres reads)
 * Links: story.0090, https://node-template.cognidao.org/knowledge/grant-account-outside-ai, app/src/features/capability-plane
 * @public
 */

import type { Database } from "@cogni/db-client";
import { billingAccounts } from "@cogni/db-schema";
import { ACCOUNT_READ_SCOPE } from "@cogni/poly-node-contracts";
import { and, eq, sql } from "drizzle-orm";

export type AgentGrantTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export type AccountReadAccess = {
  accessKind: "owner" | "delegated";
  /** The `agent_roles` row that opened a delegated read; null for the owner. */
  grantId: string | null;
};

/** `tx.execute()` returns a bare array on postgres-js and `{ rows }` on node-postgres. */
const rowsOf = <T>(result: unknown): T[] =>
  Array.isArray(result)
    ? (result as T[])
    : (((result as { rows?: T[] }).rows ?? []) as T[]);

/**
 * The single account-read authorization decision.
 *
 * Returns `owner` when the principal owns the account, `delegated` when the
 * principal holds a live `account:read` row for exactly this account, and
 * `null` for every denial: cross-tenant, unknown account, revoked, expired and
 * wrong-scope are indistinguishable by design.
 */
export async function authorize(
  tx: AgentGrantTransaction,
  input: {
    principalId: string;
    accountId: string;
    requiredScope: typeof ACCOUNT_READ_SCOPE;
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

  // The row-level policy `agent_roles_account_self_read` shows this connection
  // only its own account rows; `agent_has_scope()` is the live test.
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT r.id
      FROM agent_roles r
      WHERE r.resource = 'account'
        AND r.account_id = ${input.accountId}
        AND r.scope = ${input.requiredScope}
        AND agent_has_scope(${input.accountId}, ${input.requiredScope})
      ORDER BY (r.revoked_at IS NULL) DESC, r.created_at DESC
      LIMIT 1
    `)
  );
  const row = rows[0];
  return row ? { accessKind: "delegated", grantId: row.id } : null;
}

/**
 * The account a `accountFrom: "principal"` operation is ABOUT, when no account
 * id appears on the wire.
 *
 * SUBJECT_IS_NOT_CALLER: "the principal's account" is NOT "the account the
 * principal owns". Every agent minted by POST /api/v1/agent/register owns a
 * billing account of its own, so resolving by ownership would hand a delegated
 * agent its OWN (empty) account, authorize it as `owner`, and return a 200 full
 * of zeroes — never the account the human actually granted, and never a denial.
 * That is precisely the fabricated-balance failure this plane exists to remove.
 *
 * Semantics: collect every account this principal can reach for this scope —
 * those behind a live grant, plus the one it owns.
 *   - exactly one  -> `resolved`. The human-owner case (no grants), and an
 *     agent with a single grant and no account of its own.
 *   - more than one -> `ambiguous`. NEVER guess which account was meant. A
 *     delegated agent typically has two (its own, plus the granted one), so
 *     guessing is how a caller silently reads the wrong tenant. The caller must
 *     name the account explicitly; agent transports therefore declare
 *     `accountFrom: "input"` and agents learn the id from their own access list
 *     (`GET /api/v1/agent/access-requests`).
 *   - none -> `none`, which the executor renders as the same non-disclosing
 *     denial as any other failure.
 *
 * Fail loudly over conveniently: an `ambiguous` 400 telling the caller to name
 * the account is strictly better than a 200 describing an account it did not
 * ask about.
 */
export type SubjectAccountResolution =
  | { kind: "resolved"; accountId: string }
  | { kind: "ambiguous"; accountIds: readonly string[] }
  | { kind: "none" };

export async function resolveSubjectAccountId(
  tx: AgentGrantTransaction,
  input: { principalId: string; requiredScope: typeof ACCOUNT_READ_SCOPE }
): Promise<SubjectAccountResolution> {
  const granted = rowsOf<{ account_id: string }>(
    await tx.execute(sql`
      SELECT DISTINCT r.account_id
      FROM agent_roles r
      WHERE r.resource = 'account'
        AND r.scope = ${input.requiredScope}
        AND r.account_id IS NOT NULL
        AND agent_has_scope(r.account_id, ${input.requiredScope})
    `)
  );

  const owned = await resolvePrincipalAccountId(tx, input.principalId);
  const candidates = [
    ...new Set([...granted.map((row) => row.account_id), ...(owned ? [owned] : [])]),
  ];

  if (candidates.length === 1) {
    return { kind: "resolved", accountId: candidates[0] as string };
  }
  if (candidates.length > 1) {
    return { kind: "ambiguous", accountIds: candidates };
  }
  return { kind: "none" };
}

/**
 * The billing account the principal OWNS. Prefer `resolveSubjectAccountId` for
 * capability dispatch — see SUBJECT_IS_NOT_CALLER above.
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

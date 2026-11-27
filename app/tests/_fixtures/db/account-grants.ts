// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/_fixtures/db/account-grants`
 * Purpose: Seed and remove the shared account grant (`agent_roles`, `resource = 'account'`) for component tests, through a service-role (BYPASSRLS) handle.
 * Scope: Test fixture only. Poly has no grant table of its own any more (migration 0093); a delegated read is one `agent_roles` row, written by the package in production.
 * Invariants: Every seeded row satisfies the table's CHECKs (an approver that is not the principal; an end date after `granted_at`).
 * Side-effects: IO (test database)
 * @internal
 */

import { type SQL, sql } from "drizzle-orm";

/** Any drizzle handle that can run raw SQL as the service role (it bypasses row-level security). */
type ServiceDb = { execute: (query: SQL) => PromiseLike<unknown> };

export type SeedAccountGrant = {
  principalId: string;
  accountId: string;
  /** The account owner: the approver. */
  approvedBy: string;
  scope?: string;
  /** `null` is a grant with no end date (the package default). */
  expiresAt?: Date | null;
  /** Defaults to now; set it in the past to seed an expired row (the end date must be later). */
  grantedAt?: Date;
  revokedAt?: Date | null;
};

/** Insert one live (or expired, or revoked) account grant. Returns the row id. */
export async function seedAccountGrant(
  db: ServiceDb,
  grant: SeedAccountGrant
): Promise<string> {
  const grantedAt = grant.grantedAt ?? new Date();
  const result = (await db.execute(sql`
    INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, account_id, expires_at, revoked_at)
    VALUES (${grant.principalId}, ${grant.scope ?? "account:read"}, ${grant.approvedBy}, ${grantedAt.toISOString()}::timestamptz, 'account',
            ${grant.accountId}, ${grant.expiresAt ? grant.expiresAt.toISOString() : null}::timestamptz,
            ${grant.revokedAt ? grant.revokedAt.toISOString() : null}::timestamptz)
    RETURNING id
  `)) as Array<{ id: string }> | { rows: Array<{ id: string }> };
  const rows = Array.isArray(result) ? result : result.rows;
  const id = rows[0]?.id;
  if (!id) throw new Error("seedAccountGrant: no row returned");
  return id;
}

/** Remove every account grant on the given accounts (test cleanup). */
export async function deleteAccountGrants(
  db: ServiceDb,
  accountIds: readonly string[]
): Promise<void> {
  if (accountIds.length === 0) return;
  await db.execute(
    sql`DELETE FROM agent_roles WHERE resource = 'account' AND account_id IN (${sql.join(
      accountIds.map((id) => sql`${id}`),
      sql`, `
    )})`
  );
}

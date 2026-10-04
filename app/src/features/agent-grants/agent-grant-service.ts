// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/agent-grants/agent-grant-service`
 * Purpose: Owner-scoped lifecycle operations for expiring capability grants.
 * Scope: Transaction-local Postgres reads/writes; HTTP and logging live above.
 * Invariants:
 *   - OWNER_ONLY: explicit owner predicates complement database RLS.
 *   - ATOMIC_REPLACE: create revokes the prior current grant and inserts its
 *     replacement in the caller's existing transaction.
 *   - SOFT_REVOKE: rows are never deleted.
 * Side-effects: IO (Postgres)
 * @public
 */

import {
  agentCapabilityGrants,
  billingAccounts,
  type AgentCapabilityGrantRow,
} from "@cogni/db-schema";
import type {
  AgentCapabilityGrant,
  PolyAgentGrantsCreateInput,
} from "@cogni/poly-node-contracts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { AgentGrantTransaction } from "./authorization";

export class AgentGrantInvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGrantInvalidRequestError";
  }
}

function toIso(value: Date | string): string {
  return typeof value === "string"
    ? new Date(value).toISOString()
    : value.toISOString();
}

export function agentGrantRowToContract(
  row: AgentCapabilityGrantRow
): AgentCapabilityGrant {
  return {
    id: row.id,
    billing_account_id: row.billingAccountId,
    grantee_principal_id: row.granteePrincipalId,
    scopes: row.scopes as AgentCapabilityGrant["scopes"],
    expires_at: toIso(row.expiresAt),
    created_by_user_id: row.createdByUserId,
    revoked_at: row.revokedAt ? toIso(row.revokedAt) : null,
    revoked_by_user_id: row.revokedByUserId,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
  };
}

export async function listOwnedAgentGrants(
  tx: AgentGrantTransaction,
  principalId: string
): Promise<AgentCapabilityGrant[]> {
  const rows = await tx
    .select({ grant: agentCapabilityGrants })
    .from(agentCapabilityGrants)
    .innerJoin(
      billingAccounts,
      eq(agentCapabilityGrants.billingAccountId, billingAccounts.id)
    )
    .where(eq(billingAccounts.ownerUserId, principalId))
    .orderBy(desc(agentCapabilityGrants.createdAt));

  return rows.map(({ grant }) => agentGrantRowToContract(grant));
}

export async function replaceOwnedAgentGrant(
  tx: AgentGrantTransaction,
  principalId: string,
  input: PolyAgentGrantsCreateInput
): Promise<AgentCapabilityGrant | null> {
  const expiresAt = new Date(input.expires_at);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now()
  ) {
    throw new AgentGrantInvalidRequestError("expires_at must be in the future");
  }

  const [ownedAccount] = await tx
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(
      and(
        eq(billingAccounts.id, input.billing_account_id),
        eq(billingAccounts.ownerUserId, principalId)
      )
    )
    .limit(1);
  if (!ownedAccount) return null;

  await tx
    .update(agentCapabilityGrants)
    .set({
      revokedAt: sql`now()`,
      revokedByUserId: principalId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(agentCapabilityGrants.billingAccountId, input.billing_account_id),
        eq(
          agentCapabilityGrants.granteePrincipalId,
          input.grantee_principal_id
        ),
        isNull(agentCapabilityGrants.revokedAt)
      )
    );

  const [created] = await tx
    .insert(agentCapabilityGrants)
    .values({
      billingAccountId: input.billing_account_id,
      granteePrincipalId: input.grantee_principal_id,
      scopes: input.scopes,
      expiresAt,
      createdByUserId: principalId,
    })
    .returning();

  return created ? agentGrantRowToContract(created) : null;
}

export async function revokeOwnedAgentGrant(
  tx: AgentGrantTransaction,
  principalId: string,
  grantId: string
): Promise<AgentCapabilityGrant | null> {
  const [revoked] = await tx
    .update(agentCapabilityGrants)
    .set({
      revokedAt: sql`now()`,
      revokedByUserId: principalId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(agentCapabilityGrants.id, grantId),
        isNull(agentCapabilityGrants.revokedAt),
        sql`${agentCapabilityGrants.billingAccountId} IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = ${principalId}
        )`
      )
    )
    .returning();

  return revoked ? agentGrantRowToContract(revoked) : null;
}

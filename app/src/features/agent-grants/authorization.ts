// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/agent-grants/authorization`
 * Purpose: Resolve whether an authenticated principal may read one billing
 *   account's saved performance data.
 * Scope: Read-only authorization seam. The caller must provide an app-role
 *   transaction whose tenant context is set to the same principal.
 * Invariants:
 *   - PERFORMANCE_READ_ONLY: Story 1 consumes only `performance:read`.
 *   - RLS_BACKSTOP: both ownership and delegation reads remain RLS-clamped.
 *   - FAIL_CLOSED: missing, expired, revoked, or wrong-scope grants return null.
 * Side-effects: IO (bounded Postgres reads)
 * @public
 */

import type { Database } from "@cogni/db-client";
import {
  agentCapabilityGrants,
  billingAccounts,
} from "@cogni/db-schema";
import { and, arrayContains, eq, gt, isNull, sql } from "drizzle-orm";

export type AgentGrantTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export type PerformanceReadAccess = {
  accessKind: "owner" | "delegated";
  grantId: string | null;
};

export async function resolvePerformanceRead(
  tx: AgentGrantTransaction,
  input: { principalId: string; billingAccountId: string }
): Promise<PerformanceReadAccess | null> {
  const [ownedAccount] = await tx
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(
      and(
        eq(billingAccounts.id, input.billingAccountId),
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
        eq(agentCapabilityGrants.billingAccountId, input.billingAccountId),
        eq(agentCapabilityGrants.granteePrincipalId, input.principalId),
        isNull(agentCapabilityGrants.revokedAt),
        gt(agentCapabilityGrants.expiresAt, sql`now()`),
        arrayContains(agentCapabilityGrants.scopes, ["performance:read"])
      )
    )
    .limit(1);

  return grant
    ? { accessKind: "delegated", grantId: grant.id }
    : null;
}

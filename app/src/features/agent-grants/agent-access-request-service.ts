// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/agent-grants/agent-access-request-service`
 * Purpose: Persist self-requested capability approval and bind browser-owner
 *   decisions atomically to the existing capability grant authority.
 * Scope: App-role transaction-local reads/writes. HTTP, randomness, and logs
 *   live in the facade.
 * Invariants: raw tokens never persist; requester/account identities derive
 *   from authentication; approval and grant creation share one transaction.
 * Side-effects: IO (Postgres)
 * @public
 */

import {
  agentAccessRequests,
  agentCapabilityGrants,
  billingAccounts,
  type AgentAccessRequestRow,
} from "@cogni/db-schema";
import type {
  AgentAccessRequestAgent,
  AgentAccessRequestLifecycleStatus,
  AgentAccessRequestOwner,
  PolyAgentAccessRequestCreateInput,
  PolyAgentAccessRequestDecisionInput,
} from "@cogni/poly-node-contracts";
import { and, desc, eq, gt, isNotNull, lte, sql } from "drizzle-orm";

import type { AgentGrantTransaction } from "./authorization";
import { replaceOwnedAgentGrant } from "./agent-grant-service";

const PERFORMANCE_READ_SCOPE = "performance:read" as const;
const MAX_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type GrantLifecycle = {
  expiresAt: Date | string;
  revokedAt: Date | string | null;
};

type RequestWithGrant = {
  request: AgentAccessRequestRow;
  grant: GrantLifecycle | null;
};

export class AgentAccessRequestInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAccessRequestInvalidError";
  }
}

export class AgentAccessRequestConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAccessRequestConflictError";
  }
}

function toIso(value: Date | string): string {
  return typeof value === "string"
    ? new Date(value).toISOString()
    : value.toISOString();
}

function toDate(value: Date | string): Date {
  return typeof value === "string" ? new Date(value) : value;
}

function lifecycleStatus(
  row: AgentAccessRequestRow,
  grant: GrantLifecycle | null,
  now: Date
): AgentAccessRequestLifecycleStatus {
  if (row.status === "denied") return "denied";
  if (row.status === "revoked" || grant?.revokedAt) return "revoked";
  if (row.status === "expired") return "expired";
  if (row.status === "pending") {
    return toDate(row.approvalTokenExpiresAt) <= now ||
      toDate(row.grantExpiresAt) <= now
      ? "expired"
      : "pending";
  }
  return !grant || toDate(grant.expiresAt) <= now ? "expired" : "active";
}

export function accessRequestToOwnerContract(
  entry: RequestWithGrant,
  now = new Date()
): AgentAccessRequestOwner {
  return {
    id: entry.request.id,
    agent_display_name: entry.request.requesterDisplayName,
    scope: PERFORMANCE_READ_SCOPE,
    expires_at: toIso(entry.request.grantExpiresAt),
    requested_at: toIso(entry.request.createdAt),
    decided_at: entry.request.decidedAt
      ? toIso(entry.request.decidedAt)
      : null,
    status: lifecycleStatus(entry.request, entry.grant, now),
    grant_id: entry.request.approvedGrantId,
  };
}

export function accessRequestToAgentContract(
  entry: RequestWithGrant,
  now = new Date()
): AgentAccessRequestAgent {
  const wasApproved = entry.request.approvedGrantId !== null;
  return {
    id: entry.request.id,
    scope: PERFORMANCE_READ_SCOPE,
    expires_at: toIso(entry.request.grantExpiresAt),
    requested_at: toIso(entry.request.createdAt),
    decided_at: entry.request.decidedAt
      ? toIso(entry.request.decidedAt)
      : null,
    status: lifecycleStatus(entry.request, entry.grant, now),
    billing_account_id: wasApproved
      ? entry.request.billingAccountId
      : null,
  };
}

export async function setAgentAccessTokenContext(
  tx: AgentGrantTransaction,
  tokenHash: string
): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('app.agent_access_request_token_hash', ${tokenHash}, true)`
  );
}

export async function createAgentAccessRequest(
  tx: AgentGrantTransaction,
  input: {
    principalId: string;
    displayName: string;
    request: PolyAgentAccessRequestCreateInput;
    tokenHash: string;
    tokenExpiresAt: Date;
    now: Date;
  }
): Promise<AgentAccessRequestAgent> {
  const grantExpiresAt = new Date(input.request.expires_at);
  if (
    !Number.isFinite(grantExpiresAt.getTime()) ||
    grantExpiresAt <= input.now ||
    grantExpiresAt.getTime() - input.now.getTime() > MAX_GRANT_TTL_MS
  ) {
    throw new AgentAccessRequestInvalidError(
      "expires_at must be within the next 30 days"
    );
  }

  await tx
    .update(agentAccessRequests)
    .set({ status: "expired", updatedAt: input.now })
    .where(
      and(
        eq(agentAccessRequests.requesterPrincipalId, input.principalId),
        eq(agentAccessRequests.status, "pending"),
        lte(agentAccessRequests.approvalTokenExpiresAt, input.now)
      )
    );

  const [pending] = await tx
    .select({ id: agentAccessRequests.id })
    .from(agentAccessRequests)
    .where(
      and(
        eq(agentAccessRequests.requesterPrincipalId, input.principalId),
        eq(agentAccessRequests.status, "pending")
      )
    )
    .limit(1);
  if (pending) {
    throw new AgentAccessRequestConflictError(
      "A pending access request already exists"
    );
  }

  const [created] = await tx
    .insert(agentAccessRequests)
    .values({
      requesterPrincipalId: input.principalId,
      requesterDisplayName: input.displayName,
      requestedScopes: [PERFORMANCE_READ_SCOPE],
      grantExpiresAt,
      approvalTokenHash: input.tokenHash,
      approvalTokenExpiresAt: input.tokenExpiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!created) throw new Error("Agent access request insert returned no row");
  return accessRequestToAgentContract(
    { request: created, grant: null },
    input.now
  );
}

export async function pollAgentAccessRequest(
  tx: AgentGrantTransaction,
  principalId: string,
  requestId: string,
  now = new Date()
): Promise<AgentAccessRequestAgent | null> {
  const [entry] = await tx
    .select({
      request: agentAccessRequests,
      grant: {
        expiresAt: agentCapabilityGrants.expiresAt,
        revokedAt: agentCapabilityGrants.revokedAt,
      },
    })
    .from(agentAccessRequests)
    .leftJoin(
      agentCapabilityGrants,
      eq(agentAccessRequests.approvedGrantId, agentCapabilityGrants.id)
    )
    .where(
      and(
        eq(agentAccessRequests.id, requestId),
        eq(agentAccessRequests.requesterPrincipalId, principalId)
      )
    )
    .limit(1);
  return entry ? accessRequestToAgentContract(entry, now) : null;
}

export async function previewAgentAccessRequest(
  tx: AgentGrantTransaction,
  tokenHash: string,
  now = new Date()
): Promise<AgentAccessRequestOwner | null> {
  await setAgentAccessTokenContext(tx, tokenHash);
  const [request] = await tx
    .select()
    .from(agentAccessRequests)
    .where(
      and(
        eq(agentAccessRequests.approvalTokenHash, tokenHash),
        eq(agentAccessRequests.status, "pending"),
        gt(agentAccessRequests.approvalTokenExpiresAt, now),
        gt(agentAccessRequests.grantExpiresAt, now)
      )
    )
    .limit(1);
  return request
    ? accessRequestToOwnerContract({ request, grant: null }, now)
    : null;
}

export async function decideAgentAccessRequest(
  tx: AgentGrantTransaction,
  input: {
    ownerPrincipalId: string;
    requestId: string;
    tokenHash: string;
    decision: PolyAgentAccessRequestDecisionInput["decision"];
    now: Date;
  }
): Promise<AgentAccessRequestOwner | null> {
  await setAgentAccessTokenContext(tx, input.tokenHash);
  const [request] = await tx
    .select()
    .from(agentAccessRequests)
    .where(
      and(
        eq(agentAccessRequests.id, input.requestId),
        eq(agentAccessRequests.approvalTokenHash, input.tokenHash),
        eq(agentAccessRequests.status, "pending"),
        gt(agentAccessRequests.approvalTokenExpiresAt, input.now),
        gt(agentAccessRequests.grantExpiresAt, input.now)
      )
    )
    .limit(1)
    .for("update");
  if (!request) return null;

  const [ownedAccount] = await tx
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(eq(billingAccounts.ownerUserId, input.ownerPrincipalId))
    .limit(1);
  if (!ownedAccount) return null;

  if (input.decision === "deny") {
    const [denied] = await tx
      .update(agentAccessRequests)
      .set({
        status: "denied",
        billingAccountId: ownedAccount.id,
        decisionByUserId: input.ownerPrincipalId,
        decidedAt: input.now,
        tokenConsumedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(agentAccessRequests.id, request.id),
          eq(agentAccessRequests.status, "pending")
        )
      )
      .returning();
    if (!denied) {
      throw new AgentAccessRequestConflictError(
        "Access request was concurrently decided"
      );
    }
    return accessRequestToOwnerContract(
      { request: denied, grant: null },
      input.now
    );
  }

  const grant = await replaceOwnedAgentGrant(tx, input.ownerPrincipalId, {
    billing_account_id: ownedAccount.id,
    grantee_principal_id: request.requesterPrincipalId,
    scopes: [PERFORMANCE_READ_SCOPE],
    expires_at: toIso(request.grantExpiresAt),
  });
  if (!grant) {
    throw new AgentAccessRequestConflictError(
      "Grant creation did not finalize"
    );
  }

  const [approved] = await tx
    .update(agentAccessRequests)
    .set({
      status: "approved",
      billingAccountId: ownedAccount.id,
      approvedGrantId: grant.id,
      decisionByUserId: input.ownerPrincipalId,
      decidedAt: input.now,
      tokenConsumedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(agentAccessRequests.id, request.id),
        eq(agentAccessRequests.status, "pending")
      )
    )
    .returning();
  if (!approved) {
    // Throw so the surrounding transaction rolls back the grant insert.
    throw new AgentAccessRequestConflictError(
      "Access request was concurrently decided"
    );
  }
  return accessRequestToOwnerContract(
    {
      request: approved,
      grant: { expiresAt: grant.expires_at, revokedAt: grant.revoked_at },
    },
    input.now
  );
}

export async function listOwnerAgentAccessRequests(
  tx: AgentGrantTransaction,
  ownerPrincipalId: string,
  now = new Date()
): Promise<AgentAccessRequestOwner[]> {
  const rows = await tx
    .select({
      request: agentAccessRequests,
      grant: {
        expiresAt: agentCapabilityGrants.expiresAt,
        revokedAt: agentCapabilityGrants.revokedAt,
      },
    })
    .from(agentAccessRequests)
    .leftJoin(
      agentCapabilityGrants,
      eq(agentAccessRequests.approvedGrantId, agentCapabilityGrants.id)
    )
    .where(
      and(
        isNotNull(agentAccessRequests.billingAccountId),
        sql`${agentAccessRequests.billingAccountId} IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = ${ownerPrincipalId}
        )`
      )
    )
    .orderBy(desc(agentAccessRequests.createdAt));
  return rows.map((entry) => accessRequestToOwnerContract(entry, now));
}

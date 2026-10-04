// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/poly/agent-grants.server`
 * Purpose: Bind authenticated principals and app-role tenant transactions to
 *   the agent-grant lifecycle service.
 * Scope: Dependency resolution, DTO orchestration, error normalization, and
 *   lifecycle event logging only.
 * Invariants: session and bearer identities share the same users.id principal;
 *   every query runs through withTenantScope(appDb, principal).
 * Side-effects: IO (Postgres and structured logs)
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { toUserId, userActor } from "@cogni/ids";
import type { SessionUser } from "@cogni/node-shared/auth/session";
import type {
  AgentCapabilityGrant,
  PolyAgentGrantsCreateInput,
} from "@cogni/poly-node-contracts";
import type { Logger } from "pino";

import { resolveAppDb } from "@/bootstrap/container";
import {
  AgentGrantInvalidRequestError,
  listOwnedAgentGrants,
  replaceOwnedAgentGrant,
  revokeOwnedAgentGrant,
} from "@/features/agent-grants/agent-grant-service";
import { EVENT_NAMES } from "@/shared/observability";

export type AgentGrantFacadeErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict";

export class AgentGrantFacadeError extends Error {
  constructor(
    readonly code: AgentGrantFacadeErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AgentGrantFacadeError";
  }
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export async function listAgentGrantsFacade(
  sessionUser: SessionUser
): Promise<{ grants: AgentCapabilityGrant[] }> {
  const principal = userActor(toUserId(sessionUser.id));
  const grants = await withTenantScope(
    resolveAppDb(),
    principal,
    async (tx) => listOwnedAgentGrants(tx, sessionUser.id)
  );
  return { grants };
}

export async function createAgentGrantFacade(
  sessionUser: SessionUser,
  input: PolyAgentGrantsCreateInput,
  logger: Logger
): Promise<{ grant: AgentCapabilityGrant }> {
  const principal = userActor(toUserId(sessionUser.id));
  try {
    const grant = await withTenantScope(
      resolveAppDb(),
      principal,
      async (tx) => replaceOwnedAgentGrant(tx, sessionUser.id, input)
    );
    if (!grant) {
      throw new AgentGrantFacadeError("not_found", "Account not found");
    }

    logger.info(
      {
        event: EVENT_NAMES.POLY_AGENT_GRANT_CREATED,
        principalId: sessionUser.id,
        billingAccountId: grant.billing_account_id,
        granteePrincipalId: grant.grantee_principal_id,
        grantId: grant.id,
        scopes: grant.scopes,
        expiresAt: grant.expires_at,
      },
      EVENT_NAMES.POLY_AGENT_GRANT_CREATED
    );
    return { grant };
  } catch (error) {
    if (error instanceof AgentGrantFacadeError) throw error;
    if (error instanceof AgentGrantInvalidRequestError) {
      throw new AgentGrantFacadeError("invalid_request", error.message);
    }
    if (postgresCode(error) === "23503") {
      throw new AgentGrantFacadeError(
        "invalid_request",
        "Grantee principal does not exist"
      );
    }
    if (postgresCode(error) === "23505") {
      throw new AgentGrantFacadeError(
        "conflict",
        "Grant was concurrently replaced"
      );
    }
    throw error;
  }
}

export async function revokeAgentGrantFacade(
  sessionUser: SessionUser,
  grantId: string,
  logger: Logger
): Promise<{ grant: AgentCapabilityGrant }> {
  const principal = userActor(toUserId(sessionUser.id));
  const grant = await withTenantScope(
    resolveAppDb(),
    principal,
    async (tx) => revokeOwnedAgentGrant(tx, sessionUser.id, grantId)
  );
  if (!grant) {
    throw new AgentGrantFacadeError("not_found", "Grant not found");
  }

  logger.info(
    {
      event: EVENT_NAMES.POLY_AGENT_GRANT_REVOKED,
      principalId: sessionUser.id,
      billingAccountId: grant.billing_account_id,
      granteePrincipalId: grant.grantee_principal_id,
      grantId: grant.id,
      revokedAt: grant.revoked_at,
    },
    EVENT_NAMES.POLY_AGENT_GRANT_REVOKED
  );
  return { grant };
}

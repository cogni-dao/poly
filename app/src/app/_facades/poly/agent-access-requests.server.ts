// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/poly/agent-access-requests.server`
 * Purpose: Bind authenticated agent/session identities, approval-token
 *   cryptography, app-role tenant transactions, and lifecycle logs.
 * Scope: DTO orchestration only; request/grant rules live in the feature.
 * Invariants: raw approval tokens exist only in agent create responses and
 *   owner decision inputs; no token or API key is logged or persisted.
 * Side-effects: IO (Postgres, cryptographic randomness, structured logs)
 * @public
 */

import { createHash, randomBytes } from "node:crypto";
import { withTenantScope } from "@cogni/db-client";
import { toUserId, userActor } from "@cogni/ids";
import type { SessionUser } from "@cogni/node-shared/auth/session";
import type {
  AgentAccessRequestAgent,
  AgentAccessRequestOwner,
  PolyAgentAccessRequestCreateInput,
  PolyAgentAccessRequestDecisionInput,
} from "@cogni/poly-node-contracts";
import type { Logger } from "pino";

import { resolveAppDb } from "@/bootstrap/container";
import {
  AgentAccessRequestConflictError,
  AgentAccessRequestInvalidError,
  createAgentAccessRequest,
  decideAgentAccessRequest,
  listOwnerAgentAccessRequests,
  pollAgentAccessRequest,
  previewAgentAccessRequest,
} from "@/features/agent-grants/agent-access-request-service";
import { serverEnv } from "@/shared/env/server";
import { EVENT_NAMES } from "@/shared/observability";

const APPROVAL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export type AgentAccessRequestFacadeErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict";

export class AgentAccessRequestFacadeError extends Error {
  constructor(
    readonly code: AgentAccessRequestFacadeErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AgentAccessRequestFacadeError";
  }
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function displayNameFor(sessionUser: SessionUser): string {
  const name = sessionUser.displayName?.trim();
  return name || `Agent ${sessionUser.id.slice(0, 8)}`;
}

function translateError(error: unknown): never {
  if (error instanceof AgentAccessRequestFacadeError) throw error;
  if (error instanceof AgentAccessRequestInvalidError) {
    throw new AgentAccessRequestFacadeError("invalid_request", error.message);
  }
  if (error instanceof AgentAccessRequestConflictError) {
    throw new AgentAccessRequestFacadeError("conflict", error.message);
  }
  if (postgresCode(error) === "23505") {
    throw new AgentAccessRequestFacadeError(
      "conflict",
      "A pending access request already exists"
    );
  }
  throw error;
}

export async function createAgentAccessRequestFacade(
  sessionUser: SessionUser,
  input: PolyAgentAccessRequestCreateInput,
  logger: Logger
): Promise<{ request: AgentAccessRequestAgent; approval_url: string }> {
  const appBaseUrl = serverEnv().APP_BASE_URL;
  if (!appBaseUrl) {
    throw new Error("APP_BASE_URL is required for agent approval links");
  }
  const approvalUrl = new URL("/profile", appBaseUrl);
  const rawToken = randomBytes(32).toString("base64url");
  const now = new Date();
  const requestedExpiry = new Date(input.expires_at);
  const tokenExpiresAt = new Date(
    Math.min(now.getTime() + APPROVAL_TOKEN_TTL_MS, requestedExpiry.getTime())
  );
  try {
    const request = await withTenantScope(
      resolveAppDb(),
      userActor(toUserId(sessionUser.id)),
      (tx) =>
        createAgentAccessRequest(tx, {
          principalId: sessionUser.id,
          displayName: displayNameFor(sessionUser),
          request: input,
          tokenHash: tokenHash(rawToken),
          tokenExpiresAt,
          now,
        })
    );

    approvalUrl.hash = `agent-request=${encodeURIComponent(rawToken)}`;
    logger.info(
      {
        event: EVENT_NAMES.POLY_AGENT_ACCESS_REQUEST_CREATED,
        requestId: request.id,
        principalId: sessionUser.id,
        scope: request.scope,
        expiresAt: request.expires_at,
      },
      EVENT_NAMES.POLY_AGENT_ACCESS_REQUEST_CREATED
    );
    return { request, approval_url: approvalUrl.toString() };
  } catch (error) {
    return translateError(error);
  }
}

export async function pollAgentAccessRequestFacade(
  sessionUser: SessionUser,
  requestId: string
): Promise<{ request: AgentAccessRequestAgent }> {
  const request = await withTenantScope(
    resolveAppDb(),
    userActor(toUserId(sessionUser.id)),
    (tx) => pollAgentAccessRequest(tx, sessionUser.id, requestId)
  );
  if (!request) {
    throw new AgentAccessRequestFacadeError("not_found", "Request not found");
  }
  return { request };
}

export async function previewAgentAccessRequestFacade(
  sessionUser: SessionUser,
  approvalToken: string
): Promise<{ request: AgentAccessRequestOwner }> {
  const request = await withTenantScope(
    resolveAppDb(),
    userActor(toUserId(sessionUser.id)),
    (tx) => previewAgentAccessRequest(tx, tokenHash(approvalToken))
  );
  if (!request) {
    throw new AgentAccessRequestFacadeError("not_found", "Request not found");
  }
  return { request };
}

export async function decideAgentAccessRequestFacade(
  sessionUser: SessionUser,
  requestId: string,
  input: PolyAgentAccessRequestDecisionInput,
  logger: Logger
): Promise<{ request: AgentAccessRequestOwner }> {
  try {
    const request = await withTenantScope(
      resolveAppDb(),
      userActor(toUserId(sessionUser.id)),
      (tx) =>
        decideAgentAccessRequest(tx, {
          ownerPrincipalId: sessionUser.id,
          requestId,
          tokenHash: tokenHash(input.approval_token),
          decision: input.decision,
          now: new Date(),
        })
    );
    if (!request) {
      throw new AgentAccessRequestFacadeError(
        "not_found",
        "Request not found"
      );
    }

    const event =
      input.decision === "approve"
        ? EVENT_NAMES.POLY_AGENT_ACCESS_REQUEST_APPROVED
        : EVENT_NAMES.POLY_AGENT_ACCESS_REQUEST_DENIED;
    logger.info(
      {
        event,
        requestId: request.id,
        principalId: sessionUser.id,
        grantId: request.grant_id,
        scope: request.scope,
        expiresAt: request.expires_at,
      },
      event
    );
    return { request };
  } catch (error) {
    return translateError(error);
  }
}

export async function listOwnerAgentAccessRequestsFacade(
  sessionUser: SessionUser
): Promise<{ requests: AgentAccessRequestOwner[] }> {
  const requests = await withTenantScope(
    resolveAppDb(),
    userActor(toUserId(sessionUser.id)),
    (tx) => listOwnerAgentAccessRequests(tx, sessionUser.id)
  );
  return { requests };
}

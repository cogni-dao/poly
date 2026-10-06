// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/poly.agent-access-requests.v1.contract`
 * Purpose: Agent-self request and browser-owner approval wire contracts.
 * Scope: Schema-only create, agent-list, poll, preview, decision, and owner-list
 *   shapes.
 * Invariants: one fixed coarse account-read scope; no owner/account/principal
 *   IDs enter decision inputs; approval tokens never appear in response DTOs.
 *   ACCOUNT_READ_ALIAS (story.5006, expand phase) — the wire scope is the
 *   two-name alias set rather than a single literal: new requests report the
 *   canonical `account:read`, while `performance:read` stays representable so
 *   rows and clients created before the rename keep parsing. Making this a
 *   union is also the forcing function that makes every exhaustive `switch`
 *   over the scope fail to compile until it handles the new name.
 * Side-effects: none
 * @public
 */

import { z } from "zod";

export const agentAccessRequestLifecycleStatusSchema = z.enum([
  "pending",
  "active",
  "expired",
  "denied",
  "revoked",
]);

export const AGENT_ACCESS_REQUEST_LIST_LIMIT = 50;

/**
 * The coarse account-read scope an access request grants, as both its canonical
 * name and its retained legacy alias. See ACCOUNT_READ_ALIAS above.
 */
export const agentAccessRequestScopeSchema = z.enum([
  "account:read",
  "performance:read",
]);
export type AgentAccessRequestScope = z.infer<
  typeof agentAccessRequestScopeSchema
>;

export const agentAccessRequestOwnerSchema = z.object({
  id: z.string().uuid(),
  agent_display_name: z.string().min(1),
  scope: agentAccessRequestScopeSchema,
  expires_at: z.string().datetime(),
  requested_at: z.string().datetime(),
  decided_at: z.string().datetime().nullable(),
  status: agentAccessRequestLifecycleStatusSchema,
  grant_id: z.string().uuid().nullable(),
});

const agentAccessRequestAgentBaseSchema = z
  .object({
    id: z.string().uuid(),
    scope: agentAccessRequestScopeSchema,
    expires_at: z.string().datetime(),
    requested_at: z.string().datetime(),
    decided_at: z.string().datetime().nullable(),
  })
  .strict();

export const agentAccessRequestAgentSchema = z.discriminatedUnion("status", [
  agentAccessRequestAgentBaseSchema.extend({
    status: z.literal("active"),
    billing_account_id: z.string().uuid(),
  }),
  agentAccessRequestAgentBaseSchema.extend({
    status: z.enum(["pending", "expired", "denied", "revoked"]),
    billing_account_id: z.null(),
  }),
]);

const approvalTokenSchema = z.string().min(32).max(512);

export const polyAgentAccessRequestCreateOperation = {
  id: "poly.agent-access-requests.create.v1",
  summary: "Request owner approval for account read access",
  input: z.object({ expires_at: z.string().datetime() }).strict(),
  output: z.object({
    request: agentAccessRequestAgentSchema,
    approval_url: z.string().url(),
  }),
} as const;

export const polyAgentAccessRequestPollOperation = {
  id: "poly.agent-access-requests.poll.v1",
  summary: "Poll one access request owned by the calling agent",
  input: z.object({ id: z.string().uuid() }),
  output: z.object({ request: agentAccessRequestAgentSchema }),
} as const;

export const polyAgentAccessRequestAgentListOperation = {
  id: "poly.agent-access-requests.agent-list.v1",
  summary: "List access requests owned by the calling agent",
  input: z.object({}).strict(),
  output: z
    .object({
      requests: z
        .array(agentAccessRequestAgentSchema)
        .max(AGENT_ACCESS_REQUEST_LIST_LIMIT),
    })
    .strict(),
} as const;

export const polyAgentAccessRequestsListOperation = {
  id: "poly.agent-access-requests.list.v1",
  summary: "List agent access lifecycle for the calling owner",
  input: z.object({}),
  output: z.object({ requests: z.array(agentAccessRequestOwnerSchema) }),
} as const;

export const polyAgentAccessRequestPreviewOperation = {
  id: "poly.agent-access-requests.preview.v1",
  summary: "Preview a pending request using a one-time approval token",
  input: z.object({ approval_token: approvalTokenSchema }).strict(),
  output: z.object({ request: agentAccessRequestOwnerSchema }),
} as const;

export const polyAgentAccessRequestDecisionOperation = {
  id: "poly.agent-access-requests.decision.v1",
  summary: "Approve or deny a pending request as the signed-in owner",
  input: z
    .object({
      approval_token: approvalTokenSchema,
      decision: z.enum(["approve", "deny"]),
    })
    .strict(),
  output: z.object({ request: agentAccessRequestOwnerSchema }),
} as const;

export const agentAccessRequestErrorOutput = z.object({
  error: z.enum(["invalid_request", "not_found", "conflict"]),
});

export type AgentAccessRequestOwner = z.infer<
  typeof agentAccessRequestOwnerSchema
>;
export type AgentAccessRequestAgent = z.infer<
  typeof agentAccessRequestAgentSchema
>;
export type AgentAccessRequestLifecycleStatus = z.infer<
  typeof agentAccessRequestLifecycleStatusSchema
>;
export type PolyAgentAccessRequestCreateInput = z.infer<
  typeof polyAgentAccessRequestCreateOperation.input
>;
export type PolyAgentAccessRequestDecisionInput = z.infer<
  typeof polyAgentAccessRequestDecisionOperation.input
>;

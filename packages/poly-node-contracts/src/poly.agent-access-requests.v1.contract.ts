// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/poly.agent-access-requests.v1.contract`
 * Purpose: Agent-self request and browser-owner approval wire contracts.
 * Scope: Schema-only create, poll, preview, decision, and owner-list shapes.
 * Invariants: fixed performance:read scope; no owner/account/principal IDs enter
 *   decision inputs; approval tokens never appear in response DTOs.
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

export const agentAccessRequestOwnerSchema = z.object({
  id: z.string().uuid(),
  agent_display_name: z.string().min(1),
  scope: z.literal("performance:read"),
  expires_at: z.string().datetime(),
  requested_at: z.string().datetime(),
  decided_at: z.string().datetime().nullable(),
  status: agentAccessRequestLifecycleStatusSchema,
  grant_id: z.string().uuid().nullable(),
});

const agentAccessRequestAgentSchema = z.object({
  id: z.string().uuid(),
  scope: z.literal("performance:read"),
  expires_at: z.string().datetime(),
  requested_at: z.string().datetime(),
  decided_at: z.string().datetime().nullable(),
  status: agentAccessRequestLifecycleStatusSchema,
  billing_account_id: z.string().min(1).nullable(),
});

const approvalTokenSchema = z.string().min(32).max(512);

export const polyAgentAccessRequestCreateOperation = {
  id: "poly.agent-access-requests.create.v1",
  summary: "Request owner approval for performance read access",
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

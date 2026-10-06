// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/poly.agent-grants.v1.contract`
 * Purpose: Owner-managed capability delegation contracts for human and
 *   machine principals.
 * Scope: Schema-only GET/POST/DELETE lifecycle wire shapes.
 * Invariants: scopes are canonical and non-empty; expiry is mandatory.
 *   SCOPE_ENUM_SINGLE_SOURCE — this list is the only definition of the scope
 *   vocabulary; `@cogni/db-schema` mirrors it in the grants CHECK constraint.
 *   ACCOUNT_READ_ALIAS (story.5006, expand phase) — `account:read` is the
 *   canonical name for delegated account data reads. `performance:read` is its
 *   retained legacy alias so the grants already issued in production keep
 *   authorizing with no human re-approval. Dropping the alias and backfilling
 *   rows is a later contract-phase task; until then both names are valid and
 *   `authorize()` matches either.
 * Side-effects: none
 * @public
 */

import { z } from "zod";

export const AGENT_CAPABILITY_SCOPES = [
  "account:read",
  // Legacy alias of `account:read`. Retained for back-compat; do not issue.
  "performance:read",
  "research:run",
  "policy:propose",
  "paper:assign",
  "live:approve",
  "live:assign",
] as const;

export const agentCapabilityScopeSchema = z.enum(AGENT_CAPABILITY_SCOPES);

const uniqueScopesSchema = z
  .array(agentCapabilityScopeSchema)
  .nonempty()
  .refine((scopes) => new Set(scopes).size === scopes.length, {
    message: "scopes must not contain duplicates",
  });

export const agentCapabilityGrantSchema = z.object({
  id: z.string().uuid(),
  billing_account_id: z.string().min(1),
  grantee_principal_id: z.string().uuid(),
  scopes: uniqueScopesSchema,
  expires_at: z.string().datetime(),
  created_by_user_id: z.string().uuid(),
  revoked_at: z.string().datetime().nullable(),
  revoked_by_user_id: z.string().uuid().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const polyAgentGrantsListOperation = {
  id: "poly.agent-grants.list.v1",
  summary: "List capability grants issued by the calling account owner",
  input: z.object({}),
  output: z.object({ grants: z.array(agentCapabilityGrantSchema) }),
} as const;

export const polyAgentGrantsCreateOperation = {
  id: "poly.agent-grants.create.v1",
  summary: "Create or replace a capability grant for one principal",
  input: z.object({
    billing_account_id: z.string().min(1),
    grantee_principal_id: z.string().uuid(),
    scopes: uniqueScopesSchema,
    expires_at: z.string().datetime(),
  }),
  output: z.object({ grant: agentCapabilityGrantSchema }),
} as const;

export const polyAgentGrantRevokeOperation = {
  id: "poly.agent-grants.revoke.v1",
  summary: "Soft-revoke one capability grant issued by the caller",
  input: z.object({ id: z.string().uuid() }),
  output: z.object({ grant: agentCapabilityGrantSchema }),
} as const;

export const polyAgentGrantsErrorOutput = z.object({
  error: z.enum(["invalid_request", "not_found", "conflict"]),
});

export type AgentCapabilityScope = z.infer<
  typeof agentCapabilityScopeSchema
>;
export type AgentCapabilityGrant = z.infer<
  typeof agentCapabilityGrantSchema
>;
export type PolyAgentGrantsCreateInput = z.infer<
  typeof polyAgentGrantsCreateOperation.input
>;
export type PolyAgentGrantRevokeInput = z.infer<
  typeof polyAgentGrantRevokeOperation.input
>;
export type PolyAgentGrantsErrorOutput = z.infer<
  typeof polyAgentGrantsErrorOutput
>;

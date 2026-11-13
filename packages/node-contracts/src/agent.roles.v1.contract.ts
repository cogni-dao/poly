// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/agent.roles.v1`
 * Purpose: Zod contract for GET, POST and DELETE /api/v1/agent-access/roles on the HUMAN plane: a DAO admin lists node AI
 *   and allows or removes a permission (a node role) for an internal agent principal by clicking on the profile page.
 * Scope: Input and output wire shapes. Does not contain authorization logic.
 * Invariants: CONTRACTS_ARE_TRUTH. `principal` is the internal principal slug (catalog name), never a user id.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { z } from "zod";

export const agentRolesOperation = {
  id: "agent.roles.v1",
  /**
   * Turn a row ON (POST) or OFF (DELETE). Name the agent by `principalUserId` (the id the table sends back, any agent) or,
   * for this node's own AI, by `principal` (catalog slug). `deny: true` on DELETE dismisses a pending ask.
   */
  input: z
    .object({
      /** Internal agent principal slug, e.g. `node-ai` or `prioritizer`. */
      principal: z.string().min(1).max(64).optional(),
      /** The agent's id, as the table returned it. Works for outside agents. */
      principalUserId: z.string().min(1).max(100).optional(),
      /** A scope the node declares, e.g. `knowledge:write`. */
      scope: z.string().min(1).max(100),
      deny: z.boolean().optional(),
    })
    .refine((v) => (v.principal === undefined) !== (v.principalUserId === undefined), {
      message: "send exactly one of principal or principalUserId",
    }),
  output: z.object({
    principal: z.string().optional(),
    scope: z.string(),
    principalUserId: z.string(),
    /** false when the grant already existed, the revoke found no live row, or the deny found no pending ask. */
    changed: z.boolean(),
  }),
} as const;

/** Human-plane refusal body: any `Authorization` header on a human route gets 403 with this code. */
export const HUMAN_SESSION_REQUIRED = "human_session_required" as const;

/**
 * `GET /api/v1/agent-access/roles`: what the "AI access" table renders. A non-admin gets `canManage: false`, `permissions: []`.
 * One row = one grant row. Name and description come from the declaration; the agent's name from `agent_principals` or the user.
 */
export const agentRolesListOperation = {
  id: "agent.roles.list.v1",
  output: z.object({
    canManage: z.boolean(),
    permissions: z.array(
      z.object({
        section: z.enum(["pending", "node", "outside", "personal"]),
        /** The row's id (`?request=<id>` in its approval link), so the page can highlight it. */
        requestId: z.string().optional(),
        principalUserId: z.string(),
        who: z.string(),
        outside: z.boolean(),
        hint: z.string().nullable(),
        scope: z.string(),
        label: z.string(),
        description: z.string(),
        on: z.boolean(),
        until: z.string().nullable(),
      })
    ),
    /** Outside rows left out because the list is bounded. */
    more: z.number().int().nonnegative(),
  }),
} as const;

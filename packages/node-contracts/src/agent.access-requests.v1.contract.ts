// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/agent.access-requests.v1`
 * Purpose: Zod contract for POST and GET /api/v1/agent/access-requests on the AI plane (bearer only): an agent asks for a
 *   permission for itself and lists its own asks.
 * Scope: Wire shapes. No authorization logic. The ask writes a pending row with no approver; an admin session turns it on.
 * Invariants: CONTRACTS_ARE_TRUTH. SELF_REQUEST_ONLY: the caller is the principal; the body never names another agent.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { z } from "zod";

export const agentAccessRequestStateSchema = z.enum(["pending", "granted", "denied", "revoked"]);

export const agentAccessRequestCreateOperation = {
  id: "agent.access-requests.create.v1",
  input: z.object({
    /** A scope this node declares. Anything else is 400 `invalid_scope`. */
    scope: z.string().min(1).max(100),
  }),
  output: z.object({
    scope: z.string(),
    /** `pending` = asked and waiting; `granted` = already live. */
    state: z.enum(["pending", "granted"]),
    /** false when the ask (or grant) already existed. */
    created: z.boolean(),
    /**
     * The link to hand the human who decides THIS ask. Unique to the ask. An owned agent asking for a delegable scope gets a deep link into its owner's profile
     * (`/profile?request=<id>`); any other ask gets one into the Admin AI-access page (`/admin/ai-access?request=<id>`). The page highlights that row. Null only when no open row exists.
     */
    approvalUrl: z.string().nullable(),
  }),
} as const;

export const agentAccessRequestListOperation = {
  id: "agent.access-requests.list.v1",
  output: z.object({
    requests: z.array(
      z.object({
        scope: z.string(),
        state: agentAccessRequestStateSchema,
        at: z.string(),
        /** The link to hand the human who decides this ask. Set on an open ask or live grant. */
        approvalUrl: z.string().optional(),
      })
    ),
  }),
} as const;

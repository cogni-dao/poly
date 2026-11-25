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

/** `expired` is a state read from the row's end date (R14): an account grant whose time passed. */
export const agentAccessRequestStateSchema = z.enum(["pending", "granted", "denied", "revoked", "expired"]);

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
     * The one link to hand the person who decides: `/admin/ai-access#agent-request=<token>` for a node permission, `/profile#agent-request=<token>`
     * for an account permission, picked by the permission's declared kind. One-time, 24 hours; every ask on a waiting row returns a new one.
     * Absent when the grant is already live.
     */
    approvalUrl: z.string().url().optional(),
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
        /** The account an account grant covers (set once its owner decided); null for a node permission and for a waiting ask. */
        accountId: z.string().nullable(),
      })
    ),
  }),
} as const;

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/agent.request.v1`
 * Purpose: Zod contracts for the owner's decision on ONE ask by id (`POST /api/v1/agent-access/mine/requests/{id}`, HUMAN plane, session only), and for the agent-initiated claim
 *   of an EXISTING agent: `POST /api/v1/agent/claim` (AI plane, bearer) returns a link into the owner's profile (`/profile?claim=<id>`); the person's click there claims it.
 * Scope: Wire shapes. Authority lives in the routes and `@cogni-dao/agent-grants`.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH. An answer of "no" (unknown id, someone else's request) is one 404 `not_found`.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard, https://cognidao.org/work/items/task.5465
 * @public
 */

import { z } from "zod";

/** The click on an ask in the owner's Your AIs: `POST /api/v1/agent-access/mine/requests/{id}`. */
export const agentRequestDecisionOperation = {
  id: "agent.request.decision.v1",
  input: z.object({ decision: z.enum(["approve", "deny"]) }),
  output: z.object({
    requestId: z.string(),
    decision: z.enum(["approve", "deny"]),
    /** false when nothing changed. */
    changed: z.boolean(),
  }),
} as const;

/** `POST /api/v1/agent/claim` (AI plane, bearer, no body): an existing agent asks to become its owner's. The answer is the link the person opens (their profile). */
export const agentClaimStartOperation = {
  id: "agent.claim.start.v1",
  output: z.object({
    /** The link to hand the person who will own this agent. Single use, 15 minutes, bound to this agent. */
    claimUrl: z.string().min(1),
    expiresAt: z.string().min(1),
  }),
} as const;

/** `GET /api/v1/profile/ai/claims/{id}` (human plane): what the claim row on the profile shows. `POST` on the same path is the click. */
export const agentClaimViewOperation = {
  id: "agent.claim.view.v1",
  output: z.object({
    claimId: z.string(),
    /** The agent, by its registered name. */
    agentName: z.string().nullable(),
    state: z.enum(["open", "claimed", "expired", "owned"]),
    expiresAt: z.string(),
  }),
} as const;

export const agentClaimCompleteOperation = {
  id: "agent.claim.complete.v1",
  output: z.object({ claimed: z.literal(true) }),
} as const;

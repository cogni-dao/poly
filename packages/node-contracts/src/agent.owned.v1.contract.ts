// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/agent.owned.v1`
 * Purpose: Zod contract for the HUMAN-plane "Your AIs" routes on a person's own profile: list the agents this person owns, issue a one-time
 *   setup code for a new one ("Add an AI"), and revoke the keys of an owned agent.
 * Scope: Wire shapes only. Authority lives in the routes (session only) and in `@cogni-dao/agent-grants/credentials`.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: every response is parsed through these shapes.
 *   - HUMAN_SURFACE_TOKENLESS: the list carries no key, hash, grant or credential id. `setupLine` is the ONE place a secret is returned, once, in
 *     response to the issue click; it is never part of the list.
 *   - OWNER_SEES_ONLY_OWN: `agents` holds only agents the signed-in person owns.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard, https://cognidao.org/work/items/task.5474
 * @public
 */

import { z } from "zod";

export const ownedAgentsListOperation = {
  id: "agent.owned.list.v1",
  output: z.object({
    agents: z.array(
      z.object({
        /** The handle the revoke click sends back. */
        agentId: z.string().min(1),
        name: z.string(),
        createdAt: z.string(),
        keyState: z.enum(["active", "pending", "expired", "revoked", "none"]),
      })
    ),
    /** How many more setup codes this person may issue right now. */
    grantsLeft: z.number().int().min(0),
  }),
} as const;

export const ownedAgentIssueOperation = {
  id: "agent.owned.issue.v1",
  output: z.object({
    /** One copyable line for the agent. Shown once. */
    setupLine: z.string().min(1),
    expiresAt: z.string().min(1),
    grantsLeft: z.number().int().min(0),
  }),
} as const;

export const ownedAgentRevokeOperation = {
  id: "agent.owned.revoke.v1",
  input: z.object({ agentId: z.string().min(1).max(100) }),
  output: z.object({ agentId: z.string().min(1), revoked: z.number().int().min(0) }),
} as const;

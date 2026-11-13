// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/agent.mine.v1`
 * Purpose: Zod contract for GET, POST and DELETE /api/v1/agent-access/mine on the HUMAN plane (session only): a signed-in person sees what the AIs they
 *   own ask to do with THEIR data, turns one On (POST), and turns it Off or dismisses an ask (DELETE) by clicking on their profile, "Your AIs".
 * Scope: Wire shapes. Authority lives in the route (person session, then ownership of the named AI) and `@cogni-dao/agent-grants`.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH. `principalUserId` is the opaque handle the list sent back. Nothing here names a node permission: node rows are Admin only.
 *   - OWNER_SEES_ONLY_OWN: the list holds only AIs the signed-in person owns.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard, https://cognidao.org/work/items/task.5465
 * @public
 */

import { z } from "zod";

export const agentMineListOperation = {
  id: "agent.mine.list.v1",
  output: z.object({
    permissions: z.array(
      z.object({
        /** The row's id: the handle of its approval link (`/profile?request=<id>`) and of the by-id decision. */
        requestId: z.string(),
        principalUserId: z.string(),
        who: z.string(),
        scope: z.string(),
        label: z.string(),
        description: z.string(),
        on: z.boolean(),
        until: z.string().nullable(),
      })
    ),
  }),
} as const;

export const agentMineOperation = {
  id: "agent.mine.v1",
  /** Turn a row ON (POST) or OFF (DELETE). `deny: true` on DELETE dismisses an ask. */
  input: z.object({
    principalUserId: z.string().min(1).max(100),
    scope: z.string().min(1).max(100),
    deny: z.boolean().optional(),
  }),
  output: z.object({
    principalUserId: z.string(),
    scope: z.string(),
    /** false when the row was already On, or the revoke or dismiss found nothing to change. */
    changed: z.boolean(),
  }),
} as const;

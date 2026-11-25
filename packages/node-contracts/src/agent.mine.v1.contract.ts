// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/agent.mine.v1`
 * Purpose: Zod contract for `/api/v1/agent-access/mine` on the HUMAN plane (a signed-in person, session only): the person lists the AIs that may act on
 *   their own account, turns one On (an outside AI's ask by its one-time link token, or this node's own AI directly), and turns one Off or dismisses an ask.
 *   `POST /api/v1/agent-access/mine/preview` and `POST /api/v1/admin/ai-access/preview` look a waiting ask up by its token so the page can highlight it.
 * Scope: Wire shapes. No authorization logic.
 * Invariants: CONTRACTS_ARE_TRUTH. HUMAN_SURFACE_TOKENLESS: a person never types or copies a token; the page reads it from the link fragment and sends it back.
 *   The approver is the signed-in person: the body never names an approver or an account.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

import { z } from "zod";

import { agentAccessRowSchema } from "./agent.roles.v1.contract";

/** A one-time link token: 43 base64url characters. */
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const agentMineListOperation = {
  id: "agent.mine.list.v1",
  output: z.object({
    permissions: z.array(agentAccessRowSchema),
    /** Rows left out because the list is bounded. */
    more: z.number().int().nonnegative(),
  }),
} as const;

export const agentMineOnOperation = {
  id: "agent.mine.on.v1",
  /**
   * Turn a row On. Send exactly one of: `token` (an outside AI's ask, from its link) or `principalUserId` + `scope` (this node's own AI, no ask).
   * An account grant has no end date: it lasts until Off, like a node permission.
   */
  input: z
    .object({
      token: tokenSchema.optional(),
      principalUserId: z.string().min(1).max(100).optional(),
      scope: z.string().min(1).max(100).optional(),
      /** With `token` only: an org account the signed-in person co-owns (through the org's owner source) and decides for. Absent = the person's own account. */
      accountId: z.string().min(1).max(100).optional(),
    })
    .refine(
      (v) =>
        (v.token !== undefined && v.principalUserId === undefined && v.scope === undefined) ||
        (v.token === undefined && v.principalUserId !== undefined && v.scope !== undefined && v.accountId === undefined),
      { message: "send a token, or principalUserId with scope" }
    ),
  output: z.object({ changed: z.boolean() }),
} as const;

export const agentMineOffOperation = {
  id: "agent.mine.off.v1",
  /** Turn a live row Off by its id, or dismiss a waiting ask with `deny: true` and its token (an undecided ask has no account yet). */
  input: z
    .object({
      rowId: z.string().uuid().optional(),
      token: tokenSchema.optional(),
      deny: z.literal(true).optional(),
      /** With `token` and `deny`: an org account the signed-in person co-owns and dismisses the ask for. */
      accountId: z.string().min(1).max(100).optional(),
    })
    .refine(
      (v) =>
        (v.rowId !== undefined && v.token === undefined && v.deny === undefined && v.accountId === undefined) ||
        (v.rowId === undefined && v.token !== undefined && v.deny === true),
      { message: "send a rowId, or a token with deny" }
    ),
  output: z.object({ changed: z.boolean() }),
} as const;

export const agentPreviewOperation = {
  id: "agent.preview.v1",
  input: z.object({ token: tokenSchema }),
  /** The waiting ask the token opens, as a table row. A wrong-kind, used, expired or unknown token is one 404. */
  output: z.object({ permission: agentAccessRowSchema }),
} as const;

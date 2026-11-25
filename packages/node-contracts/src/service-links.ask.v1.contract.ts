// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/service-links.ask.v1`
 * Purpose: Zod contract for POST /api/v1/service-links/ask (story.0038 phase 2): a node admin has this node's AI ask a configured remote node for one permission.
 * Scope: Body and output only. `alias` names an entry of the deployment's `.cogni/service-links.yaml` targets; it is never a URL. The route signs an assertion and posts it to the target's
 *   public service-enrollment route, then returns the target's answer.
 * Invariants: CONTRACTS_ARE_TRUTH. NOTHING_IS_GRANTED: the answer is the target's `pending` or `granted`; this node never writes a grant on the target. A refusal carries the
 *   target's HTTP status and no body.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { z } from "zod";

export const serviceLinkAskOperation = {
  id: "service-links.ask.v1",
  input: z.object({
    alias: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    scope: z.string().regex(/^[A-Za-z0-9:._-]{1,100}$/),
  }),
  output: z.object({
    alias: z.string(),
    /** The target's answer: `pending` (an admin there must turn it On) or `granted` (already On); null when the target refused. */
    status: z.enum(["pending", "granted"]).nullable(),
    /** The target's HTTP status. */
    httpStatus: z.number().int(),
  }),
} as const;

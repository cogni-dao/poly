// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/agent.service-enrollment.v1`
 * Purpose: Zod contract for POST /api/v1/public/agent/service-enrollments (story.0038): a service on a trusted home node asks this node for one permission.
 * Scope: Body and output only. The caller authenticates with `Authorization: Bearer <signed assertion>`; the assertion, not the body, names who is asking.
 * Invariants: CONTRACTS_ARE_TRUTH. The answer is `pending` (the ask waits for an admin's yes in /admin/ai-access) or `granted` (a live grant already exists); it never
 *   carries a key, a link or a token.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { z } from "zod";

export const serviceEnrollmentOperation = {
  id: "agent.service-enrollment.v1",
  input: z.object({
    scope: z.string().regex(/^[A-Za-z0-9:._-]{1,100}$/),
  }),
  output: z.object({
    status: z.enum(["pending", "granted"]),
  }),
} as const;

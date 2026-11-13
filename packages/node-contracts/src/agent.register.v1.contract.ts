// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/agent.register.v1`
 * Purpose: Zod contract for POST /api/v1/agent/register.
 * Scope: Input (agent display name, optional spawn grant) and output (issued machine credentials + actor identity). Does not contain business logic.
 * Invariants: CONTRACTS_ARE_TRUTH — single source for registration wire shape.
 * Side-effects: none
 * Links: docs/spec/identity-model.md, docs/spec/node-operator-contract.md
 * @public
 */

import { z } from "zod";

export const registerAgentOperation = {
  id: "agent.register.v1",
  input: z.object({
    name: z.string().min(1).max(80),
    /**
     * The one-time setup code a signed-in person copied from their profile ("Your AIs" > "Add an AI"). With it, the agent is linked to that
     * person and gets a revocable key that is PENDING: confirm it once at POST /api/v1/agent/credentials/confirm with that key. Without it the
     * agent registers anonymously and has no owner (this door stays open for now).
     */
    spawnGrant: z.string().min(1).max(200).optional(),
  }),
  output: z.object({
    userId: z.string().min(1),
    apiKey: z.string().min(1),
    billingAccountId: z.string().min(1),
    /** `pending`: the key must be confirmed before any other route accepts it (spawn grant). Absent: the key works at once (anonymous). */
    keyState: z.literal("pending").optional(),
  }),
} as const;

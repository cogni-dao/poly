// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/work.items.patch.v1.contract`
 * Purpose: Operation contract for patching a work item via the operator API.
 * Scope: Provides Zod schema and types for work item patch wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 *   - PATCH_ALLOWLIST: only fields in `set` are mutable. id/created_at/updated_at are server-managed.
 *   - Optional expectedRevision enables compare-and-set; omission preserves unconditional patches.
 *   - REASON_REQUIRED (task.0086): `reason` is required: one line (line breaks become spaces), 1-240 chars, at most 25 words, stored in Dolt history, never in the item (task.0052).
 *   - Optional `cites` (at most 8 hub atoms) are pinned to commits in history; an unknown id is a 400.
 *   - No transition state-machine — whoever holds a valid token is trusted.
 * Side-effects: none
 * Links: /api/v1/work/items/[id] route, docs/spec/work-items-port.md, work/items/task.0423.doltgres-work-items-source-of-truth.md
 * @internal
 */

import { z } from "zod";

import { CITE_MAX, ChangeReasonSchema, CiteRefSchema } from "@cogni/work-items";

import { WorkItemDtoSchema, WorkItemScoresInputSchema } from "./work.items.list.v1.contract";

const WorkItemStatusSchema = z.enum([
  "needs_triage",
  "needs_research",
  "needs_design",
  "needs_implement",
  "needs_closeout",
  "needs_merge",
  "done",
  "blocked",
  "cancelled",
]);

export const workItemsPatchOperation = {
  id: "work.items.patch.v1",
  summary: "Patch a work item",
  description:
    "Updates a subset of fields on a work item. Whitelisted fields only — id, created_at, updated_at are server-managed. Optional expectedRevision makes the patch compare-and-set; a stale revision returns 409 without writing. Required reason (one line, at most 25 words and 240 chars) says why; a PATCH without it is a 400. It is stored in history (GET /work/items/{id}/history), not in the item. Optional cites (at most 8, each { id } or { id, contribution }) name hub atoms you read; each is pinned to its commit in history, and an unknown id is a 400.",
  input: z.object({
    id: z.string(),
    expectedRevision: z.number().int().nonnegative().optional(),
    // The adapter turns CR/LF into spaces and trims; this checks the result fits.
    reason: ChangeReasonSchema,
    cites: z.array(CiteRefSchema).max(CITE_MAX).optional(),
    set: z
      .strictObject({
        title: z.string().min(1).max(500).optional(),
        summary: z.string().optional(),
        outcome: z.string().optional(),
        status: WorkItemStatusSchema.optional(),
        priority: z.number().int().optional(),
        rank: z.number().int().optional(),
        estimate: z.number().int().optional(),
        scores: WorkItemScoresInputSchema.nullable().optional(),
        labels: z.array(z.string()).optional(),
        specRefs: z.array(z.string()).optional(),
        branch: z.string().optional(),
        pr: z.string().optional(),
        reviewer: z.string().optional(),
        node: z.string().optional(),
        deployVerified: z.boolean().optional(),
        projectId: z.string().nullable().optional(),
        parentId: z.string().nullable().optional(),
        blockedBy: z.string().nullable().optional(),
      })
      .refine((v) => Object.keys(v).length > 0, {
        message: "set must contain at least one field",
      }),
  }),
  output: WorkItemDtoSchema,
} as const;

// Export inferred types
export type WorkItemsPatchInput = z.infer<typeof workItemsPatchOperation.input>;
export type WorkItemsPatchOutput = z.infer<
  typeof workItemsPatchOperation.output
>;

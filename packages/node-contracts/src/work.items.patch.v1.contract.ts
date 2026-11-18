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
 * Links: /api/v1/work/items/[id] route, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/work-items-port.md
 * @internal
 */

import { WorkItemPatchInputSchema } from "@cogni/work-items";
import type { z } from "zod";

import { WorkItemDtoSchema } from "./work.items.list.v1.contract";

export const workItemsPatchOperation = {
  id: "work.items.patch.v1",
  summary: "Patch a work item",
  description:
    "Updates whitelisted fields on a work item. Optional expectedRevision makes the patch compare-and-set; a stale revision returns 409 without writing. Required reason (one line, at most 25 words and 240 chars) says why; a PATCH without it is a 400. It is stored in history (GET /work/items/{id}/history), not in the item. Optional cites (at most 8, each { id } or { id, contribution }) name hub atoms you read; each is pinned to its commit in history, and an unknown id is a 400.",
  // One schema for the route and the agent tool (core__work_item_update); it lives in @cogni-dao/work-items.
  input: WorkItemPatchInputSchema,
  output: WorkItemDtoSchema,
} as const;

// Export inferred types
export type WorkItemsPatchInput = z.infer<typeof workItemsPatchOperation.input>;
export type WorkItemsPatchOutput = z.infer<
  typeof workItemsPatchOperation.output
>;

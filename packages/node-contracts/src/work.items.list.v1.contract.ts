// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/work.items.list.v1.contract`
 * Purpose: Defines operation contract for listing work items with optional filters.
 * Scope: Provides Zod schema and types for work item list wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 * Side-effects: none
 * Links: /api/v1/work/items route, docs/spec/work-items-port.md
 * @internal
 */

import { WorkItemDtoSchema } from "@cogni/work-items";
import { z } from "zod";

export { WorkItemDtoSchema } from "@cogni/work-items";

export const WorkItemScoresInputSchema = z.record(
  z.string(),
  z.looseObject({ v: z.number(), ev: z.string().optional() }),
);

export const workItemsListOperation = {
  id: "work.items.list.v1",
  summary: "List work items with optional filters",
  description:
    "Returns work items matching optional type, status, text, and project filters.",
  input: z.object({
    types: z.array(z.string()).optional(),
    statuses: z.array(z.string()).optional(),
    text: z.string().optional(),
    actor: z.enum(["human", "ai", "either"]).optional(),
    projectId: z.string().optional(),
    node: z.union([z.string(), z.array(z.string())]).optional(),
    limit: z.number().int().positive().max(500).optional(),
    cursor: z.string().optional(),
  }),
  output: z.object({
    items: z.array(WorkItemDtoSchema),
    /** @deprecated Use pageInfo.endCursor — kept for backwards compat. */
    nextCursor: z.string().optional(),
    pageInfo: z
      .object({
        endCursor: z.string().nullable(),
        hasMore: z.boolean(),
      })
      .optional(),
  }),
} as const;

// Export inferred types
export type WorkItemDto = z.infer<typeof WorkItemDtoSchema>;
export type WorkItemsListInput = z.infer<typeof workItemsListOperation.input>;
export type WorkItemsListOutput = z.infer<typeof workItemsListOperation.output>;

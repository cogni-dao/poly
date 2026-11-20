// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/work.items.get.v1.contract`
 * Purpose: Defines operation contract for getting a single work item by ID.
 * Scope: Provides Zod schema and types for work item get wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 *   - Additive envelope (task.0118): `moves` entries carry metric, kpi and goal; `?include=links` adds `links`. Both derive from the one WorkItemDtoSchema.
 *   - Artifacts (task.0028): the read adds `artifacts`, the latest triage, review or validation of each kind, without `body` (WorkItemReadDtoSchema, owned by @cogni-dao/work-items).
 * Side-effects: none
 * Links: /api/v1/work/items/[id] route, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/work-items-port.md
 * @internal
 */

import { WORK_ITEM_INCLUDES, WorkItemGetInputSchema, WorkItemReadDtoSchema } from "@cogni/work-items";
import type { z } from "zod";

/** The envelope parts and the input schema are owned by `@cogni/work-items` (story.0085); this contract re-exports them. */
export { WORK_ITEM_INCLUDES };

export const workItemsGetOperation = {
  id: "work.items.get.v1",
  summary: "Get a work item by ID",
  description:
    "Returns a single work item by its ID, or 404 if not found. Each moves entry carries its metric, the KPI it serves and the goal (task.0118). include=links adds the first page of citation links; include=artifacts adds `artifactRefs` and include=history adds `historyRefs`, each the first page of refs with `nextCursor` (story.0058); artifact=<id> adds `artifact`, that one artifact in full, or `{ notFound: true }`. `artifacts` holds the latest artifact of each kind (triage, design review, implementation review, validation, closeout), without its `body` (task.0028); `artifacts.unavailable` means they could not be read, not that there are none.",
  input: WorkItemGetInputSchema,
  output: WorkItemReadDtoSchema,
} as const;

// Export inferred types
export type WorkItemsGetInput = z.infer<typeof workItemsGetOperation.input>;
export type WorkItemsGetOutput = z.infer<typeof workItemsGetOperation.output>;

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Shared `core__work_item_update` contract and execution (task.0086). It mirrors
 * PATCH /api/v1/work/items/{id}, requires the `work_item:transition` grant, and
 * carries the required reason and optional cites to the one store enforcer.
 */
export {
  createWorkItemUpdateImplementation,
  WORK_ITEM_UPDATE_NAME,
  type WorkItemUpdateDeps,
  WorkItemUpdateConflictSchema,
  type WorkItemUpdateInput,
  type WorkItemUpdateOutput,
  WorkItemUpdateOutputSchema,
  WorkItemUpdateSuccessSchema,
  workItemUpdateBoundTool,
  workItemUpdateContract,
} from "@cogni/shared-ai-tools";

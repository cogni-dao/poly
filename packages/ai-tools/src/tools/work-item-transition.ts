// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Keep the runtime binding and contract on the same released CAS/score patch API. */
export {
  createWorkItemTransitionImplementation,
  WORK_ITEM_TRANSITION_NAME,
  type WorkItemTransitionDeps,
  type WorkItemTransitionInput,
  WorkItemTransitionInputSchema,
  type WorkItemTransitionOutput,
  WorkItemTransitionOutputSchema,
  type WorkItemTransitionRedacted,
  workItemTransitionBoundTool,
  workItemTransitionContract,
  workItemTransitionStubImplementation,
} from "@cogni/shared-ai-tools";

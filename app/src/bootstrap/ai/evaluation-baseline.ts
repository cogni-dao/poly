// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Published evaluation behavior composed with Poly's existing product policy. */
import { type CatalogBoundTool, CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import {
  METRIC_TOOL_BUNDLE,
  CORE_TOOL_BUNDLE as SHARED_TOOL_BUNDLE,
} from "@cogni/shared-ai-tools";

const baselineIds = new Set([
  "core__goal_list", "core__work_item_query", "core__work_item_transition",
  "core__knowledge_search", "core__edo_decide", "core__get_current_time",
]);
const localById = new Map(CORE_TOOL_BUNDLE.map((tool) => [tool.contract.name, tool]));
const replacements = SHARED_TOOL_BUNDLE.filter((tool) => baselineIds.has(tool.contract.name)).map((shared) => {
  const local = localById.get(shared.contract.name);
  return local ? { ...shared, contract: { ...local.contract, ...shared.contract } } : shared;
});
/** Published goal-progress and metric tools (core__goal_progress, core__metric_*), bound in the container. */
export const POLY_CORE_TOOL_BUNDLE: readonly CatalogBoundTool[] = [
  ...CORE_TOOL_BUNDLE.filter((tool) => !baselineIds.has(tool.contract.name)), ...replacements,
  ...METRIC_TOOL_BUNDLE,
];

/**
 * Every tool contract whose `requires` this node declares to the grant system (permission catalog and route doors).
 * `core__work_item_update` is the contract the work-item PATCH route twins (SAME_DOOR_ROUTES in `@cogni/agent-grants`); it is
 * declared here for its `requires` only and is not bound or offered to any graph.
 */
export const POLY_GRANT_DECLARATION_BUNDLE: readonly CatalogBoundTool[] = [
  ...POLY_CORE_TOOL_BUNDLE,
  ...SHARED_TOOL_BUNDLE.filter(
    (tool) => tool.contract.name === "core__work_item_update"
  ),
];

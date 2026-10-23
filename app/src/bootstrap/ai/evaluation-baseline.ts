// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Published evaluation behavior composed with Poly's existing product policy. */
import { type CatalogBoundTool, CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import { CORE_TOOL_BUNDLE as SHARED_TOOL_BUNDLE } from "@cogni/shared-ai-tools";

const baselineIds = new Set([
  "core__goal_list", "core__work_item_query", "core__work_item_transition",
  "core__knowledge_search", "core__edo_decide", "core__get_current_time",
]);
const localById = new Map(CORE_TOOL_BUNDLE.map((tool) => [tool.contract.name, tool]));
const replacements = SHARED_TOOL_BUNDLE.filter((tool) => baselineIds.has(tool.contract.name)).map((shared) => {
  const local = localById.get(shared.contract.name);
  return local?.contract.requires === undefined ? shared : {
    ...shared, contract: { ...shared.contract, requires: local.contract.requires },
  };
});
export const POLY_CORE_TOOL_BUNDLE: readonly CatalogBoundTool[] = [
  ...CORE_TOOL_BUNDLE.filter((tool) => !baselineIds.has(tool.contract.name)), ...replacements,
];

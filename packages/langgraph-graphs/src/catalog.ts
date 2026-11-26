// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/catalog`
 * Purpose: Single source of truth for LangGraph graph definitions.
 * Scope: Exports LANGGRAPH_CATALOG with all available graphs. Does NOT import from src/.
 * Invariants:
 *   - CATALOG_SINGLE_SOURCE_OF_TRUTH: Graph definitions live here, not in bootstrap
 *   - PACKAGES_NO_SRC_IMPORTS: No imports from src/**
 *   - Adding a graph = add entry here, not touch bootstrap
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/graph-execution-invariants
 * @public
 */

import { NODE_LANGGRAPH_CATALOG as SHARED_NODE_CATALOG } from "@cogni/shared-langgraph-graphs";

import type { CreateGraphFn } from "./inproc/types";

/**
 * Catalog entry shape.
 *
 * Per TOOL_CATALOG_IS_CANONICAL: graphs reference tools by ID, not by BoundTool.
 * Providers resolve tools from TOOL_CATALOG using these IDs.
 */
interface CatalogEntry {
  readonly displayName: string;
  readonly sharedRuntime?: boolean;
  readonly description: string;
  /** Native tool IDs this graph may use. Providers resolve from TOOL_CATALOG. */
  readonly toolIds: readonly string[];
  /** MCP server names whose tools this graph may use. Empty = no MCP tools. */
  readonly mcpServerIds?: readonly string[];
  readonly graphFactory: CreateGraphFn;
  /** Optional system prompt for operator graphs (catalog-driven, not hardcoded). */
  readonly systemPrompt?: string;
}

/**
 * POLY's work-prioritizer: the released entry with its write tools (update, artifact record) removed, so it is read-only.
 *
 * Triage writes are off on poly until the program plumbing (program, sourceContext, run hooks) is ported.
 * POLY's in-proc runner does not pass `program` to the graph factory, so the released prioritizer would run
 * as a plain ReAct agent holding the full-schema `core__work_item_update` with no triage guard, no
 * five-change cap and no receipt. `core__work_item_read` stays; the update and artifact-record tools are neither offered nor bound.
 */
const SHARED_WORK_PRIORITIZER = SHARED_NODE_CATALOG["work-prioritizer"];
const POLY_WORK_PRIORITIZER: CatalogEntry = {
  ...SHARED_WORK_PRIORITIZER,
  toolIds: SHARED_WORK_PRIORITIZER.toolIds.filter(
    (id) =>
      id !== "core__work_item_update" &&
      id !== "core__work_item_artifact_record"
  ),
  systemPrompt: `${SHARED_WORK_PRIORITIZER.systemPrompt} READ-ONLY ON THIS NODE: triage writes are off, so core__work_item_update and core__work_item_artifact_record are not available. Do not try to change any item. Read as above, then report in your final answer the routes, scores and cancels you would make, one line per item, with the reason for each. Reporting them satisfies the run; ignore the instruction to write.`,
};

/**
 * The released coordinator prompt ends with the host-owned list of registered workflows, rendered when the package was built. That list
 * names `work-closeout` (not run on this node) and gives the prioritizer its write tools (removed above). Rewrite only that JSON block so the
 * coordinator is told what this node actually runs; the rest of the released prompt is unchanged. A prompt without the marker is left as released.
 */
const WORKFLOWS_MARKER = "Host-owned registered workflows:\n";
const POLY_UNAVAILABLE_WORKFLOWS: ReadonlySet<string> = new Set([
  "langgraph:work-closeout",
]);
export function rewriteRegisteredWorkflows(prompt: string | undefined): string | undefined {
  if (!prompt) return prompt;
  const at = prompt.indexOf(WORKFLOWS_MARKER);
  if (at < 0) return prompt;
  const head = prompt.slice(0, at + WORKFLOWS_MARKER.length);
  try {
    const workflows = JSON.parse(prompt.slice(at + WORKFLOWS_MARKER.length)) as {
      id: string;
      toolIds: string[];
    }[];
    const kept = workflows
      .filter((w) => !POLY_UNAVAILABLE_WORKFLOWS.has(w.id))
      .map((w) =>
        w.id === "langgraph:work-prioritizer"
          ? { ...w, toolIds: [...POLY_WORK_PRIORITIZER.toolIds] }
          : w
      );
    return head + JSON.stringify(kept);
  } catch {
    return prompt;
  }
}

/**
 * LangGraph catalog - the published shared graphs this node runs: the `cogni` coordinator and the
 * read-only `work-prioritizer`. Poly's own graphs (poly-brain, poly-research) live in `@cogni/poly-graphs`
 * and are composed in the app's node catalog.
 *
 * Per CATALOG_SINGLE_SOURCE_OF_TRUTH: graphs are defined here, not in bootstrap.
 */
export const LANGGRAPH_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  cogni: {
    ...SHARED_NODE_CATALOG.cogni,
    sharedRuntime: true,
    systemPrompt: rewriteRegisteredWorkflows(
      (SHARED_NODE_CATALOG.cogni as { systemPrompt?: string }).systemPrompt
    ),
  },
  "work-prioritizer": POLY_WORK_PRIORITIZER,
} as const;

/**
 * Type helper for catalog entry lookup (short names).
 */
export type LangGraphCatalogKeys = keyof typeof LANGGRAPH_CATALOG;

/**
 * LangGraph provider ID for namespacing.
 */
export const LANGGRAPH_PROVIDER_ID = "langgraph" as const;

/**
 * Fully-qualified graph IDs satisfying GraphId from @cogni/ai-core.
 * Per GRAPH_ID_NAMESPACED: format is ${providerId}:${graphName}
 */
export const LANGGRAPH_GRAPH_IDS = {
  cogni: `${LANGGRAPH_PROVIDER_ID}:cogni`,
  "work-prioritizer": `${LANGGRAPH_PROVIDER_ID}:work-prioritizer`,
} as const;

/**
 * Union type of all valid LangGraph graph IDs.
 */
export type LangGraphGraphId =
  (typeof LANGGRAPH_GRAPH_IDS)[keyof typeof LANGGRAPH_GRAPH_IDS];

/**
 * Default graph ID.
 */
export const DEFAULT_LANGGRAPH_GRAPH_ID = LANGGRAPH_GRAPH_IDS.cogni;

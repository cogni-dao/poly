// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/catalog`
 * Purpose: Base LangGraph catalog for this node: the published shared `cogni` coordinator only.
 * Scope: Exports LANGGRAPH_CATALOG and graph IDs. Does NOT import from src/.
 *   Poly's own graphs (poly-brain, poly-research) and the read-only work-prioritizer are composed in
 *   `@cogni/poly-graphs` and `app/src/bootstrap/ai/node-catalog.ts` (story.0090 pruning, as node-template#299).
 * Invariants:
 *   - PACKAGES_NO_SRC_IMPORTS: No imports from src/**
 *   - CATALOG_SINGLE_SOURCE_OF_TRUTH: shared graphs come from the published release, never re-authored here.
 * Side-effects: none
 * @public
 */

import { NODE_LANGGRAPH_CATALOG as SHARED_NODE_CATALOG } from "@cogni/shared-langgraph-graphs";
import type { CreateGraphFn } from "./inproc/types";

/**
 * Catalog entry shape.
 *
 * Per TOOL_CATALOG_IS_CANONICAL: graphs reference tools by ID, not by BoundTool.
 */
interface CatalogEntry {
  readonly displayName: string;
  /** Runs through the shared guarded runtime (in-process only). */
  readonly sharedRuntime?: boolean;
  readonly description: string;
  /** Native tool IDs this graph may use. Providers resolve from TOOL_CATALOG. */
  readonly toolIds: readonly string[];
  /** MCP server names whose tools this graph may use. Empty = no MCP tools. */
  readonly mcpServerIds?: readonly string[];
  readonly graphFactory: CreateGraphFn;
  readonly systemPrompt?: string;
}

/** LangGraph catalog - the published shared coordinator. */
export const LANGGRAPH_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  cogni: { ...SHARED_NODE_CATALOG.cogni, sharedRuntime: true },
} as const;

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
  "poly-brain": `${LANGGRAPH_PROVIDER_ID}:poly-brain`,
  "poly-research": `${LANGGRAPH_PROVIDER_ID}:poly-research`,
} as const;

/**
 * Union type of all valid LangGraph graph IDs.
 */
export type LangGraphGraphId =
  (typeof LANGGRAPH_GRAPH_IDS)[keyof typeof LANGGRAPH_GRAPH_IDS];

/**
 * Default graph ID: Poly's own analyst.
 */
export const DEFAULT_LANGGRAPH_GRAPH_ID = LANGGRAPH_GRAPH_IDS["poly-brain"];

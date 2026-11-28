// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/catalog`
 * Purpose: The namespaced graph ids this node's graph package names. The node's one composed catalog is built in the app
 *   (`@bootstrap/ai/node-catalog`) with `createNodeCatalog`, because Poly's own graphs live in `@cogni/poly-graphs`, which depends on this package.
 * Scope: Constants and id types only. Holds no catalog entry and no graph. Does NOT import from src/.
 * Invariants:
 *   - ONE_COMPOSED_CATALOG: the node has a single catalog (`POLY_NODE_LANGGRAPH_CATALOG`); this module does not build a second one
 *   - PACKAGES_NO_SRC_IMPORTS: No imports from src/**
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/inproc-provider-package-design, https://node-template.cognidao.org/knowledge/node-plugin-architecture
 * @public
 */

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
 * Union type of the shared graph IDs.
 */
export type LangGraphGraphId =
  (typeof LANGGRAPH_GRAPH_IDS)[keyof typeof LANGGRAPH_GRAPH_IDS];

/**
 * Default graph ID.
 */
export const DEFAULT_LANGGRAPH_GRAPH_ID = LANGGRAPH_GRAPH_IDS.cogni;

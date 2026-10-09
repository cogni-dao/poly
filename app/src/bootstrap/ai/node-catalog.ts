// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/ai/node-catalog`
 * Purpose: THIS node's LangGraph catalog — the shared base catalog plus the poly
 *   graphs this node runs, with each graph's tool allowlist declared as app
 *   runtime policy. Before this module, `@cogni/poly-graphs` was a workspace
 *   member that `app` did not depend on and `app/src` never imported, so
 *   `langgraph:poly-brain` — which the chat composer has offered all along —
 *   resolved to `not_found` in the provider and had never once executed.
 * Scope: Catalog composition only. Declares no graph, holds no tool
 *   implementation, and performs no IO. It lives in `bootstrap` — the
 *   composition root — and is INJECTED into the execution and discovery
 *   providers rather than imported by them, so those adapters stay
 *   node-agnostic and discovery can never list a graph execution cannot run.
 * Invariants:
 *   - NODE_RUNTIME_CATALOG_BOUNDARY (docs/spec/langgraph-patterns.md:49) — app
 *     runtimes get their catalog from the node, not from shared
 *     `@cogni/langgraph-graphs`, which owns reusable graph implementations and
 *     base catalogs but NOT app runtime policy. Every app consumer of a catalog
 *     now imports this module.
 *   - BASE_IS_SPREAD_NEVER_EDITED — the shared catalog is spread, so new shared
 *     graphs appear here automatically and nothing in `packages/**` is mutated.
 *   - TOOL_ALLOWLIST_IS_APP_POLICY — `toolIds` is declared HERE rather than
 *     imported from graph capability metadata. The runtime grant must stay
 *     reviewable against the node's actually bound tool sources, and it may be
 *     narrower than what a graph package can describe in principle.
 *   - NO_LANGCHAIN_IN_SRC — graph FACTORIES are imported as opaque values from
 *     the graph packages. Nothing here imports `@langchain/*`.
 * Side-effects: none
 * Links: task.1791070967, task.1791070993, story.5017,
 *   docs/spec/langgraph-patterns.md, docs/spec/capability-plane.md
 * @internal
 */

import {
  EDO_HYPOTHESIZE_NAME,
  GET_CURRENT_TIME_NAME,
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  REPO_LIST_NAME,
  REPO_OPEN_NAME,
  REPO_SEARCH_NAME,
  WEB_SEARCH_NAME,
  WORK_ITEM_QUERY_NAME,
} from "@cogni/ai-tools";
import {
  type CreateGraphFn,
  LANGGRAPH_CATALOG,
} from "@cogni/langgraph-graphs";
import {
  createPolyBrainGraph,
  POLY_BRAIN_GRAPH_NAME,
} from "@cogni/poly-graphs";

import type { LangGraphCatalog } from "@/adapters/server/ai/langgraph/catalog";

/**
 * Tool allowlist for `poly-brain` on this node.
 *
 * Scoped to the node's bound evidence tools and exactly one durable write: a
 * falsifiable EDO hypothesis for the selected next experiment. This list is
 * deliberately app policy rather than blindly reusing package capability
 * metadata.
 *
 * Deliberately excludes generic knowledge writes, work-item transitions,
 * schedules, wallets, target policy, algorithms, orders, and trades.
 */
export const POLY_BRAIN_NODE_TOOL_IDS: readonly string[] = [
  GET_CURRENT_TIME_NAME,
  KNOWLEDGE_SEARCH_NAME,
  KNOWLEDGE_READ_NAME,
  WORK_ITEM_QUERY_NAME,
  REPO_LIST_NAME,
  REPO_SEARCH_NAME,
  REPO_OPEN_NAME,
  WEB_SEARCH_NAME,
  EDO_HYPOTHESIZE_NAME,
];

/**
 * This node's catalog: the shared base, plus `poly-brain`.
 *
 * `poly-brain` is keyed by `POLY_BRAIN_GRAPH_NAME` ("poly-brain"), which is what
 * makes `langgraph:poly-brain` — already offered by
 * `features/ai/components/ChatComposerExtras.tsx` — resolve for the first time.
 */
export const POLY_NODE_LANGGRAPH_CATALOG: LangGraphCatalog<CreateGraphFn> = {
  ...(LANGGRAPH_CATALOG as LangGraphCatalog<CreateGraphFn>),
  [POLY_BRAIN_GRAPH_NAME]: {
    displayName: "Poly Brain",
    description:
      "Recurring DAO-objective reviewer that compares evidence-backed ethical-profit directions, persists one hypothesis, and proposes one next experiment",
    toolIds: POLY_BRAIN_NODE_TOOL_IDS,
    // Cast for the same reason the shared catalog is cast above: the factory's
    // return type is deliberately unannotated (TYPE_TRANSPARENT_RETURN), so its
    // emitted declaration is a deep inferred `CompiledStateGraph` naming
    // `@langchain/langgraph` types resolved through the graph package's own
    // node_modules. Structural identity with `CompiledGraph` then depends on
    // pnpm deduping that dependency across two workspace packages, which is an
    // assumption about the installer rather than about this code.
    graphFactory: createPolyBrainGraph as CreateGraphFn,
  },
};

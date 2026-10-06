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
 *   - TOOL_ALLOWLIST_IS_APP_POLICY — `toolIds` is declared HERE, deliberately
 *     not reused from `POLY_BRAIN_TOOL_IDS` in `@cogni/poly-graphs`. That
 *     constant names `core__market_list` and `core__wallet_top_traders`, which
 *     live in `POLY_TOOL_BUNDLE` (`@cogni/poly-ai-tools`); binding that bundle
 *     needs a `dataApiClient` wired in `app/src/bootstrap/container.ts`, a
 *     port-frozen P0 entry. Those tools are out of reach of this change, and a
 *     catalog entry naming a tool the source cannot resolve logs "graph
 *     misconfigured" per tool on every run AND hands the model a tool it cannot
 *     use. Which tools a node has actually BOUND is app runtime policy; which
 *     tools a graph could use in principle is the package's business.
 *   - NO_LANGCHAIN_IN_SRC — graph FACTORIES are imported as opaque values from
 *     the graph packages. Nothing here imports `@langchain/*`.
 * Side-effects: none
 * Links: task.1791070967, story.5006, docs/spec/langgraph-patterns.md,
 *   docs/spec/capability-plane.md
 * @internal
 */

import { WEB_SEARCH_NAME } from "@cogni/ai-tools";
import {
  type CreateGraphFn,
  LANGGRAPH_CATALOG,
} from "@cogni/langgraph-graphs";
import {
  createPolyBrainGraph,
  POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
  POLY_BRAIN_GRAPH_NAME,
} from "@cogni/poly-graphs";

import type { LangGraphCatalog } from "@/adapters/server/ai/langgraph/catalog";

/**
 * Tool allowlist for `poly-brain` on this node.
 *
 * Scoped to exactly what this node can bind today: web research, and ONE
 * account-read capability answered with the signed-in user's principal. See
 * TOOL_ALLOWLIST_IS_APP_POLICY for why the market-data tools are absent and why
 * this list is not `POLY_BRAIN_TOOL_IDS`.
 *
 * Deliberately contains NO write-capable tool. `core__poly_place_trade` stays
 * unbound (removed from `POLY_TOOL_BUNDLE` post-bug.0319) and story.5006 adds no
 * write scope.
 */
export const POLY_BRAIN_NODE_TOOL_IDS: readonly string[] = [
  WEB_SEARCH_NAME,
  POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
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
      "Prediction-market analyst that can read this account's own saved copy-trade order ledger and research events on the web",
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

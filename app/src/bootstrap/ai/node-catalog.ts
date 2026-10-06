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
 *   implementation, and performs no IO. It lives in `bootstrap` rather than
 *   beside the provider because it must name an app-local tool id from
 *   `@features/agent-tools`, and `adapters` must NOT import `features` — a
 *   boundary this repo actually keeps (see
 *   `adapters/__arch_probes__/fail_adapters_imports_features.ts`; there are zero
 *   real violations). Bootstrap is the composition root, so the catalog is
 *   INJECTED into the two providers rather than imported by them, which also
 *   keeps those adapters node-agnostic and reusable.
 * Invariants:
 *   - NODE_RUNTIME_CATALOG_BOUNDARY (docs/spec/langgraph-patterns.md:49) — app
 *     runtimes get their catalog from the node, not from shared
 *     `@cogni/langgraph-graphs`, which owns reusable graph implementations and
 *     base catalogs but NOT app runtime policy. Every app consumer of a catalog
 *     now imports this module.
 *   - BASE_IS_SPREAD_NEVER_EDITED — the shared catalog is spread, so new shared
 *     graphs appear here automatically and nothing in `packages/**` is mutated.
 *   - TOOL_ALLOWLIST_IS_APP_POLICY — `toolIds` is declared HERE, deliberately
 *     not reused from `POLY_BRAIN_TOOL_IDS` in `@cogni/poly-graphs`. Two reasons,
 *     both binding rather than stylistic:
 *       1. That constant names `core__market_list` and
 *          `core__wallet_top_traders`, which live in `POLY_TOOL_BUNDLE`
 *          (`@cogni/poly-ai-tools`). Binding that bundle needs a `dataApiClient`
 *          wired in `app/src/bootstrap/container.ts`, which is a port-frozen P0
 *          entry. Those tools are therefore out of reach of this change, and a
 *          catalog entry that lists tools the source cannot resolve logs
 *          "graph misconfigured" per tool on every run.
 *       2. `core__poly_account_copy_trade_orders` is declared in `app/src`
 *          (because `packages/poly-ai-tools/src/index.ts` is port-frozen P1),
 *          and `PACKAGES_NO_SRC_IMPORTS` forbids a package from importing it.
 *          No allowlist naming it can live in a package. The boundary spec and
 *          the freeze gate agree: this is the catalog's correct home.
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
import { createPolyBrainGraph, POLY_BRAIN_GRAPH_NAME } from "@cogni/poly-graphs";

import type { LangGraphCatalog } from "@/adapters/server/ai/langgraph/catalog";
import { POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME } from "@/features/agent-tools";

/**
 * Tool allowlist for `poly-brain` on this node.
 *
 * Scoped to exactly what this node can bind today: web research, and ONE
 * account-read capability answered with the signed-in user's principal. See
 * TOOL_ALLOWLIST_IS_APP_POLICY for why the market-data tools are absent and why
 * this list is not imported from the graph package.
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

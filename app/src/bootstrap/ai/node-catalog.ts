// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/ai/node-catalog`
 * Purpose: THIS node's ONE LangGraph catalog: the published catalog (`@cogni-dao/langgraph-graphs`) composed with
 *   `createNodeCatalog` for Poly's own graphs (`poly-brain`, `poly-research`), one narrowing (`work-prioritizer` read-only) and
 *   one omission (`work-closeout`).
 * Scope: Catalog composition only. Declares no graph, holds no tool implementation, and performs no IO. It lives in `bootstrap`,
 *   the composition root, and feeds every consumer: the in-process provider, agent discovery, the dev providers, the access table
 *   (`agent-authority`) and the dev routing. A second catalog is a defect.
 * Invariants:
 *   - ONE_COMPOSED_CATALOG (https://node-template.cognidao.org/knowledge/inproc-provider-package-design) - `add`, `narrow` and
 *     `omit` are the only ways Poly changes the published catalog. No spread decides which entry wins, and `createNodeCatalog`
 *     rebuilds `cogni` so its prompt and workflow guidance list exactly the graphs below.
 *   - TOOL_ALLOWLIST_IS_APP_POLICY - `toolIds` of Poly's own graphs is declared HERE, not reused from `POLY_BRAIN_TOOL_IDS` /
 *     `POLY_RESEARCH_TOOL_IDS` in `@cogni/poly-graphs`. Those name tools that live in `POLY_TOOL_BUNDLE` (`@cogni/poly-ai-tools`),
 *     which this node does not bind. A catalog entry naming a tool the source cannot resolve hands the model a tool it cannot
 *     use. Which tools a node has BOUND is app runtime policy; which tools a graph could use in principle is the package's business.
 *   - EVERY_OFFERED_TOOL_IS_READ_ONLY - neither Poly graph offers a tool that is not `read_only`, so neither needs a principal or a
 *     `requires` scope. A graph with a non-`read_only` tool needs a seeded principal and a declared scope first.
 *   - GRAPHS_POLY_DOES_NOT_RUN - the template carried `brain`, `poet`, `ponderer`, `research`, `browser`, `frontend-tester`, `autoresearch-*`,
 *     `pr-review`, `operating-review` and `git-reviewer`. `cc263599` (story.0090) dropped them and the PR-review dispatch
 *     (`features/review`, `dispatchPrReview` in the webhook route) with no replacement. They are NOT renamed: `poly-brain` and `poly-research`
 *     are Poly's own graphs, and the template's `brain` (repo-aware agent) and `research` (plan, search, rank) are different graphs. The
 *     dispatch only ran when `GH_REVIEW_APP_ID` and `GH_REVIEW_APP_PRIVATE_KEY_BASE64` were set, and neither is declared in Poly's
 *     `.cogni` secrets or workloads, so no review ever ran. A stored schedule that names a dropped graph (`langgraph:brain` on candidate-a:
 *     five disabled rows, never run) answers `not_found` at its tick. No migration re-points them; before a production promote, list enabled
 *     `schedules` rows whose `graph_id` is none of the four graphs below and let their owners decide.
 *   - NO_LANGCHAIN_IN_SRC - graph FACTORIES are imported as opaque values from the graph packages. Nothing here imports `@langchain/*`.
 * Side-effects: none
 * Links: story.0090, task.1791070967, story.5006, https://node-template.cognidao.org/knowledge/inproc-provider-package-design,
 *   https://node-template.cognidao.org/knowledge/node-plugin-architecture, https://poly.cognidao.org/knowledge/poly-graph-catalog-binding,
 *   https://node-template.cognidao.org/knowledge/graph-execution-invariants
 * @internal
 */

import { WEB_SEARCH_NAME } from "@cogni/ai-tools";
import {
  type CatalogEntry,
  type CreateGraphFn,
  createNodeCatalog,
  type LangGraphCatalog,
  SHARED_LANGGRAPH_CATALOG,
} from "@cogni/langgraph-graphs";
import {
  createPolyBrainGraph,
  createPolyResearchGraph,
  POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
  POLY_BRAIN_GRAPH_NAME,
  POLY_RESEARCH_GRAPH_NAME,
} from "@cogni/poly-graphs";

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
 * Tool allowlist for `poly-research` on this node.
 *
 * Its Data-API tools (`core__poly_data_*`), `core__market_list` and `core__wallet_top_traders` live in `POLY_TOOL_BUNDLE`, which
 * this node does not bind, and `core__poly_data_user_pnl_summary` is `state_change` with no `requires`, so the guard would deny
 * it. Only web research is bound and read-only, so that is what the graph is offered; `POLY_RESEARCH_TOOL_IDS` stays the package's
 * statement of what it could use in principle. Adding a Data-API tool is a separate change: bind it, then name it here.
 */
export const POLY_RESEARCH_NODE_TOOL_IDS: readonly string[] = [WEB_SEARCH_NAME];

/** Poly's own graphs. Factories are cast for the same reason as before: their emitted declaration is a deep inferred `CompiledStateGraph`. */
const POLY_GRAPHS: Readonly<Record<string, CatalogEntry>> = {
  [POLY_BRAIN_GRAPH_NAME]: {
    displayName: "Poly Brain",
    description:
      "Prediction-market analyst that can read this account's own saved copy-trade order ledger and research events on the web",
    toolIds: POLY_BRAIN_NODE_TOOL_IDS,
    graphFactory: createPolyBrainGraph as CreateGraphFn,
  },
  [POLY_RESEARCH_GRAPH_NAME]: {
    displayName: "Poly Research",
    description:
      "Patient wallet-research analyst that profiles proxy-wallets and returns a structured research report; on this node it researches the web",
    toolIds: POLY_RESEARCH_NODE_TOOL_IDS,
    graphFactory: createPolyResearchGraph as CreateGraphFn,
  },
};

/** Poly's work-prioritizer reads and reports; it writes nothing (no update, no artifact record). */
const READ_ONLY_NOTE =
  "READ-ONLY ON THIS NODE: triage writes are off, so core__work_item_update and core__work_item_artifact_record are not available. Do not try to change any item. Read as above, then report in your final answer the routes, scores and cancels you would make, one line per item, with the reason for each. Reporting them satisfies the run; ignore the instruction to write.";

/**
 * This node's catalog.
 *
 * - `cogni`: the published entry; `createNodeCatalog` rebuilds its prompt and guidance over the composed set.
 * - `work-prioritizer`: the published entry (principal `prioritizer`, seeded by migration 0092), narrowed to read-only.
 * - `work-closeout`: omitted. It holds `core__work_item_update`, a writer Poly does not run.
 * - `poly-brain`, `poly-research`: Poly's own graphs.
 */
export const POLY_NODE_LANGGRAPH_CATALOG: LangGraphCatalog = createNodeCatalog(
  SHARED_LANGGRAPH_CATALOG,
  {
    add: POLY_GRAPHS,
    narrow: {
      "work-prioritizer": {
        removeToolIds: [
          "core__work_item_update",
          "core__work_item_artifact_record",
        ],
        appendPrompt: READ_ONLY_NOTE,
      },
    },
    omit: ["work-closeout"],
  }
);

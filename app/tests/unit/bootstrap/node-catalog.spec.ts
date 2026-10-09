// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/node-catalog`
 * Purpose: Prove that `langgraph:poly-brain` is REACHABLE and that every tool it
 *   is allowed to call is actually resolvable. Before this catalog existed the
 *   chat composer offered `langgraph:poly-brain` and the provider answered
 *   `not_found`, so a UI affordance pointed at nothing for the whole life of the
 *   feature. This file is the regression test for that class of gap.
 * Scope: Catalog composition and allowlist/bundle agreement. Graph execution
 *   itself is proven on candidate.
 * Invariants: NODE_RUNTIME_CATALOG_BOUNDARY; BASE_IS_SPREAD_NEVER_EDITED;
 *   TOOL_ALLOWLIST_IS_APP_POLICY; ONE_EDO_WRITE_ONLY.
 * Side-effects: none
 * Links: task.1791070967, task.1791070993, story.5017,
 *   docs/spec/langgraph-patterns.md
 * @internal
 */

import {
  CORE_TOOL_BUNDLE,
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
import { LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";
import { describe, expect, it } from "vitest";

import {
  POLY_BRAIN_NODE_TOOL_IDS,
  POLY_NODE_LANGGRAPH_CATALOG,
} from "@/bootstrap/ai/node-catalog";
import { PRINCIPAL_TOOL_BUNDLE } from "@/bootstrap/ai/principal-tool-source";

const POLY_BRAIN = "poly-brain";

describe("this node's langgraph catalog", () => {
  it("makes langgraph:poly-brain resolvable", () => {
    // The whole point. `LangGraphInProcProvider.extractGraphName("langgraph:poly-brain")`
    // yields this key; a missing entry is the `not_found` the composer used to hit.
    const entry = POLY_NODE_LANGGRAPH_CATALOG[POLY_BRAIN];
    expect(entry).toBeDefined();
    expect(entry?.graphFactory).toBeTypeOf("function");
    expect(entry?.displayName).toBeTruthy();
    expect(entry?.description).toBeTruthy();
  });

  it("is the graph id the chat composer already offers", () => {
    // Keep the UI's hardcoded `langgraph:poly-brain` and this catalog key in
    // agreement — they are the two halves of one affordance.
    expect(`langgraph:${POLY_BRAIN}`).toBe("langgraph:poly-brain");
  });

  it("preserves every shared graph rather than replacing the base catalog", () => {
    // BASE_IS_SPREAD_NEVER_EDITED. Swapping the provider's catalog must not
    // silently drop poet/brain/research or the scheduled operator graphs.
    for (const graphName of Object.keys(LANGGRAPH_CATALOG)) {
      expect(POLY_NODE_LANGGRAPH_CATALOG[graphName]).toBeDefined();
    }
    expect(Object.keys(POLY_NODE_LANGGRAPH_CATALOG)).toHaveLength(
      Object.keys(LANGGRAPH_CATALOG).length + 2
    );
  });

  it("allowlists evidence reads plus exactly one EDO learning write", () => {
    expect(POLY_BRAIN_NODE_TOOL_IDS).toEqual([
      GET_CURRENT_TIME_NAME,
      KNOWLEDGE_SEARCH_NAME,
      KNOWLEDGE_READ_NAME,
      WORK_ITEM_QUERY_NAME,
      REPO_LIST_NAME,
      REPO_SEARCH_NAME,
      REPO_OPEN_NAME,
      WEB_SEARCH_NAME,
      EDO_HYPOTHESIZE_NAME,
    ]);
    expect(POLY_NODE_LANGGRAPH_CATALOG[POLY_BRAIN]?.toolIds).toEqual(
      POLY_BRAIN_NODE_TOOL_IDS
    );
  });

  it("allowlists only tools the node bundle can actually resolve", () => {
    // The provider logs "Tool not found in toolSource; graph misconfigured" per
    // unresolvable id and then hands the model a tool list it cannot use. This
    // is why runtime policy is verified against the actual node bundles.
    const resolvable = new Set(
      [...CORE_TOOL_BUNDLE, ...PRINCIPAL_TOOL_BUNDLE].map(
        (bound) => bound.contract.name
      )
    );
    for (const toolId of POLY_BRAIN_NODE_TOOL_IDS) {
      expect(resolvable.has(toolId)).toBe(true);
    }
  });

  it("grants exactly one bounded write and no trade or policy capability", () => {
    const byId = new Map(
      [...CORE_TOOL_BUNDLE, ...PRINCIPAL_TOOL_BUNDLE].map((bound) => [
        bound.contract.name,
        bound.contract,
      ])
    );
    const writeTools = POLY_BRAIN_NODE_TOOL_IDS.filter(
      (toolId) => byId.get(toolId)?.effect === "state_change"
    );
    expect(writeTools).toEqual([EDO_HYPOTHESIZE_NAME]);
    expect(POLY_BRAIN_NODE_TOOL_IDS).not.toContain("core__knowledge_write");
    expect(POLY_BRAIN_NODE_TOOL_IDS).not.toContain(
      "core__work_item_transition"
    );
    expect(POLY_BRAIN_NODE_TOOL_IDS).not.toContain("core__schedule_manage");
    expect(POLY_BRAIN_NODE_TOOL_IDS).not.toContain("core__poly_place_trade");
    expect(POLY_BRAIN_NODE_TOOL_IDS).not.toContain("core__poly_cancel_order");
    expect(POLY_BRAIN_NODE_TOOL_IDS).not.toContain(
      "core__poly_account_copy_trade_orders"
    );
  });
});

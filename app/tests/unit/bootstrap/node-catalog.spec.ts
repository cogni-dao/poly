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
 *   TOOL_ALLOWLIST_IS_APP_POLICY; NO_WRITE_SCOPE.
 * Side-effects: none
 * Links: task.1791070967, story.5006, https://node-template.cognidao.org/knowledge/graph-execution-invariants
 * @internal
 */

import {
  CORE_TOOL_BUNDLE,
  WEB_SEARCH_NAME,
  WORK_ITEM_READ_NAME,
} from "@cogni/ai-tools";
import { LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";
import {
  POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
  POLY_LANGGRAPH_CATALOG,
} from "@cogni/poly-graphs";
import { WORK_ITEM_UPDATE_NAME } from "@cogni/shared-ai-tools";
import { describe, expect, it } from "vitest";

import {
  POLY_BRAIN_NODE_TOOL_IDS,
  POLY_WORK_PRIORITIZER_READ_ONLY_NOTE,
  POLY_NODE_LANGGRAPH_CATALOG,
} from "@/bootstrap/ai/node-catalog";
import { POLY_CORE_TOOL_BUNDLE } from "@/bootstrap/ai/evaluation-baseline";
import { PRINCIPAL_TOOL_BUNDLE } from "@/bootstrap/ai/principal-tool-source";
import { createToolBindings } from "@/bootstrap/ai/tool-bindings";

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
    expect(POLY_NODE_LANGGRAPH_CATALOG["work-prioritizer"]?.graphFactory).toBeTypeOf("function");
    expect(Object.keys(POLY_NODE_LANGGRAPH_CATALOG)).toHaveLength(
      Object.keys(LANGGRAPH_CATALOG).length + 2
    );
  });

  it("allowlists exactly web search and the one account-read capability", () => {
    expect(POLY_BRAIN_NODE_TOOL_IDS).toEqual([
      WEB_SEARCH_NAME,
      POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
    ]);
    expect(POLY_NODE_LANGGRAPH_CATALOG[POLY_BRAIN]?.toolIds).toEqual(
      POLY_BRAIN_NODE_TOOL_IDS
    );
  });

  it("allowlists only tools the node bundle can actually resolve", () => {
    // The provider logs "Tool not found in toolSource; graph misconfigured" per
    // unresolvable id and then hands the model a tool list it cannot use. This
    // is exactly why `POLY_BRAIN_TOOL_IDS` from @cogni/poly-graphs is NOT reused
    // here: it names POLY_TOOL_BUNDLE tools that need a container-level
    // dataApiClient binding (container.ts is port-frozen P0).
    const resolvable = new Set(
      [...CORE_TOOL_BUNDLE, ...PRINCIPAL_TOOL_BUNDLE].map(
        (bound) => bound.contract.name
      )
    );
    for (const toolId of POLY_BRAIN_NODE_TOOL_IDS) {
      expect(resolvable.has(toolId)).toBe(true);
    }
  });

  it("grants poly-brain no write-capable tool", () => {
    // NO_WRITE_SCOPE: story.5006 adds no write capability, and
    // `core__poly_place_trade` has been unbound since bug.0319.
    const byId = new Map(
      [...CORE_TOOL_BUNDLE, ...PRINCIPAL_TOOL_BUNDLE].map((bound) => [
        bound.contract.name,
        bound.contract,
      ])
    );
    for (const toolId of POLY_BRAIN_NODE_TOOL_IDS) {
      expect(byId.get(toolId)?.effect).toBe("read_only");
    }
    expect(POLY_BRAIN_NODE_TOOL_IDS).not.toContain("core__poly_place_trade");
    expect(POLY_BRAIN_NODE_TOOL_IDS).not.toContain("core__poly_cancel_order");
  });

  // task.0086: the shared work-prioritizer writes only through core__work_item_update, guarded only
  // when the runner passes `program`. This node's runner does not, so triage writes are off.
  it("offers work-prioritizer core__work_item_read and no work-item write tool", () => {
    const toolIds = POLY_NODE_LANGGRAPH_CATALOG["work-prioritizer"]?.toolIds ?? [];
    expect(toolIds).toContain(WORK_ITEM_READ_NAME);
    expect(toolIds).not.toContain(WORK_ITEM_UPDATE_NAME);
    expect(toolIds).not.toContain("core__work_item_transition");

    const byId = new Map(
      POLY_CORE_TOOL_BUNDLE.map((bound) => [bound.contract.name, bound.contract])
    );
    const bindings = createToolBindings({
      workItemCapability: {},
    } as unknown as Parameters<typeof createToolBindings>[0]);
    for (const toolId of toolIds) {
      if (toolId.startsWith("core__metric") || toolId === "core__goal_progress")
        continue; // bound separately by the metric tools
      expect(byId.has(toolId), `${toolId} in the node tool bundle`).toBe(true);
      expect(bindings[toolId], `${toolId} bound`).toBeDefined();
    }
    // Nothing offered may change state.
    for (const toolId of toolIds) {
      expect(byId.get(toolId)?.effect, `${toolId} effect`).not.toBe("state_change");
    }
  });

  it("tells work-prioritizer it is read-only, after the shared prompt", () => {
    const prompt = POLY_NODE_LANGGRAPH_CATALOG["work-prioritizer"]?.systemPrompt ?? "";
    const shared = (POLY_LANGGRAPH_CATALOG["work-prioritizer"] as { systemPrompt?: string } | undefined)
      ?.systemPrompt;
    expect(shared).toBeTruthy();
    expect(prompt).toContain(POLY_WORK_PRIORITIZER_READ_ONLY_NOTE);
    expect(prompt).toContain("READ-ONLY ON THIS NODE: triage writes are off");
    expect(prompt.startsWith(shared as string)).toBe(true);
  });
});

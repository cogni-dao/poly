// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/langgraph/poly-graphs`
 * Purpose: Poly's own graphs keep working on the shared in-process provider (story.0090 "custom graphs remain functional"): poly-brain and poly-research run, are offered exactly their read-only tools, and execute a tool through the package guard.
 * Scope: Real composed catalog, real tool contracts and bindings, real package provider and runner; the model, the search backend and the account read are fakes. Does NOT call an LLM or a network.
 * Invariants:
 *   - POLY_GRAPHS_RUN: each of the two graphs completes a run that calls its web-search tool, with no principal
 *   - OFFERED_TOOLS_ARE_THE_ALLOWLIST: the model is offered exactly the catalog's tool ids, none withheld by the guard and none added
 *   - UNKNOWN_GRAPH_IS_NOT_FOUND: a graph Poly does not run still answers `not_found`
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/inproc-provider-package-design
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import { describe, expect, it, vi } from "vitest";

import { runInScope } from "@/adapters/server/ai/execution-scope";
import {
  type CompletionUnitAdapter,
  LangGraphInProcProvider,
} from "@/adapters/server/ai/langgraph/inproc.provider";
import { POLY_CORE_TOOL_BUNDLE } from "@/bootstrap/ai/evaluation-baseline";
import { POLY_NODE_LANGGRAPH_CATALOG } from "@/bootstrap/ai/node-catalog";
import {
  composeToolSources,
  createPrincipalToolSource,
  PRINCIPAL_TOOL_BUNDLE,
} from "@/bootstrap/ai/principal-tool-source";
import { createBoundToolSource } from "@/bootstrap/ai/tool-source.factory";
import { createToolBindings } from "@/bootstrap/ai/tool-bindings";
import type { GraphRunRequest } from "@/ports";

const USER = "dfa8570f-d487-4239-b40a-2e39ee4513f9";
const SEARCH = "core__web_search";
const ACCOUNT = "core__poly_account_copy_trade_orders";

const SCOPE = {
  actorUserId: USER,
  billing: { billingAccountId: "account", virtualKeyId: "key" },
  usageSource: "litellm" as const,
  llmService: {},
} as never;

function toolSource(searches: string[]) {
  const bindings = createToolBindings({
    webSearchCapability: {
      search: async (params: { query: string }) => {
        searches.push(params.query);
        return { results: [{ title: "t", url: "https://example.com", content: "c" }] };
      },
    },
  } as unknown as Parameters<typeof createToolBindings>[0]);
  const base = createBoundToolSource(
    POLY_CORE_TOOL_BUNDLE.filter((bound) => bound.contract.name === SEARCH),
    bindings
  );
  // The per-request principal tool is served by the real overlay; its database is never touched unless the model calls the tool.
  const overlay = createPrincipalToolSource({
    principalId: USER,
    resolveDb: () => {
      throw new Error("the account read is not called in this test");
    },
  });
  return composeToolSources(overlay, base);
}

async function run(
  graph: string,
  options: {
    callSearch: boolean;
    seeded?: boolean;
    unattended?: boolean;
    looked?: string[];
  }
) {
  let model = 0;
  const completion = {
    executeCompletionUnit: vi.fn(() => {
      model++;
      const call = options.callSearch && model === 1;
      return {
        stream: (async function* () {})() as AsyncIterable<AiEvent>,
        final: Promise.resolve(
          call
            ? {
                ok: true as const,
                content: "",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "call-1",
                    type: "function" as const,
                    function: {
                      name: SEARCH,
                      arguments: JSON.stringify({ query: "who leads the market" }),
                    },
                  },
                ],
              }
            : { ok: true as const, content: "done", finishReason: "stop" }
        ),
      };
    }),
  } as unknown as CompletionUnitAdapter & {
    executeCompletionUnit: ReturnType<typeof vi.fn>;
  };
  const searches: string[] = [];
  const provider = new LangGraphInProcProvider({
    catalog: POLY_NODE_LANGGRAPH_CATALOG,
    completion,
    tools: toolSource(searches),
    toolBundle: [...POLY_CORE_TOOL_BUNDLE, ...PRINCIPAL_TOOL_BUNDLE],
    sourceContext: async () => ({
      nodeId: "poly",
      origin: "https://poly.cognidao.org",
      mission: { content: "Poly", sourceRef: "fixture", buildSha: null },
      governingIndex: [],
    }),
    // Poly's own graphs offer no scoped tool, so they never read the authority; the prioritizer's principal lock does.
    authority: {
      resolvePrincipal: async (slug: string) => {
        options.looked?.push(slug);
        return options.seeded === false ? null : `${slug}-principal`;
      },
      guardDeps: {
        withStore: async (fn: (store: unknown) => unknown) =>
          fn({ liveScopes: async () => [], hasLiveRole: async () => false }),
        adminCheck: async () => "denied" as const,
      },
    } as never,
  });
  const req = {
    runId: "run",
    graphId: `langgraph:${graph}`,
    messages: [{ role: "user", content: "research it" }],
    modelRef: { providerKey: "platform", modelId: "model" },
  } as unknown as GraphRunRequest;
  return runInScope(SCOPE, async () => {
    const result = provider.runGraph(req, {
      actorUserId: USER,
      ...(options.unattended ? { unattended: true as const } : {}),
    });
    for await (const _event of result.stream) {
      /* drain */
    }
    const final = await result.final;
    const first = completion.executeCompletionUnit.mock.calls[0]?.[0] as
      | { tools?: { function: { name: string } }[] }
      | undefined;
    return {
      final,
      searches,
      modelCalls: completion.executeCompletionUnit.mock.calls.length,
      offered: (first?.tools ?? []).map((tool) => tool.function.name),
    };
  });
}

describe("Poly's own graphs on the shared provider", () => {
  it("poly-brain runs, is offered web search and the account read, and executes a search through the guard", async () => {
    const result = await run("poly-brain", { callSearch: true });
    expect(result.final.ok).toBe(true);
    expect([...result.offered].sort()).toEqual([ACCOUNT, SEARCH].sort());
    expect(result.searches).toEqual(["who leads the market"]);
    expect(result.modelCalls).toBe(2);
  });

  it("poly-research runs, is offered exactly the tools this node binds, and executes a search through the guard", async () => {
    const result = await run("poly-research", { callSearch: true });
    expect(result.final.ok).toBe(true);
    expect(result.offered).toEqual([SEARCH]);
    expect(result.searches).toEqual(["who leads the market"]);
    expect(result.modelCalls).toBe(2);
  });

  it("looks up the seeded prioritizer principal for the narrowed work-prioritizer, and offers it no write tool", async () => {
    const looked: string[] = [];
    const result = await run("work-prioritizer", {
      callSearch: false,
      unattended: true,
      looked,
    });
    // The graph's program reads need the container's knowledge and goal tools, which this test does not bind; what matters here is the lock.
    expect(looked).toEqual(["prioritizer"]);
    expect(result.offered).not.toContain("core__work_item_update");
    expect(result.offered).not.toContain("core__work_item_artifact_record");
  });

  it("refuses the work-prioritizer before any model call when its principal is not seeded", async () => {
    const result = await run("work-prioritizer", {
      callSearch: false,
      seeded: false,
    });
    expect(result.final.ok).toBe(false);
    expect(result.modelCalls).toBe(0);
  });

  it("answers not_found for a graph Poly does not run, including the omitted work-closeout", async () => {
    for (const graph of ["work-closeout", "red-solver", "nonexistent"]) {
      const result = await run(graph, { callSearch: false });
      expect(result.final.ok).toBe(false);
      if (!result.final.ok) expect(result.final.error).toBe("not_found");
      expect(result.modelCalls).toBe(0);
    }
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/langgraph/shared-cogni-prompt`
 * Purpose: The prompt the package provider hands the model is the node's composed one, not the released template's.
 * Scope: Poly's REAL composed catalog, the real package provider and runner; only the billed completion is a fake, to capture the system prompt it receives.
 * Invariants: PROMPT_MATCHES_NODE: the coordinator prompt reaching the runner names no `work-closeout`, no `core__work_item_update`
 *   and no `core__work_item_artifact_record`, and still lists the workflows this node runs.
 * Side-effects: none
 * Links: src/adapters/server/ai/langgraph/inproc.provider.ts, src/bootstrap/ai/node-catalog.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/observability", async () => ({
  EVENT_NAMES: {},
  failureFields: () => ({}),
  makeLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

import { runInScope } from "@/adapters/server/ai/execution-scope";
import { LangGraphInProcProvider } from "@/adapters/server/ai/langgraph/inproc.provider";
import { POLY_NODE_LANGGRAPH_CATALOG } from "@/bootstrap/ai/node-catalog";

const actor = "dfa8570f-d487-4239-b40a-2e39ee4513f9";

describe("coordinator prompt handed to the model", () => {
  it("is this node's composed prompt: no work-closeout and no prioritizer write tools", async () => {
    const completion = vi.fn((_params: any) => ({
      stream: (async function* () {})(),
      final: Promise.resolve({
        ok: true as const,
        content: "done",
        finishReason: "stop",
      }),
    }));
    const provider = new LangGraphInProcProvider({
      catalog: POLY_NODE_LANGGRAPH_CATALOG,
      completion: { executeCompletionUnit: completion } as any,
      tools: {
        getBoundTool: () => undefined,
        listToolSpecs: () => [],
        hasToolId: () => false,
      } as any,
      toolBundle: [],
      authority: {
        resolvePrincipal: async () => "program-principal",
        guardDeps: {
          withStore: async (fn: any) =>
            fn({ liveScopes: async () => [], hasLiveRole: async () => false }),
          adminCheck: async () => "denied" as const,
        },
      } as any,
      sourceContext: async () => ({
        nodeId: "poly",
        origin: "https://poly.cognidao.org",
        mission: { content: "poly", sourceRef: "fixture", buildSha: null },
        governingIndex: [],
      }),
    });
    const scope = {
      actorUserId: actor,
      billing: { billingAccountId: "account", virtualKeyId: "key" },
      usageSource: "litellm",
      llmService: {},
    } as any;
    await runInScope(scope, async () => {
      const run = provider.runGraph(
        {
          runId: "run",
          graphId: "langgraph:cogni",
          messages: [{ role: "user", content: "hello" }],
          modelRef: { providerKey: "platform", modelId: "model" },
        } as any,
        { actorUserId: actor } as any
      );
      for await (const _event of run.stream) {
        /* drain */
      }
      await run.final;
    });
    const sent = (completion.mock.calls[0]?.[0]?.messages ?? []) as {
      role: string;
      content: unknown;
    }[];
    const prompt = sent
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(prompt).toContain("Host-owned registered workflows:");
    expect(prompt).toContain("langgraph:work-prioritizer");
    expect(prompt).toContain("langgraph:poly-brain");
    expect(prompt).toContain("langgraph:poly-research");
    expect(prompt).not.toContain("work-closeout");
    expect(prompt).not.toContain("core__work_item_update");
    expect(prompt).not.toContain("core__work_item_artifact_record");
  });
});

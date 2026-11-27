// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/langgraph/shared-cogni-prompt`
 * Purpose: The prompt the provider hands the shared runner is the node's, not the released template's.
 * Scope: Poly's REAL node catalog and the real released cogni entry; only the shared runner is replaced, to capture its options.
 * Invariants: PROMPT_MATCHES_NODE: the coordinator prompt reaching the runner names no `work-closeout`, and lists the published guarded prioritizer writes this node runs.
 * Side-effects: none
 * Links: src/adapters/server/ai/langgraph/inproc.provider.ts (runSharedGraph), packages/langgraph-graphs/src/catalog.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ options: undefined as any }));
vi.mock("@cogni/langgraph-graphs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cogni/langgraph-graphs")>()),
  createSharedInProcGraphRunner: (options: any) => {
    captured.options = options;
    return {
      stream: (async function* () {
        yield { type: "done" };
      })(),
      final: Promise.resolve({ ok: true, content: "ok" }),
    };
  },
}));
vi.mock("@/shared/observability", async () => ({
  EVENT_NAMES: {},
  failureFields: () => ({}),
  makeLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

import { runInScope } from "@/adapters/server/ai/execution-scope";
import { LangGraphInProcProvider } from "@/adapters/server/ai/langgraph/inproc.provider";
import { POLY_NODE_LANGGRAPH_CATALOG } from "@/bootstrap/ai/node-catalog";

const actor = "dfa8570f-d487-4239-b40a-2e39ee4513f9";

describe("coordinator prompt handed to the shared runner", () => {
  it("is this node's rewritten prompt: no work-closeout and published guarded prioritizer tools", async () => {
    const provider = new LangGraphInProcProvider(
      {
        executeCompletionUnit: () => ({
          stream: (async function* () {})(),
          final: Promise.resolve({ ok: true, content: "" }),
        }),
      } as any,
      {
        getBoundTool: () => undefined,
        listToolSpecs: () => [],
        hasToolId: () => false,
      } as any,
      async () => null,
      [],
      POLY_NODE_LANGGRAPH_CATALOG,
      {
        resolvePrincipal: async () => "program-principal",
        guardDeps: {
          withStore: async (fn: any) =>
            fn({ liveScopes: async () => [], hasLiveRole: async () => false }),
          adminCheck: async () => "denied" as const,
        },
        sourceContext: async () => ({
          nodeId: "poly",
          origin: "https://poly.cognidao.org",
          mission: { content: "poly" },
          governingIndex: [],
        }),
        isCodingActor: () => false,
        sandboxReady: () => false,
      } as any
    );
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
      await run.final;
    });
    const prompt: string = captured.options?.systemPrompt ?? "";
    expect(prompt).toContain("Host-owned registered workflows:");
    expect(prompt).toContain("langgraph:work-prioritizer");
    expect(prompt).not.toContain("work-closeout");
    expect(prompt).toContain("core__work_item_update");
    expect(prompt).toContain("core__work_item_artifact_record");
  });
});

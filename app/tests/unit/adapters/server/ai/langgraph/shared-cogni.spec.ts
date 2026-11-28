// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sandbox: 0,
  mint: 0,
  live: true,
}));
const ingress = vi.hoisted(() => ({
  headers: new Headers(),
  cookieUser: null as null | {
    id: string;
    walletAddress: null;
    displayName: null;
    avatarColor: null;
  },
}));
vi.mock("next/headers", () => ({ headers: async () => ingress.headers }));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: async () => ingress.cookieUser,
}));
vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({ AUTH_SECRET: "test-secret-123456789012345678901234" }),
}));
vi.mock("@/shared/observability", async () => ({
  EVENT_NAMES: {},
  failureFields: (
    await vi.importActual<
      typeof import("@/shared/observability/db-error-fields")
    >("@/shared/observability/db-error-fields")
  ).failureFields,
  makeLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import { createInProcGraphRunner, SHARED_LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";
import { aiChatOperation } from "@cogni/node-contracts";
import {
  runInScope,
} from "@/adapters/server/ai/execution-scope";
import { createLangGraphDispatch } from "@/adapters/server/ai/langgraph/dispatch";
import { LangGraphInProcProvider } from "@/adapters/server/ai/langgraph/inproc.provider";
import {
  issueAgentApiKey,
  resolveRequestIdentity,
} from "@/app/_lib/auth/request-identity";
import { POLY_CORE_TOOL_BUNDLE } from "@/bootstrap/ai/evaluation-baseline";
import { POLY_NODE_LANGGRAPH_CATALOG } from "@/bootstrap/ai/node-catalog";
import { PRINCIPAL_TOOL_BUNDLE } from "@/bootstrap/ai/principal-tool-source";
import { bindScheduleModel } from "@/bootstrap/capabilities/schedule-model";
import { signChatActor, verifyChatActor } from "@/bootstrap/chat-actor-proof";

const shell = "core__sandbox_shell";
const actor = "dfa8570f-d487-4239-b40a-2e39ee4513f9";
const contract = {
  name: shell,
  requires: { scope: "sandbox:exec", kind: "node", subject: "member" },
};
const runtime = {
  id: shell,
  effect: "external_side_effect",
  spec: {
    name: shell,
    effect: "external_side_effect",
    redaction: { mode: "top_level_only", allowlist: ["ok"] },
  },
  validateInput: (x: unknown) => x,
  validateOutput: (x: unknown) => x,
  exec: async () => {
    state.sandbox++;
    state.mint++;
    return { ok: true };
  },
  redact: (x: unknown) => x,
};
const store = {
  liveScopes: async () => (state.live ? ["sandbox:exec"] : []),
  hasLiveRole: async () => state.live,
};
const authority = {
  resolvePrincipal: async () => "program-principal",
  guardDeps: {
    withStore: async (fn: any) => fn(store),
    adminCheck: async () => "denied" as const,
  },
};
const req = {
  runId: "run",
  graphId: "langgraph:cogni",
  messages: [{ role: "user", content: "hello" }],
  modelRef: { providerKey: "platform", modelId: "model" },
};
const adapter = {
  executeCompletionUnit: vi.fn(() => ({
    stream: (async function* () {})(),
    final: Promise.resolve({ ok: true, content: "done", finishReason: "stop" }),
  })),
};
const source = {
  getBoundTool: (id: string) => (id === shell ? runtime : undefined),
  listToolSpecs: () => [runtime.spec],
  hasToolId: (id: string) => id === shell,
};
beforeEach(() => {
  state.sandbox = 0;
  state.mint = 0;
  state.live = true;
  adapter.executeCompletionUnit.mockClear();
});
describe("trusted chat workflow identity", () => {
  const identity = {
    nodeId: "red",
    lane: "candidate",
    idempotencyKey: "claim",
    transportKey: "api:run",
    requestHash: "hash",
    runId: "run",
    graphId: "langgraph:cogni",
    actorUserId: actor,
    billingAccountId: "account",
    virtualKeyId: "key",
    payload: { messages: ["original"] },
  };
  it("accepts authenticated launcher proof and rejects actor or run spoofing", () => {
    const proof = signChatActor(identity, "test-secret");
    expect(verifyChatActor(identity, "test-secret", proof)).toBe(true);
    expect(
      verifyChatActor(
        { ...identity, idempotencyKey: "other" },
        "test-secret",
        proof,
      ),
    ).toBe(false);
    expect(
      verifyChatActor(
        { ...identity, requestHash: "other" },
        "test-secret",
        proof,
      ),
    ).toBe(false);
    expect(
      verifyChatActor({ ...identity, lane: "other" }, "test-secret", proof),
    ).toBe(false);
    expect(
      verifyChatActor(
        { ...identity, actorUserId: "other" },
        "test-secret",
        proof,
      ),
    ).toBe(false);
    expect(
      verifyChatActor({ ...identity, runId: "other" }, "test-secret", proof),
    ).toBe(false);
    expect(
      verifyChatActor(
        { ...identity, payload: { messages: ["altered"] } },
        "test-secret",
        proof,
      ),
    ).toBe(false);
    expect(verifyChatActor(identity, "test-secret", undefined)).toBe(false);
  });
});

describe("development namespace composition", () => {
  it("keeps every graph that needs the guard, the principal or source context in-process, and sends only a plain read-only graph to dev", () => {
    const inproc = { runGraph: vi.fn() };
    const dev = { runGraph: vi.fn() };
    const catalog = {
      ...POLY_NODE_LANGGRAPH_CATALOG,
      "read-only-plain": {
        displayName: "Plain",
        description: "plain read-only graph",
        toolIds: ["core__get_current_time"],
        graphFactory: POLY_NODE_LANGGRAPH_CATALOG.cogni?.graphFactory as never,
      },
    };
    const router = createLangGraphDispatch(
      inproc as any,
      catalog,
      [...POLY_CORE_TOOL_BUNDLE, ...PRINCIPAL_TOOL_BUNDLE],
      dev as any
    );
    for (const graph of [
      "cogni",
      "work-prioritizer",
      "poly-brain",
      "poly-research",
      "nonexistent",
    ])
      router.runGraph({ graphId: `langgraph:${graph}` } as any);
    // poly-brain and poly-research list only read-only, scope-free tools and name no principal: only they may use the dev server.
    expect(inproc.runGraph.mock.calls.map((c) => c[0].graphId)).toEqual([
      "langgraph:cogni",
      "langgraph:work-prioritizer",
      "langgraph:nonexistent",
    ]);
    router.runGraph({ graphId: "langgraph:read-only-plain" } as any);
    expect(dev.runGraph.mock.calls.map((c) => c[0].graphId)).toEqual([
      "langgraph:poly-brain",
      "langgraph:poly-research",
      "langgraph:read-only-plain",
    ]);
  });
});

describe("chat ingress identity", () => {
  it("resolves cookie and bearer from their authenticated sources and strips JSON identity claims", async () => {
    ingress.cookieUser = {
      id: actor,
      walletAddress: null,
      displayName: null,
      avatarColor: null,
    };
    ingress.headers = new Headers();
    expect((await resolveRequestIdentity())?.id).toBe(actor);
    const token = issueAgentApiKey({ userId: actor, displayName: null });
    ingress.headers = new Headers({ authorization: `Bearer ${token}` });
    expect((await resolveRequestIdentity())?.id).toBe(actor);
    const parsed = aiChatOperation.input.parse({
      message: "hello",
      graphName: "langgraph:cogni",
      modelRef: { providerKey: "platform", modelId: "model" },
      actorUserId: "attacker",
      program: "attacker",
      codingActorIds: ["attacker"],
    });
    expect(parsed).not.toHaveProperty("actorUserId");
    expect(parsed).not.toHaveProperty("program");
    expect(parsed).not.toHaveProperty("codingActorIds");
  });
});

describe("released shared coordinator scheduling", () => {
  it("uses the released schedule contracts for purpose lookup, create, readback and reuse", async () => {
    const tools = await import("@cogni/shared-ai-tools");
    const core = await import("@cogni/ai-core");
    const grants = await import("@cogni/agent-grants");
    const schedules: any[] = [];
    let changes = 0;
    let active = true;
    const observed: string[] = [];
    const capability = {
      list: async () => schedules,
      create: async (input: any) => {
        changes++;
        const row = {
          ...input,
          id: "schedule-1",
          enabled: true,
          nextRunAt: null,
          lastRunAt: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        };
        schedules.push(row);
        return row;
      },
      update: async () => {
        throw new Error("unexpected update");
      },
      remove: async () => {
        throw new Error("unexpected delete");
      },
      setEnabled: async () => {
        throw new Error("unexpected toggle");
      },
    };
    const listRuntime = tools.contractToRuntime(
      tools.scheduleListContract,
      tools.createScheduleListImplementation({
        scheduleCapability: capability,
      }),
    );
    const manageRuntime = tools.contractToRuntime(
      tools.scheduleManageContract,
      tools.createScheduleManageImplementation({
        scheduleCapability: bindScheduleModel(capability, {
          providerKey: "platform",
          modelId: "test",
        }),
      }),
    );
    const all = {
      core__schedule_list: listRuntime,
      core__schedule_manage: manageRuntime,
    };
    const guarded = grants.guardTools(
      all,
      { core__schedule_manage: tools.scheduleManageContract.requires! },
      { runId: "run", principalId: "principal", subjectUserId: actor },
      {
        withStore: async (fn: any) => fn({ hasLiveRole: async () => active }),
        adminCheck: async () => "denied",
      },
    );
    const toolRunner = core.createToolRunner(
      core.createStaticToolSourceFromRecord(guarded),
      () => {},
      {
        policy: core.createToolAllowlistPolicy(Object.keys(all)),
        ctx: { runId: "run" },
      },
    );
    const names = [
      "core__knowledge_read",
      "core__schedule_list",
      "core__schedule_manage",
      "core__goal_list",
      "core__goal_progress",
      "core__work_item_query",
    ];
    const contracts = tools.CORE_TOOL_BUNDLE.filter((item) =>
      names.includes(item.contract.name),
    ).map((item) => item.contract);
    const create = {
      action: "create",
      purpose: "node-work-triage",
      graphId: "langgraph:work-prioritizer",
      instruction: "Triage",
      cron: "0 * * * *",
      timezone: "UTC",
    };
    let model = 0;
    let repeat = false;
    const completionFn = () => {
      model++;
      const call =
        model === 1 || model === 3
          ? { name: "core__schedule_list", args: { purpose: create.purpose } }
          : model === 2 && !repeat
            ? { name: "core__schedule_manage", args: create }
            : undefined;
      return {
        stream: (async function* () {})(),
        final: Promise.resolve({
          ok: true as const,
          content: call ? "" : "Done",
          finishReason: call ? "tool_calls" : "stop",
          ...(call
            ? {
                toolCalls: [
                  {
                    id: `call-${model}`,
                    type: "function" as const,
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.args),
                    },
                  },
                ],
              }
            : {}),
        }),
      };
    };
    const options = {
      createGraph: SHARED_LANGGRAPH_CATALOG.cogni?.graphFactory,
      program: "cogni",
      trustedActorId: actor,
      trustedProgramId: "cogni",
      sourceContext: {
        nodeId: "red",
        origin: "https://red.cognidao.org",
        mission: { content: "Red", sourceRef: "fixture", buildSha: null },
      },
      completionFn,
      toolContracts: contracts,
      request: {
        runId: "shared-run",
        messages: [{ role: "user", content: "Arrange the triage duty" }],
        configurable: { model: "test", toolIds: names },
      },
      createToolExecFn: () => async (name: string, args: any) => {
        observed.push(name);
        if (name in all) return toolRunner.exec(name, args);
        if (name === "core__knowledge_read")
          return {
            ok: true,
            value: {
              mode: "get",
              entries: [{ id: args.id, content: "Full workflow card" }],
            },
          };
        if (name === "core__goal_list")
          return { ok: true, value: { goals: [] } };
        if (name === "core__goal_progress")
          return {
            ok: true,
            value: {
              goals: [],
              asOf: "2026-01-01T00:00:00Z",
              environment: "test",
            },
          };
        return { ok: true, value: { items: [], count: 0 } };
      },
    } as any;
    const runner = createInProcGraphRunner(options);
    for await (const _event of runner.stream) {
      /* drain */
    }
    expect((await runner.final).ok).toBe(true);
    expect(observed).toContain("core__knowledge_read");
    expect(changes).toBe(1);
    expect(schedules[0].input.modelRef).toEqual({
      providerKey: "platform",
      modelId: "test",
    });
    const lookup = await toolRunner.exec("core__schedule_list", {
      purpose: create.purpose,
    });
    expect(lookup.ok && lookup.value.count).toBe(1);
    repeat = true;
    model = 0;
    const repeatRun = createInProcGraphRunner({
      ...options,
      request: { ...options.request, runId: "shared-repeat" },
    });
    for await (const _event of repeatRun.stream) {
      /* drain */
    }
    expect((await repeatRun.final).ok).toBe(true);
    expect(changes).toBe(1);
    active = false;
    const denied = await toolRunner.exec("core__schedule_manage", create);
    expect(denied.ok).toBe(false);
    expect(changes).toBe(1);
  });
});

describe("released preflight around eager shared provider", () => {
  it.each(["policy", "credit", "approved"])(
    "holds the provider until %s resolves",
    async (outcome) => {
      const { PreflightCreditCheckDecorator } = await import(
        "@cogni/graph-execution-host"
      );
      let settle!: (value: boolean) => void;
      const gate = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      const check = vi.fn(async () => {
        if (!(await gate)) throw new Error("credit denied");
      });
      const policy = vi.fn(async () => {
        if (outcome === "policy") {
          await gate;
          throw new Error("policy denied");
        }
        return true;
      });
      let innerRuns = 0;
      // The real package provider and runner: the pair is a preflight decorator over a provider that starts work when called.
      const provider = new LangGraphInProcProvider({
        catalog: POLY_NODE_LANGGRAPH_CATALOG,
        completion: adapter as any,
        tools: source as any,
        toolBundle: [{ contract } as any],
        sourceContext: async () => ({
          nodeId: "poly",
          origin: "https://poly.cognidao.org",
          mission: { content: "Poly", sourceRef: "fixture", buildSha: null },
          governingIndex: [],
        }),
        authority: authority as any,
      });
      const eager = {
        runGraph: (request: any, ctx: any) => {
          innerRuns++;
          return provider.runGraph(request, ctx);
        },
      };
      const preflight = new PreflightCreditCheckDecorator(
        eager as any,
        check,
        "account",
        { resolve: () => ({ requiresPlatformCredits: policy }) } as any,
        {} as any,
      );
      const run = runInScope(
        {
          actorUserId: actor,
          billing: { billingAccountId: "account", virtualKeyId: "key" },
          usageSource: "litellm",
          llmService: {},
        } as any,
        () => preflight.runGraph(req as any, { actorUserId: actor } as any),
      );
      const stream = (async () => {
        for await (const _ of run.stream) {
          /* drain */
        }
      })();
      const final = run.final;
      await Promise.resolve();
      expect([
        innerRuns,
        adapter.executeCompletionUnit.mock.calls.length,
        state.sandbox,
        state.mint,
      ]).toEqual([0, 0, 0, 0]);
      settle(outcome === "approved");
      if (outcome === "approved") {
        await expect(final).resolves.toMatchObject({ ok: true });
        await expect(stream).resolves.toBeUndefined();
        expect(innerRuns).toBe(1);
        expect(adapter.executeCompletionUnit).toHaveBeenCalledOnce();
      } else {
        await expect(final).rejects.toThrow(`${outcome} denied`);
        await expect(stream).rejects.toThrow(`${outcome} denied`);
        expect([
          innerRuns,
          adapter.executeCompletionUnit.mock.calls.length,
          state.sandbox,
          state.mint,
        ]).toEqual([0, 0, 0, 0]);
      }
    },
  );
});

describe("released sandbox billing custody", () => {
  it.each(["missing", "platform", "byo"])(
    "handles %s sandbox usage without changing provenance",
    async (mode) => {
      const { UsageCommitDecorator } = await import(
        "@cogni/graph-execution-host"
      );
      const log = {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      };
      const commit = vi.fn(async () => {});
      const fact = {
        runId: "sandbox-run",
        attempt: 0,
        source: mode === "byo" ? ("codex" as const) : ("litellm" as const),
        executorType: "sandbox" as const,
        billingAccountId: "account",
        virtualKeyId: "key",
        graphId: "sandbox:agent",
        ...(mode === "missing" ? {} : { usageUnitId: "unit-1" }),
      };
      const inner: import("@cogni/graph-execution-core").GraphExecutorPort = {
        runGraph: () => ({
          stream: (async function* () {
            yield { type: "usage_report" as const, fact };
            yield { type: "done" as const };
          })(),
          final: Promise.resolve({
            ok: true as const,
            runId: "sandbox-run",
            requestId: "sandbox-run",
          }),
        }),
      };
      const result = new UsageCommitDecorator(inner, log, commit).runGraph({
        runId: "sandbox-run",
        graphId: "sandbox:agent",
        modelRef: { providerKey: "platform", modelId: "model" },
        messages: [],
      });
      const drain = (async () => {
        const events = [];
        for await (const event of result.stream) events.push(event.type);
        return events;
      })();
      if (mode === "missing")
        await expect(drain).rejects.toThrow("Billing validation failed");
      else await expect(drain).resolves.toEqual(["done"]);
      if (mode === "byo")
        expect(commit).toHaveBeenCalledExactlyOnceWith(fact, log);
      else expect(commit).not.toHaveBeenCalled();
    },
  );
});

describe("authority lookup diagnostics", () => {
  it("logs the failure class and schema identifiers, never the message or query values", async () => {
    const { createAgentToolAuthority } = await import(
      "@/bootstrap/agent-authority"
    );
    const failure = Object.assign(
      new Error('column "private_value" does not exist'),
      { code: "42703", column_name: "resource", table_name: "agent_roles" },
    );
    const sql = Object.assign(
      async () => {
        throw failure;
      },
      { begin: async (fn: any) => fn(sql) },
    );
    const logger = { error: vi.fn() };
    const authority = createAgentToolAuthority({
      sql: sql as any,
      nodeAdmin: {} as any,
      log: logger as any,
      toolBundle: [],
    });
    await expect(
      authority.guardDeps.withStore((store) =>
        store.liveScopes("private-principal", ["sandbox:exec"]),
      ),
    ).rejects.toBe(failure);
    const fields = logger.error.mock.calls[0]?.[0] as any;
    expect(fields).toMatchObject({
      errorCode: "42703",
      column: "resource",
      table: "agent_roles",
    });
    expect(JSON.stringify(fields)).not.toContain("private_value");
    expect(JSON.stringify(fields)).not.toContain("private-principal");
    expect(JSON.stringify(fields)).not.toContain("sandbox:exec");
  });
});

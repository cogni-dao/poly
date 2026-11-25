// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  options: undefined as any,
  sandbox: 0,
  mint: 0,
  live: true,
  failure: "" as string,
  legacy: 0,
  identity: undefined as unknown,
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
vi.mock("@cogni/langgraph-graphs", () => {
  const cogni = {
    displayName: "Cogni",
    description: "Shared",
    sharedRuntime: true,
    toolIds: ["core__sandbox_shell"],
    graphFactory: () => ({}),
    principal: "node-ai",
    program: "cogni",
  };
  return {
    LANGGRAPH_CATALOG: {
      cogni,
      poet: {
        displayName: "Poet",
        description: "legacy",
        toolIds: [],
        graphFactory: () => ({}),
      },
    },
    SHARED_NODE_CATALOG: { cogni },
    createInProcGraphRunner: () => {
      state.legacy++;
      return {
        stream: (async function* () {
          yield { type: "done" };
        })(),
        final: Promise.resolve({ ok: true }),
      };
    },
    createSharedInProcGraphRunner: (options: any) => {
      state.options = options;
      options.completionFn({ messages: [], model: "model" });
      return {
        stream: (async function* () {
          yield { type: "done" };
        })(),
        final: Promise.resolve({ ok: true, content: "ok" }),
      };
    },
  };
});
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: {},
  makeLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

import { aiChatOperation } from "@cogni/node-contracts";
import {
  getExecutionScope,
  runInScope,
} from "@/adapters/server/ai/execution-scope";
import { createLangGraphDispatch } from "@/adapters/server/ai/langgraph/dispatch";
import { LangGraphInProcProvider } from "@/adapters/server/ai/langgraph/inproc.provider";
import {
  loadCogniSourceContext,
  SOURCE_CONTEXT_MAX_BYTES,
  SOURCE_CONTEXT_MAX_ROWS,
} from "@/adapters/server/ai/langgraph/source-context";
import {
  issueAgentApiKey,
  resolveRequestIdentity,
} from "@/app/_lib/auth/request-identity";
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
    state.identity = getExecutionScope();
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
const deps = {
  resolvePrincipal: async () =>
    state.failure === "principal" ? null : "program-principal",
  guardDeps: {
    withStore: async (fn: any) => {
      if (state.failure === "store") throw new Error("unavailable");
      return fn(store);
    },
    adminCheck: async () => "denied" as const,
  },
  sourceContext: async () => {
    if (state.failure === "overflow")
      throw new Error("governing_index_overflow");
    return {
      nodeId: "red",
      origin: "https://red.cognidao.org",
      mission: { content: "red" },
      governingIndex: [],
    };
  },
  isCodingActor: (id: string) => id === actor,
  sandboxReady: () => state.failure !== "sandbox",
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
    final: Promise.resolve({ ok: true, content: "" }),
  })),
};
const source = {
  getBoundTool: (id: string) => (id === shell ? runtime : undefined),
  listToolSpecs: () => [runtime.spec],
  hasToolId: (id: string) => id === shell,
};
async function launch(
  user: string,
  extra: Record<string, unknown> = {},
  sourceContext = deps.sourceContext,
) {
  const scope = {
    actorUserId: user,
    billing: { billingAccountId: "account", virtualKeyId: "key" },
    usageSource: "litellm",
    llmService: {},
  } as any;
  const provider = new LangGraphInProcProvider(
    adapter as any,
    source as any,
    async () => null,
    [{ contract } as any],
    { ...deps, sourceContext } as any,
  );
  return runInScope(scope, async () => {
    const run = provider.runGraph(
      { ...req, ...extra } as any,
      { actorUserId: user } as any,
    );
    await run.final;
    return state.options;
  });
}
beforeEach(() => {
  state.options = undefined;
  state.sandbox = 0;
  state.mint = 0;
  state.live = true;
  state.failure = "";
  state.legacy = 0;
  state.identity = undefined;
  adapter.executeCompletionUnit.mockClear();
});
describe("shared Cogni authority seam", () => {
  it("carries trusted source and program and executes an allowed shell", async () => {
    const opts = await launch(actor);
    expect(adapter.executeCompletionUnit).toHaveBeenCalledOnce();
    expect(opts.trustedActorId).toBe(actor);
    expect(opts.trustedProgramId).toBe("cogni");
    expect(opts.sourceContext.nodeId).toBe("red");
    const result = await runInScope(
      {
        actorUserId: actor,
        billing: { billingAccountId: "account", virtualKeyId: "key" },
        usageSource: "litellm",
        llmService: {},
      } as any,
      () => opts.createToolExecFn(() => {})(shell, {}),
    );
    expect(result.ok).toBe(true);
    expect(state.sandbox).toBe(1);
    expect(state.mint).toBe(1);
    expect(state.identity).toMatchObject({
      actorUserId: actor,
      subjectUserId: actor,
      principalId: "program-principal",
      billing: { billingAccountId: "account" },
    });
  });
  it("withholds shell and denies a forced call for another actor despite spoofed request data", async () => {
    const opts = await launch("other", { actorUserId: actor });
    expect(opts.request.configurable.toolIds).not.toContain(shell);
    const result = await opts.createToolExecFn(() => {})(shell, {});
    expect(result.errorCode).toBe("policy_denied");
    expect(state.sandbox).toBe(0);
    expect(state.mint).toBe(0);
  });
  it("honors revocation between offering and execution", async () => {
    const opts = await launch(actor);
    expect(opts.request.configurable.toolIds).toContain(shell);
    state.live = false;
    const result = await opts.createToolExecFn(() => {})(shell, {});
    expect(result.ok).toBe(false);
    expect(state.sandbox).toBe(0);
    expect(state.mint).toBe(0);
  });
  it("keeps legacy graphs on the legacy runner", async () => {
    const scope = {
      actorUserId: actor,
      billing: { billingAccountId: "account", virtualKeyId: "key" },
      usageSource: "litellm",
      llmService: {},
    } as any;
    const provider = new LangGraphInProcProvider(adapter as any, source as any);
    await runInScope(scope, async () => {
      await provider.runGraph({ ...req, graphId: "langgraph:poet" } as any, {
        actorUserId: actor,
      }).final;
    });
    expect(state.legacy).toBe(1);
    expect(state.options).toBeUndefined();
  });
  it.each(["principal", "store", "sandbox", "overflow"])(
    "fails before effects when %s is unavailable",
    async (failure) => {
      state.failure = failure;
      expect(await launch(actor)).toBeUndefined();
      expect(adapter.executeCompletionUnit).not.toHaveBeenCalled();
      expect(state.sandbox).toBe(0);
      expect(state.mint).toBe(0);
    },
  );
  it("fails before the model when the coding grant is missing", async () => {
    state.live = false;
    const opts = await launch(actor);
    expect(opts).toBeUndefined();
    expect(adapter.executeCompletionUnit).not.toHaveBeenCalled();
  });
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
  it("routes Cogni in-process and legacy graphs to dev", () => {
    const inproc = { runGraph: vi.fn() };
    const dev = { runGraph: vi.fn() };
    const router = createLangGraphDispatch(inproc as any, dev as any);
    router.runGraph({ graphId: "langgraph:cogni" } as any);
    router.runGraph({ graphId: "langgraph:brain" } as any);
    expect(inproc.runGraph).toHaveBeenCalledOnce();
    expect(dev.runGraph).toHaveBeenCalledOnce();
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

describe("released cognition source binding", () => {
  const rows = [
    "skill",
    "guide",
    "playbook",
    "rule",
    "design",
    "roadmap",
    "decision",
    "reference",
  ].map((entryType) => ({
    id: entryType,
    domain: "red",
    entryType,
    useWhen: `use ${entryType}`,
  }));
  function fixture() {
    const store = {
      currentCommit: vi.fn(async () => "revision"),
      listDomainsFull: vi.fn(async () => []),
      listGoverningIndex: vi.fn(async () => rows),
      getKnowledge: vi.fn(async (_id: string) => null),
      listActiveGoals: vi.fn(async () => []),
    };
    const input = {
      store,
      nodeId: "red",
      origin: "https://red.cognidao.org",
      mission: "Protect Red",
      buildSha: "sha",
    };
    return { store, input, read: () => loadCogniSourceContext(input as any) };
  }
  it("feeds the full canonical snapshot to the graph with fixed orientation IDs", async () => {
    const { store, read } = fixture();
    const opts = await launch(actor, {}, read);
    expect(opts.sourceContext.governingIndex).toEqual(rows);
    expect(opts.sourceContext.mission.content).toBe("Protect Red");
    expect(store.getKnowledge.mock.calls.map(([id]) => id)).toEqual([
      "red-agent-orientation",
      "cogni-agent-orientation",
    ]);
    expect(store.listDomainsFull).toHaveBeenCalledOnce();
    expect(store.listActiveGoals).toHaveBeenCalledOnce();
  });
  it.each(["failed", "degraded", "stale", "rows", "bytes"])(
    "refuses %s source before model, sandbox or mint",
    async (kind) => {
      const { store, input, read } = fixture();
      if (kind === "stale") {
        await read();
        store.currentCommit.mockRejectedValue(new Error("head unavailable"));
      }
      if (kind === "failed")
        store.listGoverningIndex.mockRejectedValue(new Error("unavailable"));
      if (kind === "degraded")
        store.listActiveGoals.mockRejectedValue(new Error("unavailable"));
      if (kind === "rows")
        store.listGoverningIndex.mockResolvedValue(
          Array.from({ length: SOURCE_CONTEXT_MAX_ROWS + 1 }, (_, i) => ({
            id: `${i}`,
            domain: "d",
            entryType: "rule",
            useWhen: "x",
          })),
        );
      if (kind === "bytes")
        input.mission = "é".repeat(SOURCE_CONTEXT_MAX_BYTES);
      expect(await launch(actor, {}, read)).toBeUndefined();
      expect(adapter.executeCompletionUnit).not.toHaveBeenCalled();
      expect(state.sandbox).toBe(0);
      expect(state.mint).toBe(0);
    },
  );
});

describe("released shared coordinator scheduling", () => {
  it("uses the released schedule contracts for purpose lookup, create, readback and reuse", async () => {
    const graph = await vi.importActual<
      typeof import("@cogni/langgraph-graphs")
    >("@cogni/langgraph-graphs");
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
      createGraph: graph.SHARED_NODE_CATALOG.cogni.graphFactory,
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
    const runner = graph.createSharedInProcGraphRunner(options);
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
    const repeatRun = graph.createSharedInProcGraphRunner({
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
      const provider = new LangGraphInProcProvider(
        adapter as any,
        source as any,
        async () => null,
        [{ contract } as any],
        deps as any,
      );
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
  it.each([
    ['column "resource" does not exist', "resource"],
    ['column "private_value" does not exist', undefined],
  ])(
    "reports only allowed missing authority columns",
    async (message, expected) => {
      const { createSharedAgentAuthority } = await import(
        "@/bootstrap/agent-authority"
      );
      const failure = Object.assign(new Error(message), { code: "42703" });
      const sql = Object.assign(
        () => {
          throw failure;
        },
        {
          begin: async () => {
            throw failure;
          },
        },
      );
      const logger = { error: vi.fn() };
      const authority = createSharedAgentAuthority(
        sql as any,
        {} as any,
        logger as any,
      );
      await expect(authority.resolvePrincipal("node-ai")).rejects.toBe(failure);
      const fields = logger.error.mock.calls[0]?.[0] as any;
      expect(fields.code).toBe("42703");
      expect(fields.missingColumn).toBe(expected);
      expect(JSON.stringify(fields)).not.toContain("private_value");
    },
  );
});

it("labels the actual published liveScopes lookup without exposing query values", async () => {
  const { createSharedAgentAuthority } = await import(
    "@/bootstrap/agent-authority"
  );
  const failure = Object.assign(new Error('column "resource" does not exist'), {
    code: "42703",
  });
  const sql = Object.assign(
    async () => {
      throw failure;
    },
    { begin: async (fn: any) => fn(sql) },
  );
  const logger = { error: vi.fn() };
  const authority = createSharedAgentAuthority(
    sql as any,
    {} as any,
    logger as any,
  );
  await expect(
    authority.guardDeps.withStore((store) =>
      store.liveScopes("private-principal", ["sandbox:exec"]),
    ),
  ).rejects.toBe(failure);
  const fields = logger.error.mock.calls[0]?.[0] as any;
  expect(fields).toMatchObject({
    operation: "liveScopes",
    code: "42703",
    missingColumn: "resource",
  });
  expect(JSON.stringify(fields)).not.toContain("private-principal");
  expect(JSON.stringify(fields)).not.toContain("sandbox:exec");
});

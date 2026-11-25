// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/internal.graphs-run-terminal`
 * Purpose: Prove failed terminal publication finalizes the accepted execution as failed.
 * Scope: Internal graph-run route with mocked executor, persistence, stream, and idempotency ports.
 * Invariants: rejected done publication cannot produce a successful execution record.
 * Side-effects: none
 * @internal
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN_ID = "a0000000-0000-4000-a000-000000000001";
const USER_ID = "10000000-0000-4000-a000-000000000001";
const BILLING_ID = "20000000-0000-4000-a000-000000000001";
const VIRTUAL_KEY_ID = "30000000-0000-4000-a000-000000000001";

const mocks = vi.hoisted(() => ({
  integrated: false,
  provider: undefined as any,
  workflow: undefined as any,
  headers: new Headers(),
  cookie: null as any,
  executeCount: 0,
  executeArgs: [] as unknown[],
  validateGrant: vi.fn(),
  checkIdempotency: vi.fn().mockResolvedValue({ status: "new" }),
  createPendingRequest: vi.fn().mockResolvedValue({
    status: "claimed",
    request: { runId: "a0000000-0000-4000-a000-000000000001" },
  }),
  heartbeatRequest: vi.fn().mockResolvedValue(undefined),
  finalizeRequest: vi.fn(),
  markRunCompleted: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn(async (_runId: string, event: { type: string }) => {
    if (event.type === "done") throw new Error("redis unavailable");
  }),
  saveThread: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: async () => mocks.cookie,
}));
vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({ AUTH_SECRET: "test-secret-123456789012345678901234" }),
}));
vi.mock("@/shared/config", () => ({ getNodeId: () => "red" }));
vi.mock("@/lib/auth/mapping", () => ({
  getOrCreateBillingAccountForUser: async () => ({
    id: BILLING_ID,
    defaultVirtualKeyId: VIRTUAL_KEY_ID,
  }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_options: unknown, handler: (...args: never[]) => unknown) =>
    (request: NextRequest, context?: unknown) =>
      handler(
        {
          reqId: "request-1",
          traceId: "00000000000000000000000000000001",
          routeId: "graphs.run.internal",
          clock: { now: () => "2025-01-01T00:00:00.000Z" },
          log: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          },
        } as never,
        request as never,
        null as never,
        context as never,
      ),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    SCHEDULER_API_TOKEN: "scheduler-secret-value-1234567890",
    AUTH_SECRET: "test-secret-123456789012345678901234",
    DEPLOY_ENVIRONMENT: "candidate",
  }),
}));

vi.mock("@/bootstrap/graph-executor.factory", () => {
  const executor = {
    runGraph: (...args: unknown[]) => {
      mocks.executeArgs = args;
      mocks.executeCount++;
      return {
        stream: (async function* () {
          yield { type: "assistant_final" as const, content: "answer" };
          yield { type: "done" as const };
        })(),
        final: Promise.resolve({
          ok: true as const,
          requestId: "a0000000-0000-4000-a000-000000000001",
          usage: { promptTokens: 1, completionTokens: 1 },
          finishReason: "stop" as const,
        }),
      };
    },
  };
  return {
    createGraphExecutor: () => executor,
    createScopedGraphExecutor: (options: any) =>
      mocks.integrated
        ? {
            runGraph: (req: any, ctx: any) => {
              return runInScope(
                {
                  actorUserId: ctx.actorUserId,
                  billing: options.billing,
                  usageSource: "litellm",
                  llmService: {},
                },
                () => mocks.provider.runGraph(req, ctx),
              );
            },
          }
        : executor,
  };
});

vi.mock("@/ports/server", () => ({
  isGrantExpiredError: () => false,
  isGrantNotFoundError: () => false,
  isGrantRevokedError: (error: unknown) =>
    error instanceof Error && error.message === "revoked",
  isGrantScopeMismatchError: () => false,
}));

vi.mock("@/bootstrap/container", () => ({
  getTemporalWorkflowClient: async () => ({
    client: {
      start: async (_name: string, options: any) => {
        mocks.workflow = options.args[0];
      },
    },
    taskQueue: "test",
  }),
  resolveAiAdapterDeps: () => ({ accountService: {} }),
  getContainer: () => ({
    nodeId: "red",
    executionGrantWorkerPort: { validateGrantForGraph: mocks.validateGrant },
    serviceAccountService: {
      getBillingAccountById: async () => ({
        defaultVirtualKeyId: VIRTUAL_KEY_ID,
      }),
    },
    executionRequestPort: {
      checkIdempotency: mocks.checkIdempotency,
      createPendingRequest: mocks.createPendingRequest,
      heartbeatRequest: mocks.heartbeatRequest,
      finalizeRequest: mocks.finalizeRequest,
    },
    graphRunRepository: {
      markRunCompleted: mocks.markRunCompleted,
      patchRunStateKey: vi.fn().mockResolvedValue(undefined),
    },
    accountsForUser: () => ({}),
    providerResolver: {},
    connectionBroker: undefined,
    runStream: {
      subscribe: async function* () {},
      publish: mocks.publish,
      expire: vi.fn().mockResolvedValue(undefined),
    },
    threadPersistenceForUser: () => ({
      loadThread: vi.fn().mockResolvedValue([
        {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      ]),
      saveThread: mocks.saveThread,
      softDelete: vi.fn(),
      listThreads: vi.fn(),
    }),
  }),
}));

import {
  getExecutionScope,
  runInScope,
} from "@/adapters/server/ai/execution-scope";
import { POST } from "@/app/api/internal/graphs/[graphId]/runs/route";
import { signChatActor } from "@/bootstrap/chat-actor-proof";

describe("POST /api/internal/graphs/{graphId}/runs terminal publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeCount = 0;
    mocks.checkIdempotency.mockResolvedValue({ status: "new" });
  });

  it("finalizes failure when durable done publication rejects", async () => {
    const response = await POST(
      new NextRequest(
        "http://localhost/api/internal/graphs/langgraph:default/runs",
        {
          method: "POST",
          headers: {
            authorization: "Bearer scheduler-secret-value-1234567890",
            "content-type": "application/json",
            "idempotency-key": "ai:scoped-key",
          },
          body: JSON.stringify({
            executionGrantId: null,
            runId: RUN_ID,
            input: {
              messages: [{ role: "user", content: "hello" }],
              modelRef: { providerKey: "platform", modelId: "test-model" },
              actorUserId: USER_ID,
              billingAccountId: BILLING_ID,
              virtualKeyId: VIRTUAL_KEY_ID,
              stateKey: "thread-1",
            },
          }),
        },
      ),
      { params: Promise.resolve({ graphId: "langgraph:default" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      runId: RUN_ID,
      error: "internal",
    });
    expect(mocks.saveThread).toHaveBeenCalledOnce();
    expect(mocks.finalizeRequest).toHaveBeenCalledWith("ai:scoped-key", {
      ok: false,
      errorCode: "internal",
    });
  });

  it("executes a matching API preclaim without inserting a second pending row", async () => {
    const requestHash = "a".repeat(64);
    mocks.checkIdempotency.mockResolvedValue({
      status: "pending",
      request: {
        idempotencyKey: "ai:scoped-key",
        requestHash,
        runId: RUN_ID,
        traceId: null,
        ok: null,
        errorCode: null,
        createdAt: new Date(),
      },
    });

    const response = await POST(
      new NextRequest(
        "http://localhost/api/internal/graphs/langgraph:default/runs",
        {
          method: "POST",
          headers: {
            authorization: "Bearer scheduler-secret-value-1234567890",
            "content-type": "application/json",
            "idempotency-key": "ai:scoped-key",
          },
          body: JSON.stringify({
            executionGrantId: null,
            runId: RUN_ID,
            input: {
              messages: [{ role: "user", content: "hello" }],
              modelRef: { providerKey: "platform", modelId: "test-model" },
              actorUserId: USER_ID,
              billingAccountId: BILLING_ID,
              virtualKeyId: VIRTUAL_KEY_ID,
              stateKey: "thread-1",
              executionRequestHash: requestHash,
            },
          }),
        },
      ),
      { params: Promise.resolve({ graphId: "langgraph:default" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.heartbeatRequest).toHaveBeenCalledWith(
      "ai:scoped-key",
      expect.any(String),
    );
    expect(mocks.finalizeRequest).toHaveBeenCalledWith("ai:scoped-key", {
      ok: false,
      errorCode: "internal",
    });
  });
});

describe("shared Cogni receiver ownership", () => {
  const key = `ai:${"b".repeat(64)}`;
  const hash = "a".repeat(64);
  const secret = "test-secret-123456789012345678901234";
  const payload = {
    messages: [{ role: "user", content: "hello" }],
    modelRef: { providerKey: "platform", modelId: "test-model" },
    stateKey: "thread-1",
  };
  const identity = {
    nodeId: "red",
    lane: "candidate",
    idempotencyKey: key,
    transportKey: `api:${RUN_ID}`,
    requestHash: hash,
    runId: RUN_ID,
    graphId: "langgraph:cogni",
    actorUserId: USER_ID,
    billingAccountId: BILLING_ID,
    virtualKeyId: VIRTUAL_KEY_ID,
    payload,
  };
  const request = (
    requestKey = `api:${RUN_ID}`,
    overrides: Record<string, unknown> = {},
  ) =>
    new NextRequest(
      "http://localhost/api/internal/graphs/langgraph:cogni/runs",
      {
        method: "POST",
        headers: {
          authorization: "Bearer scheduler-secret-value-1234567890",
          "content-type": "application/json",
          "idempotency-key": requestKey,
        },
        body: JSON.stringify({
          runId: RUN_ID,
          executionGrantId: null,
          input: {
            ...payload,
            actorUserId: USER_ID,
            billingAccountId: BILLING_ID,
            virtualKeyId: VIRTUAL_KEY_ID,
            executionRequestHash: hash,
            executionClaimKey: key,
            chatActorProof: signChatActor(identity, secret),
            ...overrides,
          },
        }),
      },
    );
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeCount = 0;
    mocks.checkIdempotency.mockResolvedValue({
      status: "pending",
      request: {
        runId: RUN_ID,
        idempotencyKey: key,
        requestHash: hash,
        ok: null,
      },
    });
  });
  it("rejects changed claim key and actor payload before the executor", async () => {
    const params = { params: Promise.resolve({ graphId: "langgraph:cogni" }) };
    expect((await POST(request("ai:other"), params)).status).toBe(403);
    expect(
      (await POST(request(`api:${RUN_ID}`, { actorUserId: "other" }), params))
        .status,
    ).toBe(403);
    expect(
      (
        await POST(
          request(`api:${RUN_ID}`, {
            executionClaimKey: `ai:${"c".repeat(64)}`,
          }),
          params,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          request(`api:${RUN_ID}`, { executionRequestHash: "d".repeat(64) }),
          params,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          request(`api:${RUN_ID}`, {
            messages: [{ role: "user", content: "tampered" }],
          }),
          params,
        )
      ).status,
    ).toBe(403);
    expect(mocks.executeCount).toBe(0);
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
  });
  it("refuses an otherwise valid worker payload without the launcher's persisted claim", async () => {
    mocks.checkIdempotency.mockResolvedValue({ status: "new" });
    const params = { params: Promise.resolve({ graphId: "langgraph:cogni" }) };
    expect((await POST(request(), params)).status).toBe(403);
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.executeCount).toBe(0);
  });
  it("uses the atomic lease claim for simultaneous deliveries", async () => {
    let claimed = false;
    mocks.createPendingRequest.mockImplementation(async () => {
      if (claimed) return { status: "pending", request: { runId: RUN_ID } };
      claimed = true;
      return { status: "claimed", request: { runId: RUN_ID } };
    });
    const params = { params: Promise.resolve({ graphId: "langgraph:cogni" }) };
    const responses = await Promise.all([
      POST(request(), params),
      POST(request(), params),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(mocks.createPendingRequest).toHaveBeenCalledTimes(2);
    expect(mocks.createPendingRequest).toHaveBeenCalledWith(
      key,
      hash,
      RUN_ID,
      expect.any(String),
      expect.any(String),
    );
    expect(mocks.executeCount).toBe(1);
  });
});

describe("scheduled Cogni ingress", () => {
  const grantId = "40000000-0000-4000-a000-000000000001";
  const key = "schedule-123:2026-11-21T00:00:00.000Z";
  function request() {
    return new NextRequest(
      "http://localhost/api/internal/graphs/langgraph:cogni/runs",
      {
        method: "POST",
        headers: {
          authorization: "Bearer scheduler-secret-value-1234567890",
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({
          runId: RUN_ID,
          executionGrantId: grantId,
          input: {
            actorUserId: "spoof",
            billingAccountId: "spoof",
            messages: [{ role: "user", content: "coordinate" }],
            modelRef: { providerKey: "platform", modelId: "test-model" },
          },
        }),
      },
    );
  }
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeCount = 0;
    mocks.checkIdempotency.mockResolvedValue({ status: "new" });
    mocks.createPendingRequest.mockResolvedValue({
      status: "claimed",
      request: { runId: RUN_ID },
    });
    mocks.validateGrant.mockResolvedValue({
      userId: USER_ID,
      billingAccountId: BILLING_ID,
    });
  });
  it("validates grant and derives actor and billing rather than payload identity", async () => {
    const response = await POST(request(), {
      params: Promise.resolve({ graphId: "langgraph:cogni" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.validateGrant).toHaveBeenCalledOnce();
    expect(mocks.executeCount).toBe(1);
    expect(mocks.executeArgs[1]).toMatchObject({ actorUserId: USER_ID });
  });
  it("persists the trusted complete initiating model and admits the resulting scheduled tick", async () => {
    const { bindScheduleModel } = await import(
      "@/bootstrap/capabilities/schedule-model"
    );
    const { createScheduleManageImplementation } = await import(
      "@cogni/shared-ai-tools"
    );
    const saved: Record<string, unknown>[] = [];
    const capability = {
      list: async () => [],
      create: async (input: any) => {
        saved.push(input.input);
        return {
          ...input,
          id: "schedule-1",
          enabled: true,
          nextRunAt: null,
          lastRunAt: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        };
      },
      update: async () => {
        throw new Error("unexpected update");
      },
      remove: async () => {},
      setEnabled: async () => {
        throw new Error("unexpected toggle");
      },
    };
    const models = [
      { providerKey: "platform", modelId: "free" },
      {
        providerKey: "codex",
        modelId: "byo",
        connectionId: "50000000-0000-4000-a000-000000000001",
      },
    ];
    await Promise.all(
      models.map((modelRef) =>
        createScheduleManageImplementation({
          scheduleCapability: bindScheduleModel(capability, modelRef),
        }).execute({
          action: "create",
          graphId: "langgraph:cogni",
          cron: "0 * * * *",
          timezone: "UTC",
          instruction: "coordinate",
          purpose: modelRef.modelId,
          input: { modelRef: { providerKey: "spoof", modelId: "spoof" } },
        }),
      ),
    );
    expect(saved.map((x) => x.modelRef)).toEqual(models);
    for (const input of saved) {
      const response = await POST(
        new NextRequest(
          "http://localhost/api/internal/graphs/langgraph:cogni/runs",
          {
            method: "POST",
            headers: {
              authorization: "Bearer scheduler-secret-value-1234567890",
              "content-type": "application/json",
              "idempotency-key": key,
            },
            body: JSON.stringify({
              runId: RUN_ID,
              executionGrantId: grantId,
              input,
            }),
          },
        ),
        { params: Promise.resolve({ graphId: "langgraph:cogni" }) },
      );
      expect(response.status).toBe(200);
      expect(mocks.executeArgs[0]).toMatchObject({
        graphId: "langgraph:cogni",
        modelRef: input.modelRef,
      });
      expect(mocks.executeArgs[1]).toMatchObject({ actorUserId: USER_ID });
    }
    expect(mocks.validateGrant).toHaveBeenCalledTimes(2);
  });

  it("rejects revoked grant before cache or execution", async () => {
    mocks.validateGrant.mockRejectedValue(new Error("revoked"));
    const response = await POST(request(), {
      params: Promise.resolve({ graphId: "langgraph:cogni" }),
    });
    expect(response.status).toBe(403);
    expect(mocks.checkIdempotency).not.toHaveBeenCalled();
    expect(mocks.executeCount).toBe(0);
  });
  it("admits one of two concurrent schedule deliveries", async () => {
    let claimed = false;
    mocks.createPendingRequest.mockImplementation(async () => {
      if (claimed) return { status: "pending", request: { runId: RUN_ID } };
      claimed = true;
      return { status: "claimed", request: { runId: RUN_ID } };
    });
    const params = { params: Promise.resolve({ graphId: "langgraph:cogni" }) };
    const responses = await Promise.all([
      POST(request(), params),
      POST(request(), params),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(mocks.executeCount).toBe(1);
  });
});

describe("authenticated facade to guarded shared receiver", () => {
  it.each([
    ["cookie", false],
    ["bearer", false],
    ["cookie", true],
    ["bearer", true],
  ])(
    "carries %s identity and billing across the durable claim (grant %s)",
    async (method, granted) => {
      const { completionStream } = await import(
        "@/app/_facades/ai/completion.server"
      );
      const { issueAgentApiKey, resolveRequestIdentity } = await import(
        "@/app/_lib/auth/request-identity"
      );
      const { LangGraphInProcProvider } = await import(
        "@/adapters/server/ai/langgraph/inproc.provider"
      );
      const actor = "dfa8570f-d487-4239-b40a-2e39ee4513f9";
      mocks.integrated = true;
      mocks.cookie = {
        id: actor,
        walletAddress: null,
        displayName: null,
        avatarColor: null,
      };
      mocks.headers =
        method === "bearer"
          ? new Headers({
              authorization: `Bearer ${issueAgentApiKey({ userId: actor, displayName: null })}`,
            })
          : new Headers();
      const sessionUser = await resolveRequestIdentity();
      expect(sessionUser?.id).toBe(actor);
      let claim: any;
      let leased = false;
      mocks.checkIdempotency.mockImplementation(async () =>
        claim ? { status: "pending", request: claim } : { status: "new" },
      );
      mocks.createPendingRequest.mockImplementation(
        async (key, hash, runId, _trace, lease) => {
          if (!claim) {
            claim = { idempotencyKey: key, requestHash: hash, runId, ok: null };
            return { status: "claimed", request: claim };
          }
          if (lease && !leased) {
            leased = true;
            return { status: "claimed", request: claim };
          }
          return { status: "pending", request: claim };
        },
      );
      let model = 0,
        sandbox = 0,
        mint = 0;
      let modelScope: any;
      const shell = "core__sandbox_shell";
      const runtime: any = {
        id: shell,
        effect: "external_side_effect",
        spec: {
          name: shell,
          effect: "external_side_effect",
          redaction: { mode: "top_level_only", allowlist: [] },
        },
        validateInput: (v: unknown) => v,
        validateOutput: (v: unknown) => v,
        redact: (v: unknown) => v,
        exec: async () => {
          sandbox++;
          mint++;
          return {};
        },
      };
      const contract: any = {
        name: shell,
        requires: { scope: "sandbox:exec", kind: "node", subject: "member" },
      };
      mocks.provider = new LangGraphInProcProvider(
        {
          executeCompletionUnit: () => {
            model++;
            modelScope = getExecutionScope();
            return {
              stream: (async function* () {})(),
              final: Promise.resolve({
                ok: true as const,
                content: "done",
                finishReason: "stop" as const,
              }),
            };
          },
        } as any,
        {
          getBoundTool: (id: string) => (id === shell ? runtime : undefined),
          listToolSpecs: () => [],
          hasToolId: (id: string) => id === shell,
        } as any,
        async () => null,
        [{ contract }],
        {
          resolvePrincipal: async () => "principal",
          guardDeps: {
            withStore: async (fn: any) =>
              fn({
                liveScopes: async () => (granted ? ["sandbox:exec"] : []),
                hasLiveRole: async () => granted,
              }),
            adminCheck: async () => "denied",
          },
          sourceContext: async () => ({
            nodeId: "red",
            origin: "https://red.cognidao.org",
            mission: { content: "Red", sourceRef: "fixture", buildSha: null },
            governingIndex: [],
          }),
          isCodingActor: (id: string) => id === actor,
          sandboxReady: () => true,
        } as any,
      );
      mocks.publish.mockResolvedValue(undefined);
      const ctx: any = {
        reqId: "request",
        traceId: "00000000000000000000000000000001",
        log: { warn: vi.fn() },
      };
      try {
        const accepted = await completionStream(
          {
            sessionUser: sessionUser!,
            graphName: "langgraph:cogni",
            messages: [{ role: "user", content: "hello" }],
            modelRef: { providerKey: "platform", modelId: "test-model" },
            idempotencyKey: `case-${method}`,
            acceptanceMode: "workflow-start",
          },
          ctx,
        );
        expect(mocks.workflow.runId).toBe(accepted.runId);
        expect(mocks.workflow.input.executionClaimKey).toBe(
          claim.idempotencyKey,
        );
        const response = await POST(
          new NextRequest(
            "http://localhost/api/internal/graphs/langgraph:cogni/runs",
            {
              method: "POST",
              headers: {
                authorization: "Bearer scheduler-secret-value-1234567890",
                "content-type": "application/json",
                "idempotency-key": `api:${accepted.runId}`,
              },
              body: JSON.stringify({
                runId: accepted.runId,
                executionGrantId: null,
                input: mocks.workflow.input,
              }),
            },
          ),
          { params: Promise.resolve({ graphId: "langgraph:cogni" }) },
        );
        expect(response.status).toBe(200);
        expect(leased).toBe(true);
        const result = await response.json();
        if (granted) {
          expect(result.ok).toBe(true);
          expect(model).toBeGreaterThan(0);
          expect(modelScope).toMatchObject({
            actorUserId: actor,
            billing: {
              billingAccountId: BILLING_ID,
              virtualKeyId: VIRTUAL_KEY_ID,
            },
          });
        } else {
          expect(result.ok).toBe(false);
          expect(model).toBe(0);
        }
        expect([sandbox, mint]).toEqual([0, 0]);
      } finally {
        mocks.integrated = false;
      }
    },
  );
});

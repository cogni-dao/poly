// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/ai/completion-stream-acceptance`
 * Purpose: Prove workflow acceptance is returned before Redis emits its first event.
 * Scope: Completion facade with mocked billing, Temporal, and RunStream ports.
 * Invariants: Temporal start is awaited; first-event timeout is an in-band terminal error.
 * Side-effects: none
 * @internal
 */

import { createHash, createHmac } from "node:crypto";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { TEST_SESSION_USER_1 } from "@tests/_fakes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeNoopLogger, type RequestContext } from "@/shared/observability";

const mocks = vi.hoisted(() => {
  const claims = new Map<string, { requestHash: string; runId: string }>();
  return {
    claims,
    workflowStart: vi.fn().mockResolvedValue({}),
    subscribe: vi.fn(() =>
      (async function* () {
        await new Promise<never>(() => undefined);
      })()
    ),
    checkIdempotency: vi.fn(async (key: string, requestHash: string) => {
      const existing = claims.get(key);
      if (!existing) return { status: "new" as const };
      if (existing.requestHash !== requestHash) {
        return {
          status: "mismatch" as const,
          existingHash: existing.requestHash,
          providedHash: requestHash,
        };
      }
      return {
        status: "pending" as const,
        request: { ...existing, idempotencyKey: key },
      };
    }),
    createPendingRequest: vi.fn(
      async (key: string, requestHash: string, runId: string) => {
        if (claims.has(key)) throw new Error("duplicate claim");
        claims.set(key, { requestHash, runId });
      }
    ),
  };
});

vi.mock("@/bootstrap/container", () => ({
  resolveAiAdapterDeps: () => ({ accountService: {} }),
  getTemporalWorkflowClient: async () => ({
    client: { start: mocks.workflowStart },
    taskQueue: "scheduler-tasks",
  }),
  getContainer: () => ({
    runStream: { subscribe: mocks.subscribe },
    executionRequestPort: {
      checkIdempotency: mocks.checkIdempotency,
      createPendingRequest: mocks.createPendingRequest,
    },
  }),
}));

vi.mock("@/lib/auth/mapping", () => ({
  getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
    id: "billing-1",
    defaultVirtualKeyId: "vk-1",
  }),
}));

vi.mock("@/shared/config", () => ({ getNodeId: () => "node-template" }));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ AUTH_SECRET: "stable-completion-idempotency-secret" }),
}));

const ctx: RequestContext = {
  log: makeNoopLogger(),
  reqId: "request-1",
  traceId: "00000000000000000000000000000000",
  routeId: "ai.chat",
  clock: { now: () => "2025-01-01T00:00:00.000Z" },
};

describe("completionStream durable acceptance", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.useRealTimers();
    mocks.claims.clear();
  });

  it("reuses an exact durable idempotency claim without storing a raw prompt hash", async () => {
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const input = {
      messages: [{ role: "user" as const, content: "hello" }],
      modelRef: { providerKey: "platform" as const, modelId: "test-model" },
      sessionUser: TEST_SESSION_USER_1,
      graphName: "langgraph:default",
      idempotencyKey: "caller-key",
      acceptanceMode: "workflow-start" as const,
    };

    await completionStream(input, ctx);
    const alreadyStarted = new Error("already started");
    Object.setPrototypeOf(
      alreadyStarted,
      WorkflowExecutionAlreadyStartedError.prototype
    );
    mocks.workflowStart.mockRejectedValueOnce(alreadyStarted);
    await completionStream(input, ctx);

    expect(mocks.claims.size).toBe(1);
    const persistedHash = [...mocks.claims.values()][0]?.requestHash;
    expect(persistedHash).not.toBe(
      createHash("sha256").update("hello", "utf8").digest("hex")
    );
    const canonicalRequest = JSON.stringify({
      graphId: "langgraph:default",
      messages: [{ content: "hello", role: "user" }],
      modelRef: { modelId: "test-model", providerKey: "platform" },
      stateKey: null,
    });
    expect(persistedHash).toBe(
      createHmac("sha256", "stable-completion-idempotency-secret")
        .update("completion-request:v1\0", "utf8")
        .update(canonicalRequest, "utf8")
        .digest("hex")
    );
    expect(persistedHash).not.toBe(
      createHmac("sha256", "stable-completion-idempotency-secret")
        .update("chat-prompt:v1\0", "utf8")
        .update(canonicalRequest, "utf8")
        .digest("hex")
    );
    expect(mocks.workflowStart).toHaveBeenCalledTimes(2);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  });

  it("rejects changed content or graph before Temporal start and subscription", async () => {
    const { completionStream, CompletionIdempotencyConflictError } =
      await import("@/app/_facades/ai/completion.server");
    const base = {
      messages: [{ role: "user" as const, content: "hello" }],
      modelRef: { providerKey: "platform" as const, modelId: "test-model" },
      sessionUser: TEST_SESSION_USER_1,
      graphName: "langgraph:default",
      idempotencyKey: "caller-key",
      acceptanceMode: "workflow-start" as const,
    };

    await completionStream(base, ctx);
    await expect(
      completionStream(
        { ...base, messages: [{ role: "user", content: "changed" }] },
        ctx
      )
    ).rejects.toBeInstanceOf(CompletionIdempotencyConflictError);
    await expect(
      completionStream({ ...base, graphName: "langgraph:other" }, ctx)
    ).rejects.toBeInstanceOf(CompletionIdempotencyConflictError);

    expect(mocks.workflowStart).toHaveBeenCalledOnce();
    expect(mocks.subscribe).toHaveBeenCalledOnce();
  });

  it("allows only one of two concurrent changed requests to claim the key", async () => {
    const { completionStream, CompletionIdempotencyConflictError } =
      await import("@/app/_facades/ai/completion.server");
    const base = {
      modelRef: { providerKey: "platform" as const, modelId: "test-model" },
      sessionUser: TEST_SESSION_USER_1,
      graphName: "langgraph:default",
      idempotencyKey: "concurrent-key",
      acceptanceMode: "workflow-start" as const,
    };

    const outcomes = await Promise.allSettled([
      completionStream(
        { ...base, messages: [{ role: "user", content: "first" }] },
        ctx
      ),
      completionStream(
        { ...base, messages: [{ role: "user", content: "second" }] },
        ctx
      ),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled")
    ).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: expect.any(CompletionIdempotencyConflictError),
    });
    expect(mocks.workflowStart).toHaveBeenCalledOnce();
    expect(mocks.subscribe).toHaveBeenCalledOnce();
  });

  it("scopes execution idempotency by node and billing account", async () => {
    const { scopeExecutionIdempotencyKey } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const callerKey = "chat:thread-1:message-1";

    const firstAccount = scopeExecutionIdempotencyKey(
      "node-template",
      "billing-1",
      "user-1",
      callerKey
    );
    const secondAccount = scopeExecutionIdempotencyKey(
      "node-template",
      "billing-2",
      "user-1",
      callerKey
    );

    expect(firstAccount).not.toBe(secondAccount);
    expect(firstAccount).toBe(
      scopeExecutionIdempotencyKey(
        "node-template",
        "billing-1",
        "user-1",
        callerKey
      )
    );
    expect(firstAccount).not.toBe(
      scopeExecutionIdempotencyKey(
        "node-template",
        "billing-1",
        "user-2",
        callerKey
      )
    );
  });

  it("returns after Temporal start without awaiting the first Redis event", async () => {
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );

    const accepted = await completionStream(
      {
        messages: [{ role: "user", content: "hello" }],
        modelRef: { providerKey: "platform", modelId: "test-model" },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:default",
        stateKey: "thread-1",
        messageId: "message-1",
        serverRunId: "123e4567-e89b-42d3-a456-426614174000",
        idempotencyKey: "chat:thread-1:message-1",
        acceptanceMode: "workflow-start",
      },
      ctx
    );

    expect(mocks.workflowStart).toHaveBeenCalledOnce();
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    expect(accepted.runId).toBe("123e4567-e89b-42d3-a456-426614174000");
  });

  it("emits the first-event deadline as an in-band timeout", async () => {
    vi.useFakeTimers();
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const accepted = await completionStream(
      {
        messages: [{ role: "user", content: "hello" }],
        modelRef: { providerKey: "platform", modelId: "test-model" },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:default",
        acceptanceMode: "workflow-start",
      },
      ctx
    );

    const nextEvent = accepted.stream[Symbol.asyncIterator]().next();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(nextEvent).resolves.toEqual({
      done: false,
      value: { type: "error", error: "timeout" },
    });
  });

  it("treats subscriber abort as detach without stream-ended failure", async () => {
    const abortController = new AbortController();
    const warn = vi.spyOn(ctx.log, "warn");
    mocks.subscribe.mockImplementationOnce((_runId, signal: AbortSignal) =>
      (async function* () {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })()
    );
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const accepted = await completionStream(
      {
        messages: [{ role: "user", content: "hello" }],
        modelRef: { providerKey: "platform", modelId: "test-model" },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:default",
        acceptanceMode: "workflow-start",
        abortSignal: abortController.signal,
      },
      ctx
    );

    const nextEvent = accepted.stream[Symbol.asyncIterator]().next();
    abortController.abort();

    await expect(nextEvent).resolves.toEqual({ done: true, value: undefined });
    await expect(accepted.final).resolves.toMatchObject({
      ok: false,
      error: "aborted",
    });
    expect(warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "stream_ended_no_terminal" }),
      expect.anything()
    );
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/ai.chat.idempotency`
 * Purpose: Prove accepted chat retries cannot append duplicate or mutated user turns.
 * Scope: Chat route with in-memory thread persistence and mocked completion facade.
 * Invariants: exact envelope replay is a no-op; identity reuse with changed content is 409.
 * Side-effects: none
 * @internal
 */

import { createHmac } from "node:crypto";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import type { UIMessage } from "ai";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadConflictError } from "@/ports";

let thread: UIMessage[] = [];
const loadThread = vi.fn(async () => [...thread]);
const saveThread = vi.fn(
  async (
    _userId: string,
    _stateKey: string,
    messages: UIMessage[],
    expected: number
  ) => {
    if (thread.length !== expected) throw new ThreadConflictError(_stateKey);
    thread = messages;
  }
);

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: {
      child: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    },
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    threadPersistenceForUser: () => ({
      loadThread,
      saveThread,
      softDelete: vi.fn(),
      listThreads: vi.fn(),
    }),
  }),
}));

vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: async (
    _name: string,
    _attributes: unknown,
    handler: (value: { traceId: string; span: { setAttribute: () => void } }) =>
      Promise<unknown>
  ) => handler({ traceId: "trace-1", span: { setAttribute: vi.fn() } }),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_options: unknown, handler: (...args: never[]) => unknown) =>
    (request: NextRequest, context?: unknown) =>
      handler(
        {
          reqId: "request-1",
          traceId: "trace-1",
          routeId: "ai.chat",
          clock: { now: () => "2025-01-01T00:00:00.000Z" },
          log: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          },
        } as never,
        request as never,
        TEST_SESSION_USER_1 as never,
        context as never
      ),
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ AUTH_SECRET: "stable-test-prompt-digest-secret" }),
}));

const { completionStream } = vi.hoisted(() => ({
  completionStream: vi.fn(
    async (input: {
      serverRunId?: string;
      messages?: Array<{ role: string; content: string }>;
    }) => ({
      stream: (async function* () {
        yield { type: "assistant_final" as const, content: "ok" };
        yield { type: "done" as const };
      })(),
      final: Promise.resolve({
        ok: true as const,
        requestId: input.serverRunId ?? "run",
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: "stop",
      }),
      runId:
        input.serverRunId ?? "123e4567-e89b-42d3-a456-426614174000",
      workflowId: "graph-run:billing:chat:thread-1:message-1",
    })
  ),
}));

vi.mock("@/app/_facades/ai/completion.server", () => ({ completionStream }));

import { POST } from "@/app/api/v1/ai/chat/route";

const base = {
  modelRef: { providerKey: "platform", modelId: "test-model" },
  graphName: "langgraph:default",
  stateKey: "thread-1",
  messageId: "message-1",
  runId: "123e4567-e89b-42d3-a456-426614174000",
};

async function send(message: string, overrides: Partial<typeof base> = {}) {
  const response = await POST(
    new NextRequest("http://localhost/api/v1/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, ...overrides, message }),
    })
  );
  if (response.status === 200) await response.text();
  return response;
}

describe("POST /api/v1/ai/chat idempotency", () => {
  beforeEach(() => {
    thread = [];
    vi.clearAllMocks();
  });

  it("suppresses an exact retry and returns stable discovery headers", async () => {
    const first = await send("hello");
    const retry = await send("hello");

    expect(first.headers.get("X-State-Key")).toBe("thread-1");
    expect(first.headers.get("X-Run-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(first.headers.get("X-Run-Id")).not.toBe(base.runId);
    expect(retry.headers.get("X-Run-Id")).toBe(
      first.headers.get("X-Run-Id")
    );
    expect(retry.status).toBe(200);
    expect(thread.filter((message) => message.role === "user")).toHaveLength(1);
    expect(saveThread).toHaveBeenCalledOnce();
    expect(completionStream.mock.calls[0]?.[0].serverRunId).toBe(
      completionStream.mock.calls[1]?.[0].serverRunId
    );
  });

  it("retries the immutable user prefix after the assistant is persisted", async () => {
    const first = await send("hello");
    expect(first.status).toBe(200);
    thread = [
      ...thread,
      {
        id: `assistant-${first.headers.get("X-Run-Id")}`,
        role: "assistant",
        parts: [{ type: "text", text: "persisted answer" }],
      },
    ];

    const retry = await send("hello");

    expect(retry.status).toBe(200);
    expect(saveThread).toHaveBeenCalledOnce();
    expect(completionStream).toHaveBeenCalledTimes(2);
    expect(completionStream.mock.calls[0]?.[0].messages).toEqual(
      completionStream.mock.calls[1]?.[0].messages
    );
    expect(completionStream.mock.calls[1]?.[0].messages).toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
    ]);
    expect(thread.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("maps a facade idempotency conflict to 409", async () => {
    const conflict = new Error("conflict");
    conflict.name = "CompletionIdempotencyConflictError";
    completionStream.mockRejectedValueOnce(conflict);

    const response = await send("hello");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Completion identity already exists with different input",
    });
  });

  it("returns discovery headers while the first graph event is still deferred", async () => {
    let releaseFirstEvent: (() => void) | undefined;
    completionStream.mockImplementationOnce(async (input) => ({
      stream: (async function* () {
        await new Promise<void>((resolve) => {
          releaseFirstEvent = resolve;
        });
        yield { type: "done" as const };
      })(),
      final: Promise.resolve({
        ok: true as const,
        requestId: input.serverRunId ?? "run",
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: "stop",
      }),
      runId: input.serverRunId ?? base.runId,
      workflowId: "graph-run:accepted",
    }));

    const response = await POST(
      new NextRequest("http://localhost/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...base, message: "deferred" }),
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-State-Key")).toBe(base.stateKey);
    expect(response.headers.get("X-Run-Id")).not.toBe(base.runId);
    expect(thread).toHaveLength(1);
    await vi.waitFor(() => expect(releaseFirstEvent).toBeTypeOf("function"));
    releaseFirstEvent?.();
    await response.text();
  });

  it("adopts the winning immutable envelope during a concurrent exact retry", async () => {
    // Warm the route wrapper before introducing concurrency; production boot does
    // this once, while the test container intentionally has no real server env.
    await send("warmup", {
      stateKey: "warmup-thread",
      messageId: "warmup-message",
      runId: undefined,
    });
    thread = [];
    vi.clearAllMocks();

    const [first, retry] = await Promise.all([
      send("concurrent", { runId: undefined }),
      send("concurrent", { runId: undefined }),
    ]);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(first.headers.get("X-Run-Id")).toBe(
      retry.headers.get("X-Run-Id")
    );
    expect(thread.filter((message) => message.role === "user")).toHaveLength(1);
    expect(saveThread).toHaveBeenCalledTimes(2);
    expect(completionStream).toHaveBeenCalledTimes(2);
    expect(completionStream.mock.calls[0]?.[0].serverRunId).toBe(
      completionStream.mock.calls[1]?.[0].serverRunId
    );
  });

  it("rejects reuse of messageId with changed content", async () => {
    await send("original");
    const mismatch = await send("mutated");

    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      error: "Message identity already exists with different content",
    });
    expect(thread).toHaveLength(1);
  });

  it("uses a keyed prompt digest and rejects redaction-equivalent mutation", async () => {
    const original = "use sk-abc123456789012345678901";
    const mutated = "use sk-xyz123456789012345678901";

    const first = await send(original);
    const exactRetry = await send(original);
    const redactionEquivalentMutation = await send(mutated);
    const digest = (
      thread[0]?.metadata as
        | { chatTurn?: { messageDigest?: string } }
        | undefined
    )?.chatTurn?.messageDigest;

    expect(first.status).toBe(200);
    expect(exactRetry.status).toBe(200);
    expect(redactionEquivalentMutation.status).toBe(409);
    expect(JSON.stringify(thread)).not.toContain("sk-abc123456789012345678901");
    expect(digest).toBe(
      createHmac("sha256", "stable-test-prompt-digest-secret")
        .update("chat-prompt:v1\0", "utf8")
        .update(original, "utf8")
        .digest("hex")
    );
    expect(digest).not.toBe(
      createHmac("sha256", "stable-test-prompt-digest-secret")
        .update("chat-prompt:v1\0", "utf8")
        .update(mutated, "utf8")
        .digest("hex")
    );
    expect(digest).not.toBe(
      createHmac("sha256", "stable-test-prompt-digest-secret")
        .update("completion-request:v1\0", "utf8")
        .update(original, "utf8")
        .digest("hex")
    );
    expect(thread.filter((message) => message.role === "user")).toHaveLength(1);
  });
});

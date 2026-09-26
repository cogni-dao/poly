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
  checkIdempotency: vi.fn().mockResolvedValue({ status: "new" }),
  createPendingRequest: vi.fn().mockResolvedValue(undefined),
  finalizeRequest: vi.fn(),
  publish: vi.fn(async (_runId: string, event: { type: string }) => {
    if (event.type === "done") throw new Error("redis unavailable");
  }),
  saveThread: vi.fn().mockResolvedValue(undefined),
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
        context as never
      ),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ SCHEDULER_API_TOKEN: "scheduler-secret-value-1234567890" }),
}));

vi.mock("@/bootstrap/graph-executor.factory", () => {
  const executor = {
    runGraph: () => ({
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
    }),
  };
  return {
    createGraphExecutor: () => executor,
    createScopedGraphExecutor: () => executor,
  };
});

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    executionRequestPort: {
      checkIdempotency: mocks.checkIdempotency,
      createPendingRequest: mocks.createPendingRequest,
      finalizeRequest: mocks.finalizeRequest,
    },
    accountsForUser: () => ({}),
    providerResolver: {},
    connectionBroker: undefined,
    runStream: {
      publish: mocks.publish,
      expire: vi.fn().mockResolvedValue(undefined),
    },
    threadPersistenceForUser: () => ({
      loadThread: vi.fn().mockResolvedValue([
        { id: "message-1", role: "user", parts: [{ type: "text", text: "hello" }] },
      ]),
      saveThread: mocks.saveThread,
      softDelete: vi.fn(),
      listThreads: vi.fn(),
    }),
  }),
}));

import { POST } from "@/app/api/internal/graphs/[graphId]/runs/route";

describe("POST /api/internal/graphs/{graphId}/runs terminal publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        }
      ),
      { params: Promise.resolve({ graphId: "langgraph:default" }) }
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
        }
      ),
      { params: Promise.resolve({ graphId: "langgraph:default" }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.finalizeRequest).toHaveBeenCalledWith("ai:scoped-key", {
      ok: false,
      errorCode: "internal",
    });
  });
});

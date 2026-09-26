// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { chatCompletionsContract } from "@cogni/node-contracts";
import {
  createMockAccountServiceWithDefaults,
  FakeAiTelemetryAdapter,
  FakeClock,
  TEST_SESSION_USER_1,
} from "@tests/_fakes";
import { TEST_MODEL_ID } from "@tests/_fakes/ai/fakes";
import { createRunStreamMock } from "@tests/_fixtures/ai/completion-facade-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatCompletion } from "@/app/_facades/ai/completion.server";
import type { RequestContext } from "@/shared/observability";
import { makeNoopLogger } from "@/shared/observability";

const startMock = vi.fn().mockResolvedValue({});

// vi.mock factories are hoisted — can't reference module imports.
// Keep inline; fixture used in non-hoisted test helpers.
vi.mock("@/bootstrap/container", () => {
  const claims = new Map<string, { requestHash: string; runId: string }>();
  const executionRequestPort = {
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
        claims.set(key, { requestHash, runId });
      }
    ),
  };
  return {
    resolveAiAdapterDeps: vi.fn(),
    getTemporalWorkflowClient: vi.fn(async () => ({
      client: { start: startMock },
      taskQueue: "scheduler-tasks",
    })),
    getContainer: vi.fn(() => ({
      executionRequestPort,
      runStream: {
      subscribe: async function* () {
        yield {
          id: "1-0",
          event: { type: "text_delta" as const, delta: "AI response" },
        };
        yield {
          id: "2-0",
          event: { type: "assistant_final" as const, content: "AI response" },
        };
        yield {
          id: "3-0",
          event: {
            type: "done" as const,
            usage: { promptTokens: 10, completionTokens: 20 },
            finishReason: "stop",
          },
        };
      },
      },
    })),
  };
});

vi.mock("@/shared/config", () => ({
  getNodeId: () => "node_template",
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ AUTH_SECRET: "stable-completion-idempotency-secret" }),
}));

import { createExecutionRequestPortMock } from "@tests/_fixtures/ai/completion-facade-setup";
import { resolveAiAdapterDeps } from "@/bootstrap/container";

const mockResolveAiAdapterDeps = vi.mocked(resolveAiAdapterDeps);

describe("app/_facades/ai/completion.server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const fakeClock = new FakeClock("2025-01-01T12:00:00.000Z");
    mockResolveAiAdapterDeps.mockReturnValue({
      llmService: {} as never,
      accountService: createMockAccountServiceWithDefaults(),
      clock: fakeClock,
      aiTelemetry: new FakeAiTelemetryAdapter(),
      langfuse: undefined,
    });
  });

  it("returns OpenAI-compatible completion output", async () => {
    const testCtx: RequestContext = {
      log: makeNoopLogger(),
      reqId: "test-req-123",
      traceId: "00000000000000000000000000000000",
      routeId: "test.route",
      clock: new FakeClock("2025-01-01T12:00:00.000Z"),
    };

    const result = await chatCompletion(
      {
        messages: [{ role: "user", content: "Hello" }],
        modelRef: { providerKey: "platform", modelId: TEST_MODEL_ID },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:poet",
      },
      testCtx
    );

    expect(() => chatCompletionsContract.output.parse(result)).not.toThrow();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(result.choices[0]?.message.content).toBe("AI response");
  });

  it("propagates stream errors to final response", async () => {
    vi.mocked(resolveAiAdapterDeps).mockReturnValueOnce({
      llmService: {} as never,
      accountService: createMockAccountServiceWithDefaults(),
      clock: new FakeClock("2025-01-01T12:00:00.000Z"),
      aiTelemetry: new FakeAiTelemetryAdapter(),
      langfuse: undefined,
    });

    const { getContainer } = await import("@/bootstrap/container");
    vi.mocked(getContainer).mockReturnValue({
      executionRequestPort: createExecutionRequestPortMock(),
      runStream: createRunStreamMock({
        responseContent: "",
        emitError: "internal",
      }),
    } as never);

    const testCtx: RequestContext = {
      log: makeNoopLogger(),
      reqId: "test-req-456",
      traceId: "00000000000000000000000000000000",
      routeId: "test.route",
      clock: new FakeClock("2025-01-01T12:00:00.000Z"),
    };

    await expect(
      chatCompletion(
        {
          messages: [{ role: "user", content: "Hello" }],
          modelRef: { providerKey: "platform", modelId: TEST_MODEL_ID },
          sessionUser: TEST_SESSION_USER_1,
          graphName: "langgraph:poet",
        },
        testCtx
      )
    ).rejects.toThrow("AI execution failed: internal");
  });
});

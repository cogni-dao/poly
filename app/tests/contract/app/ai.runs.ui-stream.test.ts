// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/ai.runs.ui-stream`
 * Purpose: Prove chat replay uses AI SDK SSE, cursor forwarding, ownership, and Postgres fallback signaling.
 * Scope: Route contract with mocked run repository and Redis stream.
 * Invariants: terminal runs return 410; raw AiEvents are mapped before cursor advancement.
 * Side-effects: none
 * @internal
 */

import type { RunStreamPort } from "@cogni/graph-execution-core";
import type { GraphRun } from "@cogni/scheduler-core";
import { TEST_SESSION_USER_1, TEST_USER_ID_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as appHandler from "@/app/api/v1/ai/runs/[runId]/ui-stream/route";

const RUN_ID = "a0000000-0000-4000-a000-000000000001";
const makeRun = (status: GraphRun["status"] = "running"): GraphRun => ({
  id: "pk-1",
  scheduleId: null,
  runId: RUN_ID,
  graphId: "langgraph:default",
  runKind: "user_immediate",
  triggerSource: "api",
  triggerRef: null,
  requestedBy: TEST_USER_ID_1,
  scheduledFor: null,
  startedAt: new Date(),
  completedAt: status === "running" ? null : new Date(),
  status,
  attemptCount: 0,
  langfuseTraceId: null,
  errorCode: null,
  errorMessage: null,
});

const graphRunRepository = { getRunByRunId: vi.fn() };
const runStream: RunStreamPort = {
  publish: vi.fn(),
  subscribe: vi.fn(),
  expire: vi.fn(),
  streamLength: vi.fn(),
};

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
    graphRunRepository,
    runStream,
  }),
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

describe("GET /api/v1/ai/runs/{runId}/ui-stream", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 for a missing run and 403 for another user's run", async () => {
    graphRunRepository.getRunByRunId.mockResolvedValueOnce(null);
    await testApiHandler({
      appHandler,
      params: { runId: RUN_ID },
      async test({ fetch }) {
        expect((await fetch({ method: "GET" })).status).toBe(404);
      },
    });

    graphRunRepository.getRunByRunId.mockResolvedValueOnce({
      ...makeRun(),
      requestedBy: "another-user",
    });
    await testApiHandler({
      appHandler,
      params: { runId: RUN_ID },
      async test({ fetch }) {
        expect((await fetch({ method: "GET" })).status).toBe(403);
      },
    });
  });

  it("rejects an invalid replay cursor", async () => {
    graphRunRepository.getRunByRunId.mockResolvedValue(makeRun());
    await testApiHandler({
      appHandler,
      params: { runId: RUN_ID },
      async test({ fetch }) {
        const response = await fetch({
          method: "GET",
          headers: { "Last-Event-ID": "not-a-cursor" },
        });
        expect(response.status).toBe(400);
      },
    });
  });

  it("returns a successful terminal outcome even when Redis still has entries", async () => {
    graphRunRepository.getRunByRunId.mockResolvedValue(makeRun("success"));
    vi.mocked(runStream.streamLength).mockResolvedValue(3);

    await testApiHandler({
      appHandler,
      params: { runId: RUN_ID },
      async test({ fetch }) {
        const response = await fetch({ method: "GET" });
        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({
          error: "Run is terminal",
          terminalStatus: "success",
        });
        expect(runStream.subscribe).not.toHaveBeenCalled();
        expect(runStream.streamLength).not.toHaveBeenCalled();
      },
    });
  });

  it("returns the terminal failure status and error code", async () => {
    graphRunRepository.getRunByRunId.mockResolvedValue({
      ...makeRun("error"),
      errorCode: "provider_unavailable",
      errorMessage: "provider failed",
    });

    await testApiHandler({
      appHandler,
      params: { runId: RUN_ID },
      async test({ fetch }) {
        const response = await fetch({ method: "GET" });
        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({
          error: "Run is terminal",
          terminalStatus: "error",
          errorCode: "provider_unavailable",
        });
        expect(runStream.subscribe).not.toHaveBeenCalled();
      },
    });
  });

  it("maps Redis events to AI SDK chunks and forwards the replay cursor", async () => {
    graphRunRepository.getRunByRunId.mockResolvedValue(makeRun());
    vi.mocked(runStream.subscribe).mockReturnValue(
      (async function* () {
        yield {
          id: "2-0",
          event: { type: "text_delta" as const, delta: "Hello" },
        };
        yield {
          id: "3-0",
          event: { type: "assistant_final" as const, content: "Hello world" },
        };
        yield { id: "4-0", event: { type: "done" as const } };
      })()
    );

    await testApiHandler({
      appHandler,
      params: { runId: RUN_ID },
      async test({ fetch }) {
        const response = await fetch({
          method: "GET",
          headers: { "Last-Event-ID": "1-0" },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("X-Run-Id")).toBe(RUN_ID);
        const body = await response.text();
        expect(body).toContain('"type":"data-run-cursor"');
        expect(body).toContain('"type":"text-delta"');
        expect(body).toContain(" world");
        expect(body).toContain('"type":"finish"');
        expect(body.indexOf('"type":"text-delta"')).toBeLessThan(
          body.indexOf('"cursor":"2-0"')
        );
        expect(body.indexOf('"type":"finish"')).toBeLessThan(
          body.indexOf('"cursor":"4-0"')
        );
        expect(body).not.toContain('"cursor":"3-0"');
        expect(runStream.subscribe).toHaveBeenCalledWith(
          RUN_ID,
          expect.any(AbortSignal),
          "1-0"
        );
      },
    });
  });
});

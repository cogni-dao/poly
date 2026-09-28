// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/ai/runs/[runId]/ui-stream`
 * Purpose: Reconnect an authenticated chat client to a graph run using AI SDK UIMessageChunk SSE.
 * Scope: Ownership check, Redis replay subscription, and AiEvent-to-UIMessageChunk delivery only.
 * Invariants: Redis is ephemeral transport; terminal runs return 410 so clients reload Postgres.
 * Side-effects: IO (graph-run lookup, Redis subscription, HTTP stream)
 * Links: sibling raw /stream endpoint, /api/v1/ai/chat
 * @public
 */

import { toUserId, userActor } from "@cogni/ids";
import { RunStreamParamsSchema } from "@cogni/node-contracts";
import type { UIMessageChunk } from "ai";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";
import { UiMessageEventMapper } from "@/app/_lib/ai/ui-message-event-mapper";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TerminalRunStatusSchema = z.enum([
  "success",
  "error",
  "skipped",
  "cancelled",
]);
const REDIS_CURSOR_PATTERN = /^\d+-\d+$/;

interface RouteParams {
  params: Promise<{ runId: string }>;
}

export const GET = wrapRouteHandlerWithLogging<RouteParams>(
  { routeId: "ai.runs.ui-stream", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser, routeParams) => {
    if (!routeParams) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const parsed = RunStreamParamsSchema.safeParse(await routeParams.params);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid runId" }, { status: 400 });
    }
    const { runId } = parsed.data;
    const container = getContainer();
    const run = await container.graphRunRepository.getRunByRunId(
      userActor(toUserId(sessionUser.id)),
      runId
    );
    if (!run) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    if (run.requestedBy !== sessionUser.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const terminalStatus = TerminalRunStatusSchema.safeParse(run.status);
    if (terminalStatus.success) {
      ctx.log.info({ runId, status: run.status }, "AI UI stream is terminal");
      return NextResponse.json(
        {
          error: "Run is terminal",
          terminalStatus: terminalStatus.data,
          ...(run.errorCode ? { errorCode: run.errorCode } : {}),
        },
        { status: 410 }
      );
    }

    const headerCursor = request.headers.get("last-event-id");
    const queryCursor = request.nextUrl.searchParams.get("cursor");
    const cursor = headerCursor ?? queryCursor ?? undefined;
    if (cursor !== undefined && !REDIS_CURSOR_PATTERN.test(cursor)) {
      return NextResponse.json({ error: "Invalid stream cursor" }, { status: 400 });
    }

    const textPartId = `run-${runId}`;
    const uiStream = createUIMessageStream({
      execute: async ({ writer }) => {
        const mapper = new UiMessageEventMapper(writer, textPartId);

        const writeCursor = (cursor: string) => {
          writer.write({
            type: "data-run-cursor",
            data: { cursor },
            transient: true,
          } as UIMessageChunk);
        };

        for await (const entry of container.runStream.subscribe(
          runId,
          request.signal,
          cursor
        )) {
          const event = entry.event;
          const mapping = mapper.consume(event);
          if (event.type === "done") {
            mapper.finish(event.finishReason);
            writeCursor(entry.id);
          } else if (mapping !== "buffered") {
            writeCursor(entry.id);
          }
        }
        mapper.close();
      },
    });

    const response = createUIMessageStreamResponse({
      stream: uiStream,
      headers: { "X-Run-Id": runId },
    });
    return new NextResponse(response.body, {
      status: response.status,
      headers: response.headers,
    });
  }
);

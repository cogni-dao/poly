// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Stock 0.13.0 table endpoint. Internal Cogni sandbox permission only. */
import { randomUUID } from "node:crypto";

import { AgentRolesError } from "@cogni/agent-grants";
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/app/(admin)/_lib/admin-session";
import { getContainer } from "@/bootstrap/container";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
// Strict input refuses caller-supplied approver/admin, account, ask or link fields.
const targetSchema = z
  .object({
    principalUserId: z.string().min(1).max(128),
    scope: z.literal("sandbox:exec"),
  })
  .strict();

async function handle(request: Request, operation: "list" | "on" | "off") {
  const started = performance.now();
  // Correlation is minted here, never accepted from a header or request body.
  const reqId = randomUUID();
  let baseLog: ReturnType<typeof makeLogger>;
  try {
    baseLog = getContainer().log;
  } catch {
    // The mint returns the configuration failure below; this logger needs no container.
    baseLog = makeLogger({ routeId: "admin.ai-access" });
  }
  const log = baseLog.child({
    reqId,
    routeId: "admin.ai-access",
    method: request.method,
  });
  let actorUserId: string | null = null;
  let status = 503;
  let errorCode: string | null = "authz_unavailable";
  let reason = "operation_unavailable";
  const respond = (
    body: unknown,
    nextStatus = 200,
    code: string | null = null,
    why = "completed",
  ) => {
    status = nextStatus;
    errorCode = code;
    reason = why;
    const response = json(body, status);
    response.headers.set("x-request-id", reqId);
    return response;
  };
  try {
    const admin = await requireAdminSession(
      request,
      `ai_access.${operation}`,
      log,
    );
    if (!admin.ok) {
      actorUserId = admin.actorUserId;
      status = admin.response.status;
      errorCode =
        status === 401
          ? "unauthorized"
          : status === 403
            ? "authz_denied"
            : "authz_unavailable";
      reason = admin.reason;
      admin.response.headers.set("x-request-id", reqId);
      return admin.response;
    }
    actorUserId = admin.session.userId;
    const port = getContainer().nodeAdminPort;
    if (operation === "list")
      return respond({
        canManage: true,
        ...(await port.listNodeAi(admin.session)),
      });
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      return respond(
        { error: "invalid_input" },
        400,
        "invalid_input",
        "json_required",
      );
    }
    const parsed = targetSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success)
      return respond(
        { error: "invalid_input" },
        400,
        "invalid_input",
        "invalid_target",
      );
    return respond(
      operation === "on"
        ? await port.turnAiPermissionOn(admin.session, parsed.data)
        : await port.turnAiPermissionOff(admin.session, parsed.data),
    );
  } catch (error) {
    if (error instanceof AgentRolesError) {
      const failureStatus =
        error.code === "principal_not_found"
          ? 503
          : error.code === "self_approval" || error.code === "not_allowed"
            ? 403
            : 400;
      return respond(
        { error: error.code },
        failureStatus,
        error.code,
        error.code,
      );
    }
    return respond(
      { error: "authz_unavailable" },
      503,
      "authz_unavailable",
      "operation_unavailable",
    );
  } finally {
    // One terminal event for every exit. Fixed resource only; never serialize the request or exception.
    log.info(
      {
        event: EVENT_NAMES.AI_PERMISSION_COMPLETE,
        reqId,
        routeId: "admin.ai-access",
        actorUserId,
        operation,
        principalSlug: "node-ai",
        scope: "sandbox:exec",
        resource: "node",
        status,
        outcome:
          status < 400
            ? "success"
            : status === 503
              ? "unavailable"
              : status === 400
                ? "invalid"
                : "denied",
        errorCode,
        reason,
        durationMs: Math.max(0, performance.now() - started),
      },
      EVENT_NAMES.AI_PERMISSION_COMPLETE,
    );
  }
}

export const GET = (request: Request) => handle(request, "list");
export const POST = (request: Request) => handle(request, "on");
export const DELETE = (request: Request) => handle(request, "off");

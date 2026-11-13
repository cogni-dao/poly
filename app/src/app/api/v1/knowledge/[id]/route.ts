// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/[id]/route`
 * Purpose: GET /api/v1/knowledge/[id] — fetch a single knowledge entry for the routable
 *   full-page view (the permalink target humans click and AI emits).
 * Scope: Signed-in human, or a bearer agent holding the knowledge:read role (sameDoor `knowledge.read`), mirroring the list route.
 *   Reads via container.knowledgeStorePort.getKnowledge.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, KNOWLEDGE_READ_NEEDS_GRANT.
 * Side-effects: IO (HTTP response, Doltgres read via container port)
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import { KpiBindingsSchema } from "@cogni-dao/metrics/contracts";
import { toKnowledgeRow } from "@cogni/knowledge-store";
import { KnowledgeRowSchema } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.get",
    sameDoor: "knowledge.read",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // A signed-in human reads. A bearer agent needs the knowledge:read role (sameDoor knowledge.read; KNOWLEDGE_READ_NEEDS_GRANT).
    // Merged entries are not open to any registered key;
    // per-principal x402 metering for external readers remains future work.

    const port = getContainer().knowledgeStorePort;
    if (!port) {
      return NextResponse.json(
        { error: "knowledge store not configured" },
        { status: 503 },
      );
    }

    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    const entry = await port.getKnowledge(id);
    if (!entry) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    ctx.log.info({ id }, "knowledge.get_success");

    const goalMetrics = getContainer().goalMetrics;
    const kpiBindings = KpiBindingsSchema.safeParse(entry.kpiBindings ?? []);
    const measured =
      ["goal", "hypothesis"].includes(entry.entryType ?? "") &&
      kpiBindings.success &&
      kpiBindings.data.length > 0 &&
      goalMetrics;
    return NextResponse.json({
      ...KnowledgeRowSchema.parse(toKnowledgeRow(entry)),
      ...(measured
        ? {
            kpis: await goalMetrics.bindings(kpiBindings.data, {
              hypothesis: entry.entryType === "hypothesis",
            }),
          }
        : {}),
    });
  },
);

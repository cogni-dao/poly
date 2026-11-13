// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/route`
 * Purpose: GET /api/v1/knowledge — list knowledge entries across all domains for the human browse UI and external agent recall.
 * Scope: Signed-in human, or a bearer agent holding the knowledge:read role (sameDoor `knowledge.read`). Reads via container.knowledgeStorePort: listDomains then per-domain listKnowledge.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, KNOWLEDGE_READ_NEEDS_GRANT.
 * Side-effects: IO (HTTP response, Doltgres reads via container port)
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import { KnowledgeListQuerySchema } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { loadKnowledgeList } from "@/app/(app)/knowledge/_server/loaders";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "knowledge.list",
    sameDoor: "knowledge.read",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // A signed-in human reads. A bearer agent needs the knowledge:read role (sameDoor knowledge.read; KNOWLEDGE_READ_NEEDS_GRANT).
    // The merged plane is not open to any registered key;
    // per-principal x402 metering for external readers remains future work.

    const port = getContainer().knowledgeStorePort;
    if (!port) {
      return NextResponse.json(
        { error: "knowledge store not configured" },
        { status: 503 }
      );
    }

    const url = new URL(request.url);
    const parsed = KnowledgeListQuerySchema.safeParse({
      domain: url.searchParams.get("domain") ?? undefined,
      sourceType: url.searchParams.get("sourceType") ?? undefined,
      limit: url.searchParams.get("limit")
        ? Number(url.searchParams.get("limit"))
        : undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid query", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const body = await loadKnowledgeList(port, parsed.data);

    ctx.log.info(
      { count: body.items.length, domains: body.domains.length },
      "knowledge.list_success"
    );

    return NextResponse.json(body);
  }
);

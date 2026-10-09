// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/index/route`
 * Purpose: GET /api/v1/knowledge/index — the content-free routing projection, optionally filtered by `?q=` against useWhen.
 * Scope: Any authenticated principal. Reads via container.knowledgeStorePort.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, KNOWLEDGE_READ_REQUIRES_PRINCIPAL, INDEX_CARRIES_NO_CONTENT, Q_MATCHES_USEWHEN_ONLY.
 * Side-effects: IO (HTTP response, Doltgres reads via container port)
 * Links: packages/node-contracts/src/knowledge.index.v1.contract.ts
 * @public
 */

import {
  KnowledgeIndexQuerySchema,
  KnowledgeIndexResponseSchema,
  type KnowledgeIndexRow,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "knowledge.index",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const port = getContainer().knowledgeStorePort;
    if (!port) {
      return NextResponse.json(
        { error: "knowledge store not configured" },
        { status: 503 }
      );
    }

    const url = new URL(request.url);
    const parsed = KnowledgeIndexQuerySchema.safeParse({
      domain: url.searchParams.get("domain") ?? undefined,
      limit: url.searchParams.get("limit")
        ? Number(url.searchParams.get("limit"))
        : undefined,
      q: url.searchParams.get("q") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid query", issues: parsed.error.issues },
        { status: 400 }
      );
    }
    const { domain, limit, q } = parsed.data;

    const allDomains = await port.listDomains();
    const targets = domain
      ? allDomains.filter((candidate) => candidate === domain)
      : allDomains;
    const perDomain = await Promise.all(
      targets.map((target) =>
        port.listKnowledge(target, { limit, ...(q ? { q } : {}) })
      )
    );

    const all = perDomain.flat();
    const items: KnowledgeIndexRow[] = all.slice(0, limit).map((row) => ({
      id: row.id,
      domain: row.domain,
      entryType: row.entryType ?? "finding",
      useWhen: row.useWhen ?? null,
    }));

    return NextResponse.json(
      KnowledgeIndexResponseSchema.parse({
        items,
        domains: allDomains,
        total: all.length,
      })
    );
  }
);

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/register`
 * Purpose: Machine-actor registration endpoint — mints a user row, a billing
 *   account, and a 30-day HMAC-signed API key for agents that can reach the
 *   node without a browser session.
 * Scope: Instrumented via wrapRouteHandlerWithLogging so every attempt hits
 *   the structured log envelope (request received / request complete) and
 *   the http_requests_total / http_request_duration_ms metrics like every
 *   other /api/v1/* route. auth.mode=none because the endpoint is the
 *   onboarding seam itself — callers can't present credentials they haven't
 *   been issued yet. Security hardening (invitation token) tracked in bug.0297.
 *   The name is the text an admin reads on the access table, so a hidden-character name is 400 and a name that matches an
 *   existing user or one of this node's AI is 409 `name_taken`.
 * Links: docs/spec/security-auth.md, bug.0297
 * @public
 */

import { randomUUID } from "node:crypto";
import { hasHiddenCharacters } from "@cogni/agent-grants";
import { users } from "@cogni/db-schema";
import { registerAgentOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.register", auth: { mode: "none" } },
  async (_ctx, request) => {
    const parsed = registerAgentOperation.input.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    // The name is what an admin reads when deciding on this agent's asks. Refuse hidden or direction characters, and any name that
    // matches (case, spacing, look-alike forms) an existing user or one of this node's AI. A concurrent pair can still race
    // (no unique index on users.name by design: humans share names); the admin table marks every outside name and shows
    // the proven binding beside it.
    if (hasHiddenCharacters(parsed.data.name)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const input = { ...parsed.data, name: parsed.data.name.trim().replace(/\s+/g, " ") };
    if (await getContainer().agentAuthority.nameTaken(input.name)) {
      return NextResponse.json({ error: "name_taken" }, { status: 409 });
    }

    const db = resolveServiceDb();
    const id = randomUUID();

    await db.insert(users).values({
      id,
      name: input.name,
      walletAddress: null,
    });

    const container = getContainer();
    const billingAccount =
      await container.serviceAccountService.getOrCreateBillingAccountForUser({
        userId: id,
        displayName: input.name,
      });

    const apiKey = issueAgentApiKey({
      userId: id,
      displayName: input.name,
    });

    return NextResponse.json(
      registerAgentOperation.output.parse({
        userId: id,
        apiKey,
        billingAccountId: billingAccount.id,
      }),
      { status: 201 }
    );
  }
);

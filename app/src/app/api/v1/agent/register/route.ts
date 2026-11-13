// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/register`
 * Purpose: Machine-actor registration endpoint — mints a user row, a billing
 *   account and a key for agents that can reach the node without a browser session.
 *   Two doors. With a `spawnGrant` (issued to a signed-in person on their profile) the agent is LINKED to that person: its principal row stores
 *   the issuer as owner and it gets a revocable key, pending until confirmed (task.5474). Without one the agent registers anonymously, gets a
 *   30-day HMAC-signed key and has NO owner. The anonymous door stays open for now; it is tracked for retirement in bug.0297.
 * Scope: Instrumented via wrapRouteHandlerWithLogging so every attempt hits
 *   the structured log envelope (request received / request complete) and
 *   the http_requests_total / http_request_duration_ms metrics like every
 *   other /api/v1/* route. auth.mode=none because the endpoint is the
 *   onboarding seam itself — callers can't present credentials they haven't
 *   been issued yet. Security hardening (invitation token) tracked in bug.0297.
 *   The name is the text an admin reads on the access table, so a hidden-character name is 400 and a name that matches an
 *   existing user or one of this node's AI is 409 `name_taken`.
 * Invariants:
 *   - OWNER_IS_THE_ISSUER: the owner comes only from the grant. The request cannot name an owner.
 *   - ONE_USE_IDEMPOTENT: a redeemed grant is 409 `spawn_grant_used`, an expired one 410 `spawn_grant_expired`, an unknown or malformed one
 *     403 `invalid_spawn_grant`. A retry of the same redeem (same name) before the agent confirmed its key returns a fresh pending key for the same agent.
 *   - ANONYMOUS_STAYS_OWNERLESS: the anonymous path writes an `external` principal with no owner, so an admin reads "No owner".
 *   - NO_KEY_IN_LOGS: the log lines carry ids and a refusal reason, never a grant or key.
 * Links: docs/spec/security-auth.md, bug.0297, task.5474
 * @public
 */

import { randomUUID } from "node:crypto";
import { hasHiddenCharacters } from "@cogni/agent-grants";
import { CredentialStoreUnavailableError, credentialErrorHttp, redeemSpawnGrant } from "@cogni/agent-grants/credentials";
import { agentPrincipals, users } from "@cogni/db-schema";
import { registerAgentOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import { getAgentSpawnStore } from "@/bootstrap/agent-credentials";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const runtime = "nodejs";

/** Refusals of a spawn grant, each with its status and body. Unknown and malformed are one answer. */
const GRANT_REFUSALS = {
  unknown: [403, "invalid_spawn_grant"],
  expired: [410, "spawn_grant_expired"],
  already_redeemed: [409, "spawn_grant_used"],
  too_many_agents: [409, "too_many_agents"],
  name_taken: [409, "name_taken"],
} as const;

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.register", auth: { mode: "none" } },
  async (ctx, request) => {
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
    const container = getContainer();

    if (input.spawnGrant !== undefined) {
      // Linked door: the owner is the grant's issuer. The key is a pending revocable key; the agent confirms it once.
      try {
        const redeemed = await redeemSpawnGrant(getAgentSpawnStore(), {
          grant: input.spawnGrant,
          name: input.name,
          newUserId: randomUUID(),
          nameTaken: (name) => container.agentAuthority.nameTaken(name),
        });
        if (!redeemed.ok) {
          const [status, error] = GRANT_REFUSALS[redeemed.reason];
          ctx.log.warn(
            { event: EVENT_NAMES.AGENT_SPAWN_GRANT_REFUSED, routeId: "agent.register", reason: redeemed.reason },
            EVENT_NAMES.AGENT_SPAWN_GRANT_REFUSED
          );
          return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
        }
        // Idempotent: a retry finds the account made the first time.
        const billingAccount = await container.serviceAccountService.getOrCreateBillingAccountForUser({
          userId: redeemed.userId,
          displayName: input.name,
        });
        ctx.log.info(
          { event: EVENT_NAMES.AGENT_SPAWN_GRANT_REDEEMED, userId: redeemed.userId, ownerUserId: redeemed.ownerUserId, retry: redeemed.retry },
          EVENT_NAMES.AGENT_SPAWN_GRANT_REDEEMED
        );
        return NextResponse.json(
          registerAgentOperation.output.parse({
            userId: redeemed.userId,
            apiKey: redeemed.apiKey,
            billingAccountId: billingAccount.id,
            keyState: "pending",
          }),
          { status: 201, headers: { "cache-control": "no-store" } }
        );
      } catch (error) {
        const http = credentialErrorHttp(error);
        if (error instanceof CredentialStoreUnavailableError && http) {
          return NextResponse.json(http.body, { status: http.status, headers: { ...http.headers } });
        }
        throw error;
      }
    }

    // Anonymous door (kept for now, bug.0297): works as before, and the agent is marked ownerless.
    if (await container.agentAuthority.nameTaken(input.name)) {
      return NextResponse.json({ error: "name_taken" }, { status: 409 });
    }

    const db = resolveServiceDb();
    const id = randomUUID();

    await db.insert(users).values({
      id,
      name: input.name,
      walletAddress: null,
    });
    await db.insert(agentPrincipals).values({ kind: "external", userId: id, ownerUserId: null });

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

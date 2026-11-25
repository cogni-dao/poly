// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent-access/mine`
 * Purpose: HUMAN plane, session only. A signed-in person lists the AIs that may act on THEIR OWN account (GET), turns one On (POST: an outside AI's ask by its
 *   one-time link token, or this node's own AI directly) and turns one Off or dismisses an ask (DELETE), by clicking on `/profile`.
 * Scope: HTTP validation and the session read. Every decision is the package's one gate (`canApprove`), which asks the database whether the signed-in person owns
 *   the account. The approver and the account are never in the body: the approver is the session, the account is the one that person owns.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header (a bearer agent, an admin with a key) is 403 `human_session_required`, before any read or write.
 *   - ONE_GATE / APPROVER_FOLLOWS_RESOURCE: the account owner alone decides an account row; a node-admin session adds nothing and takes nothing away.
 *   - PROFILE_NEVER_SHOWS_NODE_ROWS: GET returns this person's account rows only.
 *   - SCOPE_KIND_PICKS_THE_PLANE: a direct On names a scope this node declares with kind `account`; any other scope is 400 `invalid_scope` before anything is read or written.
 *   - NON_DISCLOSING: a token that is wrong-kind, used, expired or unknown, and a row on someone else's account, answer `changed: false`, never a reason.
 *   - HUMAN_SURFACE_TOKENLESS: the token travels in the body only (the page read it from the link fragment); the response never carries one.
 * Side-effects: IO (service-role database read and write), logs `agent_role.*`
 * Links: packages/agent-grants (canApprove, approveAccountAsk), https://cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

import { AgentRolesError, type ApprovalCaller } from "@cogni/agent-grants";
import {
  agentMineListOperation,
  agentMineOffOperation,
  agentMineOnOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { refuseNonSession } from "@/app/_lib/auth/human-plane";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

type Person = { ok: true; me: ApprovalCaller } | { ok: false; response: NextResponse };

/** Session only, then the signed-in person. `admin` is always null here: nothing on the profile page takes an admin session. */
async function requirePerson(request: Request, log: { warn: (f: Record<string, unknown>, m: string) => void }): Promise<Person> {
  const refused = refuseNonSession(request, log);
  if (refused) return { ok: false, response: refused };
  const user = await getSessionUser();
  if (!user || user.via !== "session") return { ok: false, response: json({ error: "unauthorized" }, 401) };
  return { ok: true, me: { userId: user.id, admin: null } };
}

function mapError(error: unknown, ctx: { log: { error: (f: Record<string, unknown>, m: string) => void } }, routeId: string): NextResponse {
  if (error instanceof AgentRolesError) {
    // A person who owns no account and a request that names no usable row are the same quiet no. Only a bad shape is a 400.
    if (error.code === "not_allowed") return json({ changed: false });
    if (error.code === "invalid_scope" || error.code === "wrong_kind") return json({ error: error.code }, 400);
    if (error.code === "principal_not_found" || error.code === "not_pending") return json({ error: error.code }, 409);
  }
  // A 503 must never be silent: the failure class (name, SQLSTATE, constraint, table, column), never a message, token or hash.
  ctx.log.error({ event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId, ...failureFields(error) }, EVENT_NAMES.AGENT_ROLES_UNAVAILABLE);
  return json({ error: "authz_unavailable" }, 503);
}

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "agent.mine.list", auth: { mode: "none" } },
  async (ctx, request) => {
    const person = await requirePerson(request, ctx.log);
    if (!person.ok) return person.response;
    try {
      const view = await getContainer().agentAuthority.listMine(person.me.userId);
      return json(agentMineListOperation.output.parse(view));
    } catch (error) {
      return mapError(error, ctx, "agent.mine.list");
    }
  }
);

/** Turn a row On: an outside AI's ask by its token, or this node's own AI directly. The grant has no end date: it lasts until Off. */
export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.mine.on", auth: { mode: "none" } },
  async (ctx, request) => {
    const person = await requirePerson(request, ctx.log);
    if (!person.ok) return person.response;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = agentMineOnOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "invalid input", issues: parsed.error.issues }, 400);
    // The scope must be one this node declares with kind `account` (SCOPE_KIND_PICKS_THE_PLANE): a node scope is an admin's, never written from the profile.
    const authority = getContainer().agentAuthority;
    if (parsed.data.scope !== undefined && authority.scopeKinds[parsed.data.scope] !== "account")
      return json({ error: "invalid_scope" }, 400);
    try {
      const input =
        parsed.data.token !== undefined
          ? { token: parsed.data.token, accountId: parsed.data.accountId }
          : {
              principalUserId: parsed.data.principalUserId as string,
              scope: parsed.data.scope as string,
            };
      const result = await authority.turnMineOn(person.me, input);
      return json(agentMineOnOperation.output.parse(result));
    } catch (error) {
      return mapError(error, ctx, "agent.mine.on");
    }
  }
);

/** Turn a row Off by id, or dismiss a waiting ask (`deny: true` with its token). */
export const DELETE = wrapRouteHandlerWithLogging(
  { routeId: "agent.mine.off", auth: { mode: "none" } },
  async (ctx, request) => {
    const person = await requirePerson(request, ctx.log);
    if (!person.ok) return person.response;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = agentMineOffOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "invalid input", issues: parsed.error.issues }, 400);
    try {
      const result = await getContainer().agentAuthority.turnMineOff(
        person.me,
        parsed.data.rowId !== undefined
          ? { rowId: parsed.data.rowId }
          : { token: parsed.data.token as string, accountId: parsed.data.accountId }
      );
      return json(agentMineOffOperation.output.parse(result));
    } catch (error) {
      return mapError(error, ctx, "agent.mine.off");
    }
  }
);

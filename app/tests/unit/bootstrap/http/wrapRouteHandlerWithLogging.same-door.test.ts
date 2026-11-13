// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/http/wrapRouteHandlerWithLogging.same-door`
 * Purpose: SAME_DOOR at the wrapper seam. Drives the REAL `wrapRouteHandlerWithLogging` `sameDoor` block and the REAL
 *   `createAgentToolAuthority.authorizeRoute` (only the SQL tag and the logger are fakes). Deleting the block or
 *   `authorizeRoute` fails these tests.
 * Scope: bearer, session and unknown identity; role present, absent, store outage; the logged route id.
 * Invariants: SAME_DOOR, FAIL_CLOSED_NON_DISCLOSING, a bearer is its own principal and a human needs no role row.
 * Side-effects: none
 */

import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import type { SessionUser } from "@cogni/node-shared";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AgentAuthoritySql,
  createAgentToolAuthority,
} from "@/bootstrap/agent-authority";

const fake = vi.hoisted(() => ({
  container: undefined as unknown,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => fake.container,
}));

import { wrapRouteHandlerWithLogging } from "@/bootstrap/http/wrapRouteHandlerWithLogging";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
log.child.mockReturnValue(log);

/** A tagged template that answers the role queries from a set. `begin` hands back the same tag. */
function fakeSql(state: { roles: Set<string>; down: boolean; queries: number }): AgentAuthoritySql {
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    state.queries += 1;
    if (state.down) throw new Error("db down");
    const text = strings.join("?");
    if (text.includes("FROM agent_roles"))
      return state.roles.has(`${values[0]}|${values[1]}`) ? [{ ok: 1 }] : [];
    return [];
  }) as unknown as AgentAuthoritySql;
  (tag as unknown as { begin: unknown }).begin = async (fn: (t: unknown) => Promise<unknown>) => fn(tag);
  return tag;
}

const handler = vi.fn(async () => NextResponse.json({ ran: true }));
const AGENT = "agent-user-1";
const state = { roles: new Set<string>(), down: false, queries: 0 };

function route(sameDoor: string, user: SessionUser | null) {
  return wrapRouteHandlerWithLogging(
    {
      routeId: "work.items.patch",
      sameDoor,
      auth: { mode: "required", getSessionUser: async () => user },
    },
    handler
  );
}
const call = (sameDoor: string, user: SessionUser | null) =>
  route(sameDoor, user)(new NextRequest("https://node.example/api/v1/x", { method: "PATCH" }));
const user = (via: SessionUser["via"], id = AGENT): SessionUser => ({
  id, walletAddress: null, displayName: null, avatarColor: null, ...(via ? { via } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  log.child.mockReturnValue(log);
  state.roles = new Set();
  state.down = false;
  state.queries = 0;
  fake.container = {
    log,
    config: { unhandledErrorPolicy: "respond_500" },
    clock: { now: () => new Date("2026-11-09T00:00:00Z").toISOString() },
    agentAuthority: createAgentToolAuthority({
      sql: fakeSql(state),
      nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
      log: log as never,
      toolBundle: CORE_TOOL_BUNDLE as never,
    }),
  };
});

describe("the route door (real wrapper, real authorizeRoute)", () => {
  it("a bearer with no role row gets 403 policy_denied and the handler never runs", async () => {
    const res = await call("core__work_item_transition", user("bearer"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "policy_denied", code: "policy_denied" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("a bearer with a live role row for the scope reaches the handler", async () => {
    state.roles.add(`${AGENT}|work_item:transition`);
    const res = await call("core__work_item_transition", user("bearer"));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a role for one scope opens no other route", async () => {
    state.roles.add(`${AGENT}|work_item:transition`);
    expect((await call("core__edo_decide", user("bearer"))).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a store outage is 503 authz_unavailable, never an allow", async () => {
    state.down = true;
    const res = await call("core__work_item_transition", user("bearer"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authz_unavailable", code: "authz_unavailable" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("a human session reaches the handler with no role row and no store read (subjects, not principals)", async () => {
    const res = await call("core__work_item_transition", user("session", "human-1"));
    expect(res.status).toBe(200);
    expect(state.queries).toBe(0);
  });

  it("an identity with no `via` takes the strict bearer branch (fail closed)", async () => {
    const res = await call("core__work_item_transition", user(undefined));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    state.roles.add(`${AGENT}|work_item:transition`);
    expect((await call("core__work_item_transition", user(undefined))).status).toBe(200); // strict means "needs a role", not "denied"
  });

  it("a route that names an unknown capability is denied for a bearer, and so is a missing door dependency", async () => {
    expect((await call("core__no_such_tool", user("bearer"))).status).toBe(403);
    fake.container = { ...(fake.container as object), agentAuthority: undefined };
    expect((await call("core__work_item_transition", user("bearer"))).status).toBe(500); // never an allow
    expect(handler).not.toHaveBeenCalled();
  });

  it("the route-only knowledge.contribute scope: a human passes, a bearer needs the knowledge:contribute row", async () => {
    expect((await call("knowledge.contribute", user("session", "human-1"))).status).toBe(200);
    expect((await call("knowledge.contribute", user("bearer"))).status).toBe(403);
    state.roles.add(`${AGENT}|knowledge:contribute`);
    expect((await call("knowledge.contribute", user("bearer"))).status).toBe(200);
  });

  it("the route-only knowledge.read scope: a human reads, a bearer needs the knowledge:read row, and the ask for it is accepted", async () => {
    expect((await call("knowledge.read", user("session", "human-1"))).status).toBe(200);
    const denied = await call("knowledge.read", user("bearer"));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "policy_denied", code: "policy_denied" });
    state.roles.add(`${AGENT}|knowledge:contribute`);
    expect((await call("knowledge.read", user("bearer"))).status).toBe(403); // another scope opens nothing here
    state.roles.add(`${AGENT}|knowledge:read`);
    expect((await call("knowledge.read", user("bearer"))).status).toBe(200);
    const authority = (fake.container as { agentAuthority: ReturnType<typeof createAgentToolAuthority> }).agentAuthority;
    expect(authority.declaredScopes).toContain("knowledge:read");
    await expect(authority.requestAccess({ principalUserId: "asker", scope: "knowledge:read" })).resolves.toMatchObject({ state: "pending" });
  });

  it("logs agent_tool.authz with the route id, the principal (bearer) or the subject (human), and no secret", async () => {
    await call("core__work_item_transition", user("bearer"));
    await call("core__work_item_transition", user("session", "human-1"));
    const lines = [...log.warn.mock.calls, ...log.info.mock.calls]
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((f) => f.event === "agent_tool.authz");
    expect(lines).toEqual([
      expect.objectContaining({ route: "work.items.patch", tool: "core__work_item_transition", principal: AGENT, subject: null, decision: "deny", code: "policy_denied", reason: "no_role" }),
      expect.objectContaining({ route: "work.items.patch", principal: null, subject: "human-1", decision: "allow", reason: "signed_in" }),
    ]);
  });

  it("a route with no sameDoor option is untouched (the door is opt-in per route)", async () => {
    const res = await wrapRouteHandlerWithLogging(
      { routeId: "plain", auth: { mode: "required", getSessionUser: async () => user("bearer") } },
      handler
    )(new NextRequest("https://node.example/api/v1/x", { method: "PATCH" }));
    expect(res.status).toBe(200);
    expect(state.queries).toBe(0);
  });
});

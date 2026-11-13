// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyright: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-access-requests.int.test`
 * Purpose: REQUEST = OFF ROW (task.5466 first slice), against real Postgres through the real route handlers:
 *   an outside bearer asks for a scope (a pending row), the admin sees the ask and flips it ON, the bearer's door opens,
 *   the admin flips it OFF and the door closes. Also: the AI plane is bearer-only, the human plane is session-only,
 *   a pending row opens no lock, asks are idempotent, scope-checked and capped, and a deny is seen by the agent.
 * Scope: Real `agent.access.requests` and `agent-access.roles` handlers, real wrapper, real `agent-authority`, real repo-spec
 *   admin. Only the NextAuth/bearer identity decode is replaced (`getSessionUser`).
 * Invariants: NO_SELF_APPROVAL (an ask never approves itself), HUMAN_ROUTES_SESSION_ONLY, KIND_PICKS_THE_PLANE.
 * Side-effects: IO (testcontainers or local Postgres)
 */

import { randomUUID } from "node:crypto";
import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import { MAX_PENDING_PER_AGENT, MAX_PENDING_TOTAL } from "@cogni/agent-grants";
import { NextRequest } from "next/server";
import pino from "pino";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => session.user),
}));
const holder = vi.hoisted(() => ({ container: null as unknown }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => holder.container,
}));

import { GET as askList, POST as askCreate } from "@/app/api/v1/agent/access-requests/route";
import { DELETE as rolesDelete, GET as rolesGet, POST as rolesPost } from "@/app/api/v1/admin/ai-access/route";
import {
  type AgentAuthoritySql,
  createAgentToolAuthority,
  MAX_ADMIN_OUTSIDE_ROWS,
} from "@/bootstrap/agent-authority";
import { createNodeAdminPort } from "@/bootstrap/node-admin-port";
// A wallet of its own, so this file never fights another component file for the repo-spec approver's unique wallet binding.
const ADMIN_WALLET = `0x${randomUUID().replaceAll("-", "").padEnd(40, "a").slice(0, 40)}`;
const SCOPE = "work_item:transition";

describe("access requests: an ask is an off row (real Postgres)", () => {
  let service: Sql;
  const users: string[] = [];
  let admin: string;
  let agent: string;
  let other: string;
  let authority: ReturnType<typeof createAgentToolAuthority>;
  const lines: Array<Record<string, unknown>> = [];

  const mkUser = async (name: string, wallet?: string) => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${name})`;
    if (wallet)
      await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${id}, 'wallet', ${wallet})`;
    users.push(id);
    return id;
  };
  const as = (id: string | null, via: "bearer" | "session") =>
    (session.user = id ? { id, walletAddress: id === admin ? ADMIN_WALLET : null, displayName: null, avatarColor: null, via } : null);
  const ask = (scope: unknown, headers: Record<string, string> = {}) =>
    askCreate(
      new NextRequest("http://localhost/api/v1/agent/access-requests", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ scope }),
      }),
      undefined as never
    );
  const mine = () => askList(new NextRequest("http://localhost/api/v1/agent/access-requests"), undefined as never);
  const roles = (handler: typeof rolesPost, body: unknown) =>
    handler(
      new NextRequest("http://localhost/api/v1/admin/ai-access", {
        method: handler === rolesPost ? "POST" : "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      undefined as never
    );
  const door = (userId: string) => authority.authorizeRoute({ toolId: "core__work_item_transition", routeId: "work.items.patch", userId, via: "bearer" });
  const adminViewFull = async () => {
    as(admin, "session");
    return (await (await rolesGet(new NextRequest("http://localhost/api/v1/admin/ai-access"), undefined as never)).json()) as {
      more: number;
      permissions: Array<{ section: string }>;
    };
  };
  const adminView = async () => {
    as(admin, "session");
    return (await (await rolesGet(new NextRequest("http://localhost/api/v1/admin/ai-access"), undefined as never)).json()) as {
      permissions: Array<{ section: string; principalUserId: string; who: string; outside: boolean; scope: string; on: boolean; hint: string | null }>;
    };
  };

  beforeAll(async () => {
    service = postgres(process.env.DATABASE_SERVICE_URL as string, { max: 4 });
    admin = await mkUser("req-admin", ADMIN_WALLET);
    agent = await mkUser("Helper bot");
    other = await mkUser("Other bot");
    await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${agent}, 'github', ${`gh-${randomUUID()}`})`;
    const logger = pino({ level: "info", timestamp: false }, { write: (c: string) => void lines.push(JSON.parse(c)) });
    const nodeAdmin = {
      check: async (who: { walletAddress?: string | null }) =>
        who.walletAddress === ADMIN_WALLET ? { ok: true as const } : { ok: false as const, errorCode: "authz_denied" as const },
    };
    authority = createAgentToolAuthority({
      sql: service as unknown as AgentAuthoritySql,
      nodeAdmin,
      log: logger,
      toolBundle: [...CORE_TOOL_BUNDLE],
    });
    holder.container = { log: logger, config: { unhandledErrorPolicy: "rethrow" }, agentAuthority: authority, nodeAdmin, nodeAdminPort: createNodeAdminPort(authority) };
  });
  afterAll(async () => {
    await service?.unsafe("DELETE FROM agent_roles WHERE principal_user_id = ANY($1) OR approved_by = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM user_bindings WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [users]);
    await service?.end({ timeout: 1 });
  });

  it("the whole loop: ask -> pending row, closed door -> admin sees it and flips ON -> door opens -> flips OFF -> door closes", async () => {
    as(agent, "bearer");
    const first = await ask(SCOPE);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ scope: SCOPE, state: "pending", created: true });
    const row = (await service`SELECT approved_by, granted_at, requested_by, revoked_at FROM agent_roles WHERE principal_user_id = ${agent}`)[0];
    expect(row).toMatchObject({ approved_by: null, granted_at: null, requested_by: agent, revoked_at: null }); // an OFF row

    expect(await door(agent)).toMatchObject({ decision: "deny", reason: "no_role" }); // a pending ask opens nothing

    const pending = (await adminView()).permissions.filter((r) => r.section === "pending" && r.principalUserId === agent);
    expect(pending).toEqual([expect.objectContaining({ who: "Helper bot", outside: true, scope: SCOPE, on: false, hint: expect.stringMatching(/^GitHub id gh-/), principalUserId: agent })]);

    const approve = await roles(rolesPost, { principalUserId: agent, scope: SCOPE });
    expect(approve.status).toBe(200);
    expect(await approve.json()).toMatchObject({ principalUserId: agent, changed: true });
    const live = (await service`SELECT approved_by, granted_at FROM agent_roles WHERE principal_user_id = ${agent} AND revoked_at IS NULL`)[0];
    expect(live?.approved_by).toBe(admin);
    expect(live?.granted_at).not.toBeNull();
    expect(await door(agent)).toMatchObject({ decision: "allow", basis: "role" });
    const outside = (await adminView()).permissions.filter((r) => r.section === "outside" && r.principalUserId === agent);
    expect(outside).toEqual([expect.objectContaining({ who: "Helper bot", on: true, scope: SCOPE })]);

    as(agent, "bearer");
    expect((await (await mine()).json()).requests).toEqual([expect.objectContaining({ scope: SCOPE, state: "granted" })]);

    as(admin, "session");
    const off = await roles(rolesDelete, { principalUserId: agent, scope: SCOPE });
    expect(await off.json()).toMatchObject({ changed: true });
    expect(await door(agent)).toMatchObject({ decision: "deny", reason: "no_role" });
    as(agent, "bearer");
    expect((await (await mine()).json()).requests).toEqual([expect.objectContaining({ scope: SCOPE, state: "revoked" })]);

    expect(lines.map((l) => l.event).filter((e) => String(e).startsWith("agent_role."))).toEqual(["agent_role.requested", "agent_role.granted", "agent_role.revoked"]);
    expect(JSON.stringify(lines)).not.toMatch(/Bearer|cogni_ag_sk|AUTH_SECRET/);
  });

  it("an ask is idempotent, scope-checked, and capped; a denied ask shows as denied and can be asked again", async () => {
    as(other, "bearer");
    expect((await ask("knowledge:contribute")).status).toBe(201);
    const again = await ask("knowledge:contribute");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ state: "pending", created: false });
    expect((await service`SELECT 1 FROM agent_roles WHERE principal_user_id = ${other}`)).toHaveLength(1);

    const bad = await ask("made:up");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_scope" });
    expect((await ask(42)).status).toBe(400);
    expect((await askCreate(new NextRequest("http://localhost/x", { method: "POST", body: "{" }), undefined as never)).status).toBe(400);

    // the admin dismisses it (the x)
    as(admin, "session");
    const denied = await roles(rolesDelete, { principalUserId: other, scope: "knowledge:contribute", deny: true });
    expect(await denied.json()).toMatchObject({ changed: true });
    expect(await door(other)).toMatchObject({ decision: "deny" });
    as(other, "bearer");
    expect((await (await mine()).json()).requests).toEqual([expect.objectContaining({ scope: "knowledge:contribute", state: "denied" })]);
    expect((await ask("knowledge:contribute")).status).toBe(201); // asked again after a deny
  });

  it("the per-agent cap fires through the real route with only declared, askable scopes", async () => {
    const capped = await mkUser("Capped bot");
    as(capped, "bearer");
    const askable = ["work_item:transition", "schedule:manage", "edo:write", "metric:compute", "knowledge:contribute"];
    for (const scope of askable.slice(0, MAX_PENDING_PER_AGENT)) expect((await ask(scope)).status).toBe(201);
    const res = await ask(askable[MAX_PENDING_PER_AGENT] as string);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too_many_requests" });
    expect((await ask(askable[0] as string)).status).toBe(200); // an ask it already holds is still reported, not refused
  });

  it("the global pending cap stops a flood from throwaway agents, and clearing room lets the next ask in", async () => {
    const fillers: string[] = [];
    // The cap is global by design and other component files share this database, so re-read the global pending count each pass
    // (a one-shot snapshot goes stale if another file adds or clears pending asks) and fill until the cap is actually reached.
    const pending = async () =>
      ((await service`SELECT count(*)::int AS n FROM agent_roles WHERE approved_by IS NULL AND revoked_at IS NULL`) as unknown as [{ n: number }])[0].n;
    try {
      for (let i = 0; (await pending()) < MAX_PENDING_TOTAL; i++) {
        const id = await mkUser(`flood-${i}-${randomUUID().slice(0, 4)}`);
        fillers.push(id);
        await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, requested_by) VALUES (${id}, 'edo:write', NULL, ${id})`;
      }
      const late = await mkUser("Late bot");
      as(late, "bearer");
      const res = await ask("edo:write");
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "too_many_requests" });
      expect((await service`SELECT 1 FROM agent_roles WHERE principal_user_id = ${late}`)).toHaveLength(0);
      // the admin dismisses one ask: there is room again
      if (fillers[0]) {
        as(admin, "session");
        expect((await roles(rolesDelete, { principalUserId: fillers[0], scope: "edo:write", deny: true })).status).toBe(200);
        as(late, "bearer");
        expect((await ask("edo:write")).status).toBe(201);
      }
    } finally {
      await service`DELETE FROM agent_roles WHERE principal_user_id = ANY(${fillers})`;
    }
  });

  it("an ask for a scope with no door an outside agent can call is 400 no_external_door, and nothing is written", async () => {
    const quiet = await mkUser("Door bot");
    as(quiet, "bearer");
    // knowledge:write is declared (a core tool) but only the tool can use it: no route twin. (The vcs scopes are not declared in this bundle.)
    for (const scope of ["knowledge:write"]) {
      const res = await ask(scope);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "no_external_door" });
    }
    expect((await service`SELECT 1 FROM agent_roles WHERE principal_user_id = ${quiet}`)).toHaveLength(0);
  });

  it("the admin read is bounded: this node's AI in full, outside rows capped with a count of the rest", async () => {
    const seeded: string[] = [];
    try {
      for (let i = 0; i < MAX_ADMIN_OUTSIDE_ROWS + 3; i++) {
        const id = await mkUser(`row-${i}-${randomUUID().slice(0, 4)}`);
        seeded.push(id);
        await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at) VALUES (${id}, 'edo:write', ${admin}, now())`;
      }
      const view = await adminViewFull();
      expect(view.permissions.filter((r) => r.section !== "node")).toHaveLength(MAX_ADMIN_OUTSIDE_ROWS);
      expect(view.more).toBeGreaterThanOrEqual(3);
      expect(view.permissions.filter((r) => r.section === "node").length).toBeGreaterThan(0); // this node's AI is never cut
    } finally {
      await service`DELETE FROM agent_roles WHERE principal_user_id = ANY(${seeded})`;
    }
  });

  it("AI plane is bearer-only: a browser session gets 404 on POST and GET and nothing is written", async () => {
    // Other component files share this database, so count only this test's own principals.
    const own = () => service`SELECT count(*)::int AS n FROM agent_roles WHERE principal_user_id IN (${admin}, ${agent}) AND revoked_at IS NULL AND scope = ${SCOPE}`;
    const before = (await own())[0]?.n;
    as(admin, "session");
    expect((await ask(SCOPE)).status).toBe(404);
    expect((await mine()).status).toBe(404);
    session.user = { id: agent, walletAddress: null, displayName: null, avatarColor: null }; // no `via` is not a verified bearer
    expect((await ask(SCOPE)).status).toBe(404);
    expect((await own())[0]?.n).toBe(before);
  });

  it("human plane is session-only: an Authorization header gets 403 human_session_required, and a non-admin cannot approve", async () => {
    as(agent, "bearer");
    await service`DELETE FROM agent_roles WHERE principal_user_id = ${agent}`;
    await ask(SCOPE);
    for (const handler of [rolesPost, rolesDelete]) {
      const res = await handler(
        new NextRequest("http://localhost/api/v1/admin/ai-access", {
          method: handler === rolesPost ? "POST" : "DELETE",
          headers: { "content-type": "application/json", authorization: "Bearer cogni_ag_sk_v1_x" },
          body: JSON.stringify({ principalUserId: agent, scope: SCOPE }),
        }),
        undefined as never
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "human_session_required" });
    }
    // NO_SELF_APPROVAL: the asking agent, even as a signed-in non-admin session, cannot approve its own ask.
    as(agent, "session");
    expect((await roles(rolesPost, { principalUserId: agent, scope: SCOPE })).status).toBe(403);
    expect(await door(agent)).toMatchObject({ decision: "deny", reason: "no_role" });
  });

  it("approving a scope nobody asked for, for an outside agent, is 409; a bad body is 400", async () => {
    as(admin, "session");
    const none = await mkUser("Quiet bot");
    const res = await roles(rolesPost, { principalUserId: none, scope: SCOPE });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_pending" });
    expect((await roles(rolesPost, { scope: SCOPE })).status).toBe(400);
    expect((await roles(rolesPost, { principal: "node-ai", principalUserId: none, scope: SCOPE })).status).toBe(400);
  });
});

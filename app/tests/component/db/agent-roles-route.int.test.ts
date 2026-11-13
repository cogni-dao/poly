// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-roles-route.int.test`
 * Purpose: GET/POST/DELETE /api/v1/admin/ai-access (the admin area, through requireAdminSession and NodeAdminPort) and the guard it controls, against real Postgres
 *   (task.5456, V8 V9): any Authorization header 403 human_session_required, non-admin 403, 503 when no
 *   admins are configured, GET shows the live Allow state after grant and after revoke, admin grant allows the next tool call, admin revoke denies it, and the log lines.
 * Scope: The real route handlers, real wrapRouteHandlerWithLogging, real `agent-authority` wiring, real repo-spec
 *   node admin authority and a real database. Only the NextAuth session decode is replaced (`getSessionUser`).
 * Invariants:
 *   - ADMIN_ONLY_FROM_DAO: the admin is the repo-spec approver wallet bound in `user_bindings`.
 *   - NO_SECRETS_IN_LOGS: captured `agent_tool.authz` / `agent_role.*` lines hold ids and decisions only.
 * Side-effects: IO (testcontainers or local Postgres)
 */

import { randomUUID } from "node:crypto";
import { guardTools } from "@cogni/agent-grants";
import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import { NODE_AI_PRINCIPAL_USER_ID, PRIORITIZER_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import postgres, { type Sql } from "postgres";
import pino from "pino";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const logLines: Array<Record<string, unknown>> = [];
const logger = pino(
  { level: "info", timestamp: false },
  {
    write(chunk: string) {
      logLines.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  }
);

const session = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => session.user),
}));

const holder = vi.hoisted(() => ({ container: null as unknown }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => holder.container,
}));

import { DELETE, GET, POST } from "@/app/api/v1/admin/ai-access/route";
import {
  type AgentAuthoritySql,
  createAgentToolAuthority,
} from "@/bootstrap/agent-authority";
import { createApproversNodeAdminAuthority } from "@/bootstrap/node-admin-gate";
import { createNodeAdminPort } from "@/bootstrap/node-admin-port";

// The repo-spec approver (`activity_ledger.approvers[0]`) is this node's DAO admin.
const ADMIN_WALLET = "0x070075F1389Ae1182aBac722B36CA12285d0c949";
const url2 = "http://localhost/api/v1/admin/ai-access";
const call = (handler: typeof POST, body: unknown, headers: Record<string, string> = {}) =>
  handler(
    new NextRequest(url2, {
      method: handler === POST ? "POST" : "DELETE",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    undefined as never
  );
const getView = (headers: Record<string, string> = {}) =>
  GET(new NextRequest(url2, { method: "GET", headers }), undefined as never);

describe("agent roles route (real Postgres, real repo-spec admin)", () => {
  let service: Sql;
  const users: string[] = [];
  let adminUser: string;
  let memberUser: string;
  let agentUser: string;
  let authority: ReturnType<typeof createAgentToolAuthority>;

  const mkUser = async (wallet?: string) => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${`rt-${id.slice(0, 6)}`})`;
    if (wallet)
      await service`INSERT INTO user_bindings (id, user_id, provider, external_id)
        VALUES (${randomUUID()}, ${id}, 'wallet', ${wallet})`;
    users.push(id);
    return id;
  };
  const wallets = new Map<string, string>();
  const sessionUser = (id: string, via: "session" | "bearer") => ({
    id,
    walletAddress: wallets.get(id) ?? null,
    displayName: null,
    avatarColor: null,
    via,
  });

  // The guard as the provider builds it, around a tool that reports whether it ran.
  const callTool = async (principalId: string | undefined, subjectUserId?: string) => {
    const tool = CORE_TOOL_BUNDLE.find((t) => t.contract.name === "core__work_item_transition")!;
    const guarded = guardTools(
      { [tool.contract.name]: { id: tool.contract.name, effect: tool.contract.effect, exec: async () => "ran" } } as never,
      { [tool.contract.name]: tool.contract.requires! },
      { principalId, subjectUserId, payer: "payer-route-test" },
      authority.guardDeps
    );
    return (guarded[tool.contract.name]!.exec as (a: unknown, c: unknown, k: unknown) => Promise<unknown>)({}, { runId: "run-route" }, {});
  };

  beforeAll(async () => {
    service = postgres(process.env.DATABASE_SERVICE_URL as string, { max: 4 });
    // The wallet of the repo-spec approver may already be bound by another test run; use a fresh binding row per run.
    await service`DELETE FROM user_bindings WHERE provider = 'wallet' AND external_id = ${ADMIN_WALLET}`;
    adminUser = await mkUser(ADMIN_WALLET);
    memberUser = await mkUser(`0x${"5e".repeat(20)}`);
    // The Admin area's mint asks the node-admin check with the session wallet.
    wallets.set(adminUser, ADMIN_WALLET);
    wallets.set(memberUser, `0x${"5e".repeat(20)}`);
    agentUser = await mkUser();
    authority = createAgentToolAuthority({
      sql: service as unknown as AgentAuthoritySql,
      nodeAdmin: createApproversNodeAdminAuthority(),
      log: logger,
      toolBundle: [...CORE_TOOL_BUNDLE],
    });
    holder.container = {
      log: logger,
      config: { unhandledErrorPolicy: "rethrow" },
      agentAuthority: authority,
      nodeAdmin: createApproversNodeAdminAuthority(),
      nodeAdminPort: createNodeAdminPort(authority),
    };
  });

  beforeEach(() => {
    logLines.length = 0;
  });

  afterAll(async () => {
    await service?.unsafe("DELETE FROM agent_roles WHERE approved_by = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM user_bindings WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [users]);
    await service?.end({ timeout: 1 });
  });

  const body = { principal: "prioritizer", scope: "work_item:transition" };

  it("HEADER-REFUSED: any Authorization header on a human route is 403 human_session_required, even for the admin's own session", async () => {
    for (const user of [sessionUser(agentUser, "bearer"), sessionUser(adminUser, "bearer"), sessionUser(adminUser, "session"), null]) {
      session.user = user;
      for (const res of [
        await call(POST, body, { authorization: "Bearer cogni_ag_sk_v1_x" }),
        await call(DELETE, body, { authorization: "Bearer cogni_ag_sk_v1_x" }),
        await getView({ authorization: "Bearer cogni_ag_sk_v1_x" }),
        await getView({ authorization: "Basic nope" }),
      ]) {
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: "human_session_required" });
      }
    }
    const rows = await service`SELECT 1 FROM agent_roles WHERE principal_user_id = ${PRIORITIZER_PRINCIPAL_USER_ID} AND revoked_at IS NULL`;
    expect(rows).toHaveLength(0);
  });

  it("NON-ADMIN-SEES-NOTHING: GET and POST are 403 authz_denied and carry no AI", async () => {
    session.user = sessionUser(memberUser, "session");
    const res = await getView();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "authz_denied" });
    expect((await call(POST, body)).status).toBe(403);
    session.user = null;
    expect((await getView()).status).toBe(401);
  });

  it("GET lists one row per grant row with name and description from the declaration, and the live state, for an admin", async () => {
    session.user = sessionUser(adminUser, "session");
    type Row = { section: string; principalUserId: string; who: string; outside: boolean; scope: string; label: string; description: string; on: boolean; until: string | null };
    const before = (await (await getView()).json()) as { canManage: boolean; permissions: Row[] };
    expect(before.canManage).toBe(true);
    const mine = before.permissions.filter((r) => r.section === "node");
    // Poly's node AI is `node-ai` (the graphs it runs); its rows are the write scopes of the tools those graphs list.
    expect([...new Set(mine.map((r) => r.who))].sort()).toEqual(["node-ai"]);
    const aiBody = { principal: "node-ai", scope: "schedule:manage" };
    const scheduler = mine.filter((r) => r.scope === "schedule:manage");
    expect(scheduler).toEqual([expect.objectContaining({ scope: "schedule:manage", on: false, until: null, principalUserId: NODE_AI_PRINCIPAL_USER_ID })]);
    expect(scheduler[0]?.label.length).toBeGreaterThan(5);
    expect(scheduler[0]?.description.length).toBeGreaterThan(15);
    expect(JSON.stringify(mine)).not.toMatch(/\bjobs?\b|risk|blurb/i);
    expect((await call(POST, aiBody)).status).toBe(200);
    const after = (await (await getView()).json()) as typeof before;
    expect(after.permissions.find((r) => r.principalUserId === NODE_AI_PRINCIPAL_USER_ID && r.scope === "schedule:manage")?.on).toBe(true);
    expect((await call(DELETE, aiBody)).status).toBe(200);
    const removed = (await (await getView()).json()) as typeof before;
    expect(removed.permissions.find((r) => r.principalUserId === NODE_AI_PRINCIPAL_USER_ID && r.scope === "schedule:manage")?.on).toBe(false);
    expect((await getView()).headers.get("cache-control")).toBe("no-store");
  });

  it("503: no configured admins gives authz_unavailable on GET and POST, never a plain deny", async () => {
    const real = holder.container as Record<string, unknown>;
    const nodeAdmin = { check: async () => ({ ok: false, errorCode: "authz_unavailable", reason: "no_node_admins_configured" }) };
    holder.container = { ...real, nodeAdmin };
    try {
      session.user = sessionUser(adminUser, "session");
      expect((await getView()).status).toBe(503);
      expect((await call(POST, body)).status).toBe(503);
    } finally {
      holder.container = real;
    }
  });

  it("V8: no session is 401", async () => {
    session.user = null;
    expect((await call(POST, body)).status).toBe(401);
  });

  it("V8: a signed-in non-admin gets 403 on grant and revoke, and nothing is written", async () => {
    session.user = sessionUser(memberUser, "session");
    // Other component files share this database, so compare with the state before, not with zero.
    const live = () => service`SELECT 1 FROM agent_roles WHERE principal_user_id = ${PRIORITIZER_PRINCIPAL_USER_ID} AND revoked_at IS NULL`;
    const before = await live();
    expect((await call(POST, body)).status).toBe(403);
    expect((await call(DELETE, body)).status).toBe(403);
    expect(await live()).toHaveLength(before.length);
  });

  it("V8: a bearer identity is not a session: the mint refuses it, and nothing is written", async () => {
    session.user = sessionUser(agentUser, "bearer");
    expect((await call(POST, body)).status).toBe(401);
    expect((await call(DELETE, body)).status).toBe(401);
    const rows = await service`SELECT 1 FROM agent_roles WHERE principal_user_id = ${PRIORITIZER_PRINCIPAL_USER_ID} AND revoked_at IS NULL`;
    expect(rows).toHaveLength(0);
  });

  it("V8: admin validation errors", async () => {
    session.user = sessionUser(adminUser, "session");
    expect((await call(POST, { principal: "prioritizer", scope: "made:up" })).status).toBe(400);
    expect((await call(POST, { principal: "ghost", scope: "work_item:transition" })).status).toBe(404);
    expect((await call(POST, { principal: "" })).status).toBe(400);
  });

  it("V8 + V9: admin grant allows the next call; admin revoke denies it; every decision is logged", async () => {
    // Before: no role row, the guarded call is denied.
    await expect(callTool(PRIORITIZER_PRINCIPAL_USER_ID)).rejects.toMatchObject({ receipt: { code: "policy_denied" } });

    session.user = sessionUser(adminUser, "session");
    const granted = await call(POST, body);
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({ ...body, principalUserId: PRIORITIZER_PRINCIPAL_USER_ID, changed: true });
    await expect(callTool(PRIORITIZER_PRINCIPAL_USER_ID)).resolves.toBe("ran");

    const revoked = await call(DELETE, body);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ changed: true });
    await expect(callTool(PRIORITIZER_PRINCIPAL_USER_ID)).rejects.toMatchObject({ receipt: { code: "policy_denied", retryable: false } });

    // V9: the log lines (real pino JSON from the real code path).
    const authz = logLines.filter((l) => l.event === "agent_tool.authz");
    expect(authz.map((l) => `${l.decision}/${l.code}`)).toEqual(["deny/policy_denied", "allow/allowed", "deny/policy_denied"]);
    expect(authz[1]).toMatchObject({ principal: PRIORITIZER_PRINCIPAL_USER_ID, subject: null, payer: "payer-route-test", tool: "core__work_item_transition" });
    expect(logLines.filter((l) => String(l.event).startsWith("agent_role.")).map((l) => l.event)).toEqual(["agent_role.granted", "agent_role.revoked"]);
    const serialized = JSON.stringify(logLines);
    expect(serialized).not.toMatch(/cogni_ag_sk|Bearer |AUTH_SECRET|0x[0-9a-fA-F]{40}/);
    process.stdout.write(`${["V9 raw log lines:", ...logLines.filter((l) => String(l.event).startsWith("agent_")).map((l) => JSON.stringify(l))].join("\n")}\n`);
  });
});

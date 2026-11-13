// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-personal-grants.int.test`
 * Purpose: PERSONAL GRANTS and CLAIM (task.5465, revision 5), against real Postgres through the real route handlers.
 *   The owner click loop: an owned agent asks `knowledge:contribute`, the ask answers with its OWN approval page, the owner opens it (nothing changes) and approves, the agent's door opens (the log
 *   names the owner), an admin sees the delegation read-only and revokes it (kill switch), the door closes. An ownerless agent's ask answers with an Admin page. A non-delegable scope goes to Admin
 *   even for an owned agent. An existing ownerless agent claims itself with its own key, and the owner's click makes it theirs (same principal).
 * Scope: Real `agent.access.requests`, `agent-access/mine`, `agent/claim`, `profile/ai/claims` and admin `ai-access` handlers, real wrapper, real `agent-authority`, real migrations (0042). Only the
 *   NextAuth/bearer identity decode is replaced (`getSessionUser`).
 * Invariants: APPROVER_FOLLOWS_RESOURCE, NO_SELF_APPROVAL, FAIL_CLOSED_NON_DISCLOSING, HUMAN_ROUTES_SESSION_ONLY, ONE_IDENTITY, the CHECK constraints.
 * Side-effects: IO (testcontainers or local Postgres)
 */

import { randomUUID } from "node:crypto";
import { agentRolesHasRoles, completeAgentClaim, createPostgresSpawnStore, type CredentialSql, MAX_OWNED_AGENTS, startAgentClaim } from "@cogni/agent-grants/credentials";
import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
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
  resolveServiceDb: () => holder.service,
}));
vi.mock("@/bootstrap/agent-credentials", async () => {
  const mod = await import("@cogni/agent-grants/credentials");
  return {
    getAgentSpawnStore: () => mod.createPostgresSpawnStore(holder.spawnClient as never),
    getAgentCredentialStore: () => {
      throw new Error("not used here");
    },
  };
});

import { DELETE as adminDelete, GET as adminGet, POST as adminPost } from "@/app/api/v1/admin/ai-access/route";
import { POST as claimStart } from "@/app/api/v1/agent/claim/route";
import { GET as askList, POST as askCreate } from "@/app/api/v1/agent/access-requests/route";
import { DELETE as mineDelete, GET as mineGet, POST as minePost } from "@/app/api/v1/agent-access/mine/route";
import { POST as mineRequestPost } from "@/app/api/v1/agent-access/mine/requests/[id]/route";
import { GET as claimView, POST as claimComplete } from "@/app/api/v1/profile/ai/claims/[id]/route";
import { type AgentAuthoritySql, createAgentToolAuthority } from "@/bootstrap/agent-authority";
import { createNodeAdminPort } from "@/bootstrap/node-admin-port";

const CONTRIBUTE = "knowledge:contribute";
const ADMIN_WALLET = `0x${randomUUID().replaceAll("-", "").padEnd(40, "b").slice(0, 40)}`;
const UUID_TAIL = /[?&](?:request|claim)=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

describe("personal grants and claim (real Postgres)", () => {
  let service: Sql;
  const users: string[] = [];
  let admin: string;
  let owner: string;
  let other: string;
  let agent: string;
  let otherAgent: string;
  let loose: string;
  let authority: ReturnType<typeof createAgentToolAuthority>;
  const lines: Array<Record<string, unknown>> = [];

  const mkUser = async (name: string, wallet?: string) => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${name})`;
    if (wallet) await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${id}, 'wallet', ${wallet})`;
    users.push(id);
    return id;
  };
  const mkAgent = async (name: string, ownerId: string | null) => {
    const id = await mkUser(name);
    await service`INSERT INTO agent_principals (kind, slug, user_id, owner_user_id) VALUES ('external', NULL, ${id}, ${ownerId})`;
    return id;
  };
  const as = (id: string | null, via: "bearer" | "session") =>
    (session.user = id ? { id, walletAddress: id === admin ? ADMIN_WALLET : null, displayName: null, avatarColor: null, via } : null);
  const req = (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    new NextRequest(url, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...init.headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  const idCtx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

  const ask = (scope: string) => askCreate(req("http://localhost/api/v1/agent/access-requests", { method: "POST", body: { scope } }), undefined as never);
  const asked = async (scope: string) => {
    const res = await ask(scope);
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { approvalUrl: string | null; created: boolean };
    return { ...body, id: UUID_TAIL.exec(body.approvalUrl ?? "")?.[1] as string, path: (body.approvalUrl ?? "").replace(/^https?:\/\/[^/]+/, "") };
  };
  const myAccess = async () =>
    (await (await askList(req("http://localhost/api/v1/agent/access-requests"), undefined as never)).json()) as {
      requests: Array<{ scope: string; state: string; approvalUrl?: string }>;
    };
  /** What the owner's profile lists (the shared section's data): the rows of this person's AIs, each with its request id. */
  const ownerRows = async () =>
    (await (await mineGet(req("http://localhost/api/v1/agent-access/mine"), undefined as never)).json()) as {
      permissions: Array<{ requestId: string; who: string; scope: string; label: string; on: boolean; until: string | null }>;
    };
  const ownerDecide = (id: string, decision: "approve" | "deny", headers: Record<string, string> = {}) =>
    mineRequestPost(req(`http://localhost/api/v1/agent-access/mine/requests/${id}`, { method: "POST", body: { decision }, headers }), idCtx(id));
  const adminTable = async () => {
    as(admin, "session");
    return (await (await adminGet(req("http://localhost/api/v1/admin/ai-access"), undefined as never)).json()) as {
      permissions: Array<{ section: string; requestId?: string; principalUserId: string; scope: string; on: boolean }>;
    };
  };
  const adminWrite = (handler: typeof adminPost, body: unknown) =>
    handler(req("http://localhost/api/v1/admin/ai-access", { method: handler === adminPost ? "POST" : "DELETE", body }), undefined as never);
  const door = (userId: string, tool = "knowledge.contribute") =>
    authority.authorizeRoute({ toolId: tool, routeId: "knowledge.contributions.create", userId, via: "bearer" });
  const rowOf = async (principal: string, scope = CONTRIBUTE) =>
    (await service`SELECT id, resource_kind, owner_user_id, approved_by, revoked_at,
        (expires_at > now() + interval '29 days' AND expires_at < now() + interval '31 days') AS thirty_days
      FROM agent_roles WHERE principal_user_id = ${principal} AND scope = ${scope} ORDER BY created_at DESC LIMIT 1`)[0];
  const ownerOf = async (principal: string) => (await service`SELECT owner_user_id FROM agent_principals WHERE user_id = ${principal}`)[0]?.owner_user_id;
  const claimIdOf = (claimUrl: string) => UUID_TAIL.exec(claimUrl)?.[1] as string;

  beforeAll(async () => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 6 });
    holder.spawnClient = service;
    (holder as unknown as { service: unknown }).service = { $client: service };
    admin = await mkUser("claim-admin", ADMIN_WALLET);
    owner = await mkUser("Olive Owner");
    other = await mkUser("Pat Person");
    agent = await mkAgent("Helper bot", owner);
    otherAgent = await mkAgent("Pat's bot", other);
    loose = await mkAgent("Loose bot", null);
    const logger = pino({ level: "info", timestamp: false }, { write: (c: string) => void lines.push(JSON.parse(c)) });
    const nodeAdmin = {
      check: async (who: { walletAddress?: string | null }) =>
        who.walletAddress === ADMIN_WALLET ? { ok: true as const } : { ok: false as const, errorCode: "authz_denied" as const },
    };
    authority = createAgentToolAuthority({ sql: service as unknown as AgentAuthoritySql, nodeAdmin, log: logger, toolBundle: [...CORE_TOOL_BUNDLE] });
    holder.container = { log: logger, config: { unhandledErrorPolicy: "rethrow" }, agentAuthority: authority, nodeAdmin, nodeAdminPort: createNodeAdminPort(authority) };
  });
  afterAll(async () => {
    await service?.unsafe("DELETE FROM agent_claims WHERE agent_user_id = ANY($1) OR claimed_by = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM agent_roles WHERE principal_user_id = ANY($1) OR approved_by = ANY($1) OR owner_user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM agent_principals WHERE user_id = ANY($1) OR owner_user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM user_bindings WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [users]);
    await service?.end({ timeout: 1 });
  });

  it("the owner click loop: ask -> deep link to the profile row -> open (nothing changes) -> Approve -> door opens (owner in the log) -> admin sees it read-only and revokes -> door closes", async () => {
    as(agent, "bearer");
    const first = await asked(CONTRIBUTE);
    expect(first.created).toBe(true);
    expect(first.path).toBe(`/profile?request=${first.id}`);
    expect(await rowOf(agent)).toMatchObject({ id: first.id, resource_kind: "delegated", owner_user_id: owner, approved_by: null });
    expect(await door(agent)).toMatchObject({ decision: "deny", reason: "no_role" }); // an Off row opens nothing
    expect((await myAccess()).requests[0]).toMatchObject({ scope: CONTRIBUTE, state: "pending", approvalUrl: expect.stringContaining(first.id) });
    expect((await asked(CONTRIBUTE)).id).toBe(first.id); // asking again is the same page

    // The owner opens the profile: the row with that id is in their list (the page highlights it), and opening approves nothing. Another person and the admin table do not see it.
    as(owner, "session");
    expect((await ownerRows()).permissions).toEqual([
      expect.objectContaining({ requestId: first.id, who: "Helper bot", scope: CONTRIBUTE, on: false, label: "Propose changes to the knowledge base" }),
    ]);
    expect((await rowOf(agent))?.approved_by).toBeNull();
    as(other, "session");
    expect((await ownerRows()).permissions.map((p) => p.requestId)).not.toContain(first.id);
    expect((await ownerDecide(first.id, "approve")).status).toBe(404);
    expect((await adminTable()).permissions.map((p) => p.requestId)).not.toContain(first.id);
    as(agent, "bearer");
    expect((await ownerDecide(first.id, "approve")).status).toBe(401);
    expect((await ownerDecide(first.id, "approve", { authorization: "Bearer cogni_ag_sk_v1_x" })).status).toBe(403);
    expect(await door(agent)).toMatchObject({ decision: "deny" });

    // The owner approves: one atomic UPDATE. The OWNER is the approver; it ends in 30 days.
    as(owner, "session");
    const approve = await ownerDecide(first.id, "approve");
    expect(approve.status).toBe(200);
    expect(await approve.json()).toEqual({ requestId: first.id, decision: "approve", changed: true });
    expect(await rowOf(agent)).toMatchObject({ approved_by: owner, owner_user_id: owner, thirty_days: true });
    expect((await ownerDecide(first.id, "approve")).status).toBe(409); // already decided: no second write
    expect(await door(agent)).toMatchObject({ decision: "allow", basis: "personal_grant", owner });
    expect(lines.some((l) => l.event === "agent_tool.authz" && l.principal === agent && l.decision === "allow" && l.owner === owner && l.reason === "personal_grant")).toBe(true);

    // The profile list shows it On. The admin table lists it read-only (section personal) and may revoke it.
    expect((await (await mineGet(req("http://localhost/api/v1/agent-access/mine"), undefined as never)).json()).permissions[0]).toMatchObject({ scope: CONTRIBUTE, on: true });
    const table = await adminTable();
    expect(table.permissions.filter((p) => p.principalUserId === agent)).toEqual([expect.objectContaining({ section: "personal", requestId: first.id, scope: CONTRIBUTE, on: true })]);
    const revoke = await adminWrite(adminDelete, { principalUserId: agent, scope: CONTRIBUTE });
    expect(await revoke.json()).toMatchObject({ changed: true });
    expect(await door(agent)).toMatchObject({ decision: "deny" }); // the kill switch worked
    expect((await adminWrite(adminPost, { principalUserId: agent, scope: CONTRIBUTE })).status).toBe(400); // the admin never approves a personal row (personal_scope)

    // Asked again, approved again, and the owner turns it Off from the profile.
    as(agent, "bearer");
    const again = await asked(CONTRIBUTE);
    expect(again.created).toBe(true);
    as(owner, "session");
    expect((await ownerDecide(again.id, "approve")).status).toBe(200);
    expect(await door(agent)).toMatchObject({ decision: "allow" });
    const off = await mineDelete(req("http://localhost/api/v1/agent-access/mine", { method: "DELETE", body: { principalUserId: agent, scope: CONTRIBUTE } }), undefined as never);
    expect(await off.json()).toMatchObject({ changed: true });
    expect(await door(agent)).toMatchObject({ decision: "deny" });
  });

  it("an ownerless agent's ask is an Admin deep link; an owned agent's ask off the list is one too; only an admin decides them", async () => {
    as(loose, "bearer");
    const node = await asked(CONTRIBUTE);
    expect(node.path).toBe(`/admin/ai-access?request=${node.id}`);
    expect(await rowOf(loose)).toMatchObject({ resource_kind: "node", owner_user_id: null });
    as(agent, "bearer");
    const off = await asked("work_item:transition");
    expect(off.path).toBe(`/admin/ai-access?request=${off.id}`);

    // The owner's list never carries an Admin ask, and a non-admin cannot decide one; an admin sees both rows by id and can.
    as(owner, "session");
    expect((await ownerRows()).permissions.map((p) => p.requestId)).not.toContain(node.id);
    expect((await ownerDecide(node.id, "approve")).status).toBe(404);
    expect((await adminWrite(adminPost, { principalUserId: loose, scope: CONTRIBUTE })).status).toBe(403);
    expect(await door(loose)).toMatchObject({ decision: "deny" });
    const pending = (await adminTable()).permissions.filter((p) => p.section === "pending");
    expect(pending.map((p) => p.requestId)).toEqual(expect.arrayContaining([node.id, off.id]));
    expect((await adminWrite(adminPost, { principalUserId: loose, scope: CONTRIBUTE })).status).toBe(200);
    expect(await door(loose)).toMatchObject({ decision: "allow", basis: "role" });
    await adminWrite(adminDelete, { principalUserId: loose, scope: CONTRIBUTE });
    await adminWrite(adminDelete, { principalUserId: agent, scope: "work_item:transition", deny: true });
  });

  it("a personal row never opens an admin-subject scope or a scope off the list, and the database refuses to hold one", async () => {
    // The door for an admin-subject tool: even a forced personal row does not satisfy it.
    await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, resource_kind, owner_user_id, expires_at)
      VALUES (${otherAgent}, ${CONTRIBUTE}, ${other}, 'delegated', ${other}, now() + interval '1 day')`;
    expect(await door(otherAgent)).toMatchObject({ decision: "allow" });
    expect(await door(otherAgent, "core__vcs_merge_pr")).toMatchObject({ decision: "deny" });
    await service`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${otherAgent}`;

    const insert = (cols: { scope?: string; kind: string; owner: string | null; approvedBy: string | null; expires: boolean; principal?: string }) =>
      service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, resource_kind, owner_user_id, expires_at)
        VALUES (${cols.principal ?? otherAgent}, ${cols.scope ?? CONTRIBUTE}, ${cols.approvedBy}, ${cols.kind}, ${cols.owner}, ${cols.expires ? service`now() + interval '1 day'` : null})`;
    await expect(insert({ kind: "delegated", owner: other, approvedBy: otherAgent, expires: true })).rejects.toThrow(/agent_roles_personal_approver/); // the agent approving itself
    await expect(insert({ kind: "delegated", owner: other, approvedBy: owner, expires: true })).rejects.toThrow(/agent_roles_personal_approver/); // a stranger approving
    await expect(insert({ kind: "delegated", owner: other, approvedBy: other, expires: false })).rejects.toThrow(/agent_roles_personal_approver/); // never ends
    await expect(insert({ kind: "delegated", owner: null, approvedBy: null, expires: false })).rejects.toThrow(/agent_roles_owner_shape/);
    await expect(insert({ kind: "node", owner: other, approvedBy: null, expires: false })).rejects.toThrow(/agent_roles_owner_shape/);
    await expect(insert({ kind: "galaxy", owner: other, approvedBy: null, expires: false })).rejects.toThrow(/agent_roles_resource_kind_canonical/);
    await expect(insert({ kind: "delegated", scope: "work_item:transition", owner: other, approvedBy: other, expires: true })).rejects.toThrow(/agent_roles_personal_scope_delegable/);
    const node = (await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by) VALUES (${otherAgent}, ${`node:${randomUUID()}`}, ${owner}) RETURNING resource_kind, owner_user_id, expires_at`)[0];
    expect(node).toEqual({ resource_kind: "node", owner_user_id: null, expires_at: null });
    await expect(service`INSERT INTO agent_claims (agent_user_id, expires_at, claimed_at, claimed_by) VALUES (${otherAgent}, now() + interval '1 minute', now(), ${otherAgent})`).rejects.toThrow(/agent_claims_claimant_not_agent/);
    await service`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${otherAgent}`;
  });

  it("a personal row is not a node role: agentRolesHasRoles (the key-upgrade binding rule) ignores it, and still sees a live node row", async () => {
    const hasRoles = agentRolesHasRoles(service as unknown as CredentialSql);
    const probe = await mkAgent("Binding probe", owner);
    await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, resource_kind, owner_user_id, expires_at)
      VALUES (${probe}, ${CONTRIBUTE}, ${owner}, 'delegated', ${owner}, now() + interval '1 day')`;
    expect(await hasRoles(probe)).toBe(false); // a live personal row changes nothing
    await service`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${probe}`;
    await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by) VALUES (${probe}, ${CONTRIBUTE}, ${other})`;
    expect(await hasRoles(probe)).toBe(true); // a live node row still counts
  });

  it("claim: an existing ownerless agent asks with its own key; the owner's click makes it theirs (same principal); single use, 15 minutes, bound to that agent", async () => {
    const before = await ownerOf(loose);
    expect(before).toBeNull();
    // A person's session or a stranger's call is not the agent's own key.
    as(owner, "session");
    expect((await claimStart(req("http://localhost/api/v1/agent/claim", { method: "POST" }), undefined as never)).status).toBe(404);
    as(loose, "bearer");
    const started = await claimStart(req("http://localhost/api/v1/agent/claim", { method: "POST" }), undefined as never);
    expect(started.status).toBe(201);
    const { claimUrl } = (await started.json()) as { claimUrl: string };
    expect(claimUrl).toMatch(/\/profile\?claim=[0-9a-f-]{36}$/);
    const claimId = claimIdOf(claimUrl);
    expect(await ownerOf(loose)).toBeNull(); // asking changes nothing

    // Opening the page claims nothing; a key never claims; signed out is 401.
    as(null, "session");
    expect((await claimView(req(`http://localhost/api/v1/profile/ai/claims/${claimId}`), idCtx(claimId))).status).toBe(401);
    as(loose, "bearer");
    expect((await claimComplete(req(`http://localhost/api/v1/profile/ai/claims/${claimId}`, { method: "POST" }), idCtx(claimId))).status).toBe(401);
    expect(
      (await claimComplete(req(`http://localhost/api/v1/profile/ai/claims/${claimId}`, { method: "POST", headers: { authorization: "Bearer cogni_ag_sk_v1_x" } }), idCtx(claimId))).status
    ).toBe(403);
    as(owner, "session");
    const view = await claimView(req(`http://localhost/api/v1/profile/ai/claims/${claimId}`), idCtx(claimId));
    expect(await view.json()).toMatchObject({ claimId, agentName: "Loose bot", state: "open" });
    expect(await ownerOf(loose)).toBeNull();

    // The owner clicks Claim. Same principal, the owner set once; a second click is "used".
    const click = await claimComplete(req(`http://localhost/api/v1/profile/ai/claims/${claimId}`, { method: "POST" }), idCtx(claimId));
    expect(click.status).toBe(200);
    expect(await click.json()).toEqual({ claimed: true });
    expect(await ownerOf(loose)).toBe(owner);
    expect((await service`SELECT count(*)::int AS n FROM agent_principals WHERE user_id = ${loose}`)[0]?.n).toBe(1);
    as(other, "session");
    const again = await claimComplete(req(`http://localhost/api/v1/profile/ai/claims/${claimId}`, { method: "POST" }), idCtx(claimId));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "claim_used" });
    expect(await ownerOf(loose)).toBe(owner);
    as(loose, "bearer");
    expect((await claimStart(req("http://localhost/api/v1/agent/claim", { method: "POST" }), undefined as never)).status).toBe(409); // already owned

    // Now owned: its delegable ask goes to its new owner's profile.
    const personal = await asked("knowledge:read");
    expect(personal.path).toBe(`/profile?request=${personal.id}`);
    as(owner, "session");
    expect((await ownerDecide(personal.id, "deny")).status).toBe(200);
  });

  it("claim limits: expired link 410; an agent never owns (by SQL, not only the route); 25 agents per person", async () => {
    const spawn = createPostgresSpawnStore(service as unknown as CredentialSql);
    const stray = await mkAgent("Stray bot", null);
    const a = await startAgentClaim(spawn, { agentUserId: stray });
    if (!a.ok) throw new Error("start");
    await service`UPDATE agent_claims SET expires_at = now() - interval '1 second' WHERE id = ${a.claimId}::uuid`;
    as(owner, "session");
    expect((await claimComplete(req("http://localhost/x", { method: "POST" }), idCtx(a.claimId))).status).toBe(410);
    expect(await ownerOf(stray)).toBeNull();

    const b = await startAgentClaim(spawn, { agentUserId: stray });
    if (!b.ok) throw new Error("start");
    expect(await completeAgentClaim(spawn, { claimId: b.claimId, ownerUserId: otherAgent })).toEqual({ ok: false, reason: "owner_is_agent" });
    expect(await completeAgentClaim(spawn, { claimId: b.claimId, ownerUserId: stray })).toEqual({ ok: false, reason: "owner_is_agent" });
    expect(await ownerOf(stray)).toBeNull();

    // 25 agents per person.
    const full = await mkUser("Full Owner");
    for (let i = 0; i < MAX_OWNED_AGENTS; i += 1) await mkAgent(`owned-${i}`, full);
    expect(await completeAgentClaim(spawn, { claimId: b.claimId, ownerUserId: full })).toEqual({ ok: false, reason: "too_many_agents" });
    expect(await ownerOf(stray)).toBeNull();
    expect(await completeAgentClaim(spawn, { claimId: b.claimId, ownerUserId: other })).toEqual({ ok: true, agentUserId: stray });
    expect(await ownerOf(stray)).toBe(other);
  });
});

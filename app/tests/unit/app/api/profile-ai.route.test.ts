// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/profile-ai.route`
 * Purpose: "Your AIs" on a person's own profile (task.5474). Session only (any Authorization header is 403 human_session_required, signed out is 401);
 *   the list is keyed on the SESSION's user id, so a person sees only their own agents; "Add an AI" returns ONE setup line holding the one-time
 *   code and the 6th pending grant is 429; revoke by another person is 404 and ends nothing; the list never carries a key, hash or grant.
 * Scope: The real route handlers and the real package services over a memory store; fake session and container; no database, no network.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY; OWNER_SEES_ONLY_OWN; HUMAN_SURFACE_TOKENLESS; APPROVER_FOLLOWS_RESOURCE (no admin check anywhere here).
 * Side-effects: none
 */

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { memorySpawnStore } from "@tests/helpers/spawn-memory-store";

const fake = vi.hoisted(() => ({
  user: null as unknown,
  world: null as unknown as ReturnType<typeof import("@tests/helpers/spawn-memory-store").memorySpawnStore>,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request) => Promise<NextResponse>) =>
    (request: Request) =>
      handler({ log: fake.log }, request),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn(async () => fake.user) }));
vi.mock("@/bootstrap/container", () => ({ getContainer: () => ({ log: fake.log }) }));
vi.mock("@/bootstrap/agent-credentials", () => ({
  getAgentSpawnStore: () => fake.world.spawn,
  getAgentCredentialStore: () => fake.world.credentials,
}));

import { redeemSpawnGrant } from "@cogni/agent-grants/credentials";
import { GET, POST } from "@/app/api/v1/profile/ai/route";
import { POST as REVOKE } from "@/app/api/v1/profile/ai/revoke/route";

const URL_ = "http://node.test/api/v1/profile/ai";
const person = (id: string, via: "session" | "bearer" = "session") => ({ id, walletAddress: null, displayName: null, avatarColor: null, via });
const call = (handler: typeof GET, init: { method?: string; headers?: Record<string, string>; body?: unknown; url?: string } = {}) =>
  handler(
    new NextRequest(init.url ?? URL_, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...init.headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    undefined as never
  );
const addAi = () => call(POST, { method: "POST" });
const revoke = (agentId: string, headers: Record<string, string> = {}) =>
  call(REVOKE as typeof GET, { method: "POST", url: `${URL_}/revoke`, body: { agentId }, headers });

/** An agent redeems a setup line's code, like the agent would at /agent/register. */
async function agentRedeems(setupLine: string, name: string, newUserId: string, confirm = true) {
  const grant = /cogni_sg_v1_[A-Za-z0-9_-]{43}/.exec(setupLine)?.[0] as string;
  const r = await redeemSpawnGrant(fake.world.spawn, { grant, name, newUserId, nameTaken: async () => false });
  if (!r.ok) throw new Error(r.reason);
  if (confirm) fake.world.confirm(r.userId);
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.world = memorySpawnStore({ users: { alice: {}, bob: {} } });
  fake.user = person("alice");
});

describe("session only", () => {
  it("any Authorization header is 403 human_session_required on every route, even a valid-looking key", async () => {
    const headers = { authorization: "Bearer cogni_ag_sk_v1_x" };
    for (const res of [await call(GET, { headers }), await call(POST, { method: "POST", headers }), await revoke("a-1", headers)]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "human_session_required" });
    }
    expect(fake.world.keys).toHaveLength(0);
  });

  it("signed out is 401, and a resolved bearer identity is 401 too, never a person", async () => {
    fake.user = null;
    expect((await call(GET)).status).toBe(401);
    expect((await addAi()).status).toBe(401);
    fake.user = person("alice", "bearer");
    expect((await call(GET)).status).toBe(401);
  });

  it("every answer is no-store", async () => {
    expect((await call(GET)).headers.get("cache-control")).toBe("no-store");
    expect((await addAi()).headers.get("cache-control")).toBe("no-store");
  });
});

describe("Add an AI", () => {
  it("returns ONE setup line with the one-time code, the node's own origin and the exact endpoints; the list never shows it", async () => {
    const res = await addAi();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.setupLine).toMatch(/cogni_sg_v1_[A-Za-z0-9_-]{43}/);
    expect(body.setupLine).toContain("http://node.test/api/v1/agent/register");
    expect(body.setupLine).toContain("http://node.test/api/v1/agent/credentials/confirm");
    expect(body.setupLine).not.toContain("\\n");
    expect(body.setupLine.split("\n")).toHaveLength(1);
    expect(body.grantsLeft).toBe(4);

    const list = await (await call(GET)).json();
    expect(JSON.stringify(list)).not.toContain("cogni_sg_v1_");
    expect(list.grantsLeft).toBe(4);
    // The log carries ids, never the code.
    expect(JSON.stringify(fake.log.info.mock.calls)).not.toMatch(/cogni_sg_v1_/);
  });

  it("the 6th pending setup line is 429 too_many_pending", async () => {
    for (let i = 0; i < 5; i++) expect((await addAi()).status).toBe(201);
    const res = await addAi();
    expect([res.status, (await res.json()).error]).toEqual([429, "too_many_pending"]);
    // Another person is not held back by Alice's cap.
    fake.user = person("bob");
    expect((await addAi()).status).toBe(201);
  });
});

describe("Your AIs", () => {
  it("a person sees only the agents they own: name, created, key state, and no key, hash, grant or credential id", async () => {
    const line = (await (await addAi()).json()).setupLine as string;
    const agent = await agentRedeems(line, "Helper bot", "agent-a");
    fake.user = person("bob");
    const bobLine = (await (await addAi()).json()).setupLine as string;
    await agentRedeems(bobLine, "Bob bot", "agent-b", false);

    fake.user = person("alice");
    const alice = await (await call(GET)).json();
    expect(alice.agents).toEqual([{ agentId: "agent-a", name: "Helper bot", createdAt: expect.any(String), keyState: "active" }]);
    expect(JSON.stringify(alice)).not.toContain(agent.apiKey);

    fake.user = person("bob");
    const bob = await (await call(GET)).json();
    expect(bob.agents).toEqual([{ agentId: "agent-b", name: "Bob bot", createdAt: expect.any(String), keyState: "pending" }]);
  });
});

describe("Revoke", () => {
  it("the owner revokes their agent; the agent shows revoked", async () => {
    const agent = await agentRedeems((await (await addAi()).json()).setupLine, "Helper bot", "agent-a");
    const res = await revoke("agent-a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentId: "agent-a", revoked: 1 });
    expect(fake.world.keys.filter((k) => !k.revoked)).toHaveLength(0);
    expect((await (await call(GET)).json()).agents[0].keyState).toBe("revoked");
    expect(fake.log.info).toHaveBeenCalledWith(expect.objectContaining({ event: "agent.owner.revoked", ownerUserId: "alice", agentUserId: "agent-a" }), "agent.owner.revoked");
    expect(agent.ok).toBe(true);
  });

  it("another person cannot revoke your agent: 404, and its key stays live; an unknown id is the same 404", async () => {
    await agentRedeems((await (await addAi()).json()).setupLine, "Helper bot", "agent-a");
    fake.user = person("bob");
    for (const id of ["agent-a", "no-such-agent"]) {
      const res = await revoke(id);
      expect([res.status, (await res.json()).error]).toEqual([404, "not_found"]);
    }
    expect(fake.world.keys.filter((k) => !k.revoked)).toHaveLength(1);
  });

  it("a bad body is 400", async () => {
    const res = await call(REVOKE as typeof GET, { method: "POST", url: `${URL_}/revoke`, body: {} });
    expect(res.status).toBe(400);
  });
});

describe("outage", () => {
  it("a store failure is 503 authz_unavailable, never a 500 or an empty list", async () => {
    fake.world.outage.failing = true;
    for (const res of [await call(GET), await addAi(), await revoke("agent-a")]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "authz_unavailable" });
    }
  });
});

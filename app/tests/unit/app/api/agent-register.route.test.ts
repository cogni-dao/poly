// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/agent-register.route`
 * Purpose: Name collisions at registration. The name is what an admin reads when deciding on an agent's asks, so a name that
 *   matches an existing user or one of this node's AI is 409 `name_taken`, and a name with hidden or direction characters is 400.
 * Scope: The real route handler with a fake container and database; no network.
 * Invariants: Nothing is written (no user, no billing account, no key) when the name is refused.
 * Side-effects: none
 */

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  nameTaken: vi.fn(),
  insert: vi.fn(),
  billing: vi.fn(),
  grantState: vi.fn(),
  redeem: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request) => Promise<NextResponse>) =>
    (request: Request) =>
      handler({ log: fake.log }, request),
}));
vi.mock("@/app/_lib/auth/request-identity", () => ({ issueAgentApiKey: () => "cogni_ag_sk_v1_fake" }));
vi.mock("@/bootstrap/agent-credentials", () => ({
  getAgentSpawnStore: () => ({ grantState: fake.grantState, redeem: fake.redeem }),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    agentAuthority: { nameTaken: fake.nameTaken },
    serviceAccountService: { getOrCreateBillingAccountForUser: fake.billing },
  }),
  resolveServiceDb: () => ({ insert: (table: unknown) => ({ values: (row: unknown) => fake.insert(row, table) }) }),
}));

import { POST } from "@/app/api/v1/agent/register/route";

const register = (name: unknown, spawnGrant?: string) =>
  POST(
    new NextRequest("http://localhost/api/v1/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ...(spawnGrant !== undefined ? { spawnGrant } : {}) }),
    }),
    undefined as never
  );
const GRANT = `cogni_sg_v1_${"A".repeat(43)}`;

beforeEach(() => {
  vi.clearAllMocks();
  fake.nameTaken.mockResolvedValue(false);
  fake.billing.mockResolvedValue({ id: "ba-1" });
  fake.grantState.mockResolvedValue({ state: "open" });
});

describe("agent register: the name is what an admin reads", () => {
  it("registers a fresh name, stored trimmed with spaces collapsed", async () => {
    const res = await register("  Helper   bot ");
    expect(res.status).toBe(201);
    expect(fake.nameTaken).toHaveBeenCalledWith("Helper bot");
    expect(fake.insert).toHaveBeenCalledWith(expect.objectContaining({ name: "Helper bot", walletAddress: null }), expect.anything());
  });

  it("anonymous registration still works and marks the agent ownerless (an external principal with no owner)", async () => {
    const res = await register("Loner bot");
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.apiKey).toBe("cogni_ag_sk_v1_fake");
    expect(body.keyState).toBeUndefined();
    expect(fake.redeem).not.toHaveBeenCalled();
    expect(fake.insert).toHaveBeenCalledWith(expect.objectContaining({ kind: "external", ownerUserId: null }), expect.anything());
  });

  it("a name that matches an existing user or this node's AI is 409 name_taken and writes nothing", async () => {
    fake.nameTaken.mockResolvedValue(true);
    const res = await register("node-ai");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "name_taken" });
    expect(fake.insert).not.toHaveBeenCalled();
    expect(fake.billing).not.toHaveBeenCalled();
  });

  it("a name with hidden or direction characters is 400 and is not even looked up", async () => {
    for (const bad of ["Gen\u200Beral assistant", "\u202Eevil", "a\u0000b"]) {
      const res = await register(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(fake.nameTaken).not.toHaveBeenCalled();
    expect(fake.insert).not.toHaveBeenCalled();
  });

  it("an empty or over-long name is 400 as before", async () => {
    expect((await register("")).status).toBe(400);
    expect((await register("x".repeat(81))).status).toBe(400);
  });
});

describe("agent register with a spawn grant: the agent is linked to the person who made it", () => {
  const redeemed = (over: Record<string, unknown> = {}) => ({
    ok: true,
    userId: "agent-1",
    ownerUserId: "person-1",
    credentialId: "cred-1",
    pendingExpiresAt: "2026-11-12T12:15:00.000Z",
    retry: false,
    ...over,
  });

  it("redeems: 201 with a pending revocable key, a billing account for the new agent, and no v1 key, no anonymous insert", async () => {
    fake.redeem.mockResolvedValue(redeemed());
    const res = await register("Helper bot", GRANT);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ userId: "agent-1", billingAccountId: "ba-1", keyState: "pending" });
    expect(body.apiKey).toMatch(/^cogni_ag_sk_v2_/);
    expect(fake.billing).toHaveBeenCalledWith({ userId: "agent-1", displayName: "Helper bot" });
    expect(fake.insert).not.toHaveBeenCalled(); // the store, not the route, writes the user and the owned principal
    expect(fake.redeem).toHaveBeenCalledWith(expect.objectContaining({ name: "Helper bot" }));
    expect(fake.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent.spawn_grant.redeemed", userId: "agent-1", ownerUserId: "person-1" }),
      "agent.spawn_grant.redeemed"
    );
    // No log line carries the grant or the key.
    expect(JSON.stringify([...fake.log.info.mock.calls, ...fake.log.warn.mock.calls])).not.toContain(GRANT);
    expect(JSON.stringify([...fake.log.info.mock.calls, ...fake.log.warn.mock.calls])).not.toContain(body.apiKey);
  });

  it("the request cannot name an owner: an `ownerUserId` field is ignored", async () => {
    fake.redeem.mockResolvedValue(redeemed());
    const res = await POST(
      new NextRequest("http://localhost/api/v1/agent/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Helper bot", spawnGrant: GRANT, ownerUserId: "someone-else" }),
      }),
      undefined as never
    );
    expect(res.status).toBe(201);
    expect(JSON.stringify(fake.redeem.mock.calls)).not.toContain("someone-else");
  });

  it("a retry (same grant, same name, key not yet confirmed) answers 201 again for the same agent", async () => {
    fake.grantState.mockResolvedValue({ state: "redeemed", userId: "agent-1", name: "Helper bot", unconfirmed: true });
    fake.redeem.mockResolvedValue(redeemed({ retry: true }));
    const res = await register("Helper bot", GRANT);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ userId: "agent-1", keyState: "pending" });
    expect(fake.nameTaken).not.toHaveBeenCalled(); // the agent's own name is not a collision with itself
  });

  it("reuse is 409 spawn_grant_used; expired is 410 spawn_grant_expired; unknown or malformed is 403 invalid_spawn_grant; nothing is written", async () => {
    fake.grantState.mockResolvedValue({ state: "redeemed", userId: "agent-1", name: "Helper bot", unconfirmed: false });
    let res = await register("Helper bot", GRANT);
    expect([res.status, (await res.json()).error]).toEqual([409, "spawn_grant_used"]);

    fake.grantState.mockResolvedValue({ state: "expired" });
    res = await register("Helper bot", GRANT);
    expect([res.status, (await res.json()).error]).toEqual([410, "spawn_grant_expired"]);

    fake.grantState.mockResolvedValue({ state: "unknown" });
    res = await register("Helper bot", GRANT);
    expect([res.status, (await res.json()).error]).toEqual([403, "invalid_spawn_grant"]);
    res = await register("Helper bot", "not-a-grant");
    expect([res.status, (await res.json()).error]).toEqual([403, "invalid_spawn_grant"]);

    expect(fake.redeem).not.toHaveBeenCalled();
    expect(fake.billing).not.toHaveBeenCalled();
    expect(fake.insert).not.toHaveBeenCalled();
  });

  it("a taken name with a grant is 409 name_taken, and the grant is not spent", async () => {
    fake.nameTaken.mockResolvedValue(true);
    const res = await register("node-ai", GRANT);
    expect([res.status, (await res.json()).error]).toEqual([409, "name_taken"]);
    expect(fake.redeem).not.toHaveBeenCalled();
  });

  it("a store outage is 503 authz_unavailable, never a refusal", async () => {
    fake.grantState.mockRejectedValue(new Error("db down"));
    const res = await register("Helper bot", GRANT);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authz_unavailable" });
  });
});

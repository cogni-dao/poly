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
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request) => Promise<NextResponse>) =>
    (request: Request) =>
      handler({ log: { info: vi.fn() } }, request),
}));
vi.mock("@/app/_lib/auth/request-identity", () => ({ issueAgentApiKey: () => "cogni_ag_sk_v1_fake" }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    agentAuthority: { nameTaken: fake.nameTaken },
    serviceAccountService: { getOrCreateBillingAccountForUser: fake.billing },
  }),
  resolveServiceDb: () => ({ insert: () => ({ values: fake.insert }) }),
}));

import { POST } from "@/app/api/v1/agent/register/route";

const register = (name: unknown) =>
  POST(
    new NextRequest("http://localhost/api/v1/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    undefined as never
  );

beforeEach(() => {
  vi.clearAllMocks();
  fake.nameTaken.mockResolvedValue(false);
  fake.billing.mockResolvedValue({ id: "ba-1" });
});

describe("agent register: the name is what an admin reads", () => {
  it("registers a fresh name, stored trimmed with spaces collapsed", async () => {
    const res = await register("  Helper   bot ");
    expect(res.status).toBe(201);
    expect(fake.nameTaken).toHaveBeenCalledWith("Helper bot");
    expect(fake.insert).toHaveBeenCalledWith(expect.objectContaining({ name: "Helper bot", walletAddress: null }));
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

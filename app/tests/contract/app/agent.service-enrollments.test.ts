// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/agent.service-enrollments`
 * Purpose: Contract tests for POST /api/v1/public/agent/service-enrollments (story.0038): a signed service assertion plus `{ scope }` writes one pending ask.
 * Scope: HTTP behavior over a mocked container (no database, no network): a missing or refused assertion is 401, an unreachable key set 503, a bad body 400, a new ask
 *   201 `pending`, a repeat 200, a live grant 200 `granted`, and a scope the service did not sign is 400.
 * Invariants: Nothing is granted by this route; the answer carries no key, link or token.
 * Side-effects: none (fully mocked)
 */

import { AgentRolesError } from "@cogni/agent-grants";
import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ verify: vi.fn(), requestServiceAccess: vi.fn() }));

vi.mock("@/bootstrap/container", () => {
  const log = { child: vi.fn(() => log), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    getContainer: vi.fn(() => ({
      log,
      clock: { now: vi.fn(() => new Date("2026-01-01T00:00:00Z")) },
      config: { rateLimitBypass: { enabled: true, headerName: "x-stack-test", headerValue: "1" }, DEPLOY_ENVIRONMENT: "test", unhandledErrorPolicy: "rethrow" },
      serviceAuth: { verify: fake.verify },
      agentAuthority: { requestServiceAccess: fake.requestServiceAccess },
    })),
  };
});
vi.mock("@/shared/env", () => ({ serverEnv: () => MOCK_SERVER_ENV }));
vi.mock("@/shared/env/server-env", () => ({ serverEnv: () => MOCK_SERVER_ENV }));
vi.mock("@/bootstrap/http/rateLimiter", () => ({
  publicApiLimiter: { consume: vi.fn(() => true) },
  extractClientIp: vi.fn(() => "test-ip"),
  TokenBucketRateLimiter: vi.fn(),
}));

import { POST } from "@/app/api/v1/public/agent/service-enrollments/route";

const verified = { ok: true, issuer: "https://cognidao.org", service: "git-review", clientId: "https://cognidao.org#git-review", scope: "knowledge:read", jti: "j" };
const call = (body: unknown, authorization: string | null = "Bearer a.b.c") =>
  POST(
    new NextRequest("http://localhost:3000/api/v1/public/agent/service-enrollments", {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body),
    })
  );

describe("POST /api/v1/public/agent/service-enrollments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.verify.mockResolvedValue(verified);
    fake.requestServiceAccess.mockResolvedValue({ state: "pending", created: true });
  });

  it("a new ask is 201 pending and carries nothing else; a repeat is 200; a live grant is 200 granted", async () => {
    const created = await call({ scope: "knowledge:read" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ status: "pending" });
    expect(fake.requestServiceAccess).toHaveBeenCalledWith(verified, "knowledge:read");
    fake.requestServiceAccess.mockResolvedValue({ state: "pending", created: false });
    expect((await call({ scope: "knowledge:read" })).status).toBe(200);
    fake.requestServiceAccess.mockResolvedValue({ state: "granted", created: false });
    const granted = await call({ scope: "knowledge:read" });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({ status: "granted" });
  });

  it("no bearer or a refused assertion is 401 and writes nothing; an unreachable key set is 503", async () => {
    expect((await call({ scope: "knowledge:read" }, null)).status).toBe(401);
    fake.verify.mockResolvedValue({ ok: false, code: "replayed" });
    expect((await call({ scope: "knowledge:read" })).status).toBe(401);
    fake.verify.mockResolvedValue({ ok: false, code: "jwks_unavailable" });
    expect((await call({ scope: "knowledge:read" })).status).toBe(503);
    expect(fake.requestServiceAccess).not.toHaveBeenCalled();
  });

  it("a bad body is 400 before any verification", async () => {
    expect((await call({ scope: "not a scope" })).status).toBe(400);
    expect((await call({})).status).toBe(400);
    expect(fake.verify).not.toHaveBeenCalled();
  });

  it("a scope the service did not sign, or one no route uses, is 400; too many open asks is 429; a store failure is 503", async () => {
    fake.requestServiceAccess.mockRejectedValue(new AgentRolesError("invalid_scope", "x"));
    expect((await call({ scope: "knowledge:contribute" })).status).toBe(400);
    fake.requestServiceAccess.mockRejectedValue(new AgentRolesError("no_external_door", "x"));
    expect((await call({ scope: "metric:compute" })).status).toBe(400);
    fake.requestServiceAccess.mockRejectedValue(new AgentRolesError("too_many_requests", "x"));
    expect((await call({ scope: "knowledge:read" })).status).toBe(429);
    fake.requestServiceAccess.mockRejectedValue(new Error("db down"));
    expect((await call({ scope: "knowledge:read" })).status).toBe(503);
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/admin-ai-access-route`
 * Purpose: Handler-level authz for `/api/v1/admin/ai-access`, the route that turns the node AI's shell On and Off.
 * Scope: The real route handlers, the real `requireAdminSession` and the real package `adminAiAccessHttp`; session, container and the
 *   route wrapper are the only fakes.
 * Invariants: FAIL_CLOSED_WITH_DISTINCTION (401 / 403 / 503), COOKIE_WRITES_ARE_SAME_ORIGIN, no port call before the admin decision.
 * Side-effects: none
 * Links: src/app/api/v1/admin/_lib/ai-access-route.ts, src/app/(admin)/_lib/admin-session.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  user: vi.fn(),
  adminCheck: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  list: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: () => io.user(),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    agentAuthority: { adminCheck: io.adminCheck },
    nodeAdminPort: {
      listNodeAi: io.list,
      turnAiPermissionOn: io.on,
      turnAiPermissionOff: io.off,
      dismissAiRequest: vi.fn(),
      previewAiRequest: vi.fn(),
    },
    log: { info: io.info },
  }),
}));
// The wrapper owns logging and rate limits; the handler under test is the function it wraps.
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_cfg: unknown, handler: (ctx: unknown, req: Request) => Promise<Response>) =>
    (req: Request) =>
      handler({ log: { error: vi.fn(), info: vi.fn() } }, req),
}));

import {
  DELETE,
  GET,
  POST,
} from "@/app/api/v1/admin/ai-access/route";

const url = "http://0.0.0.0:3000/api/v1/admin/ai-access";
const body = JSON.stringify({ principal: "node-ai", scope: "sandbox:exec" });
const post = (headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

beforeEach(() => {
  vi.clearAllMocks();
  io.user.mockResolvedValue({ id: "admin-fixture" });
  io.adminCheck.mockResolvedValue("allow");
  io.list.mockResolvedValue({ permissions: [], more: 0 });
  io.on.mockResolvedValue({ principalUserId: "p", changed: true });
  io.off.mockResolvedValue({ principalUserId: "p", changed: true });
});

describe("/api/v1/admin/ai-access authz", () => {
  it("401s with no session, before any admin check or port call", async () => {
    io.user.mockResolvedValue(null);
    const res = await GET(new Request(url));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(io.adminCheck).not.toHaveBeenCalled();
    expect(io.list).not.toHaveBeenCalled();
  });

  it("403s a signed-in non-admin on read and on write, with no port call", async () => {
    io.adminCheck.mockResolvedValue("denied");
    const read = await GET(new Request(url));
    const write = await POST(
      post({ origin: "https://poly.example", host: "poly.example" })
    );
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: "authz_denied" });
    expect(io.list).not.toHaveBeenCalled();
    expect(io.on).not.toHaveBeenCalled();
  });

  it("503s when the admin check is unavailable, and never turns anything On", async () => {
    io.adminCheck.mockResolvedValue("unavailable");
    const res = await POST(
      post({ origin: "https://poly.example", host: "poly.example" })
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authz_unavailable" });
    expect(io.on).not.toHaveBeenCalled();
  });

  it("503s when the admin check throws or the key store is down", async () => {
    io.adminCheck.mockRejectedValue(new Error("db down"));
    expect((await GET(new Request(url))).status).toBe(503);
    io.adminCheck.mockResolvedValue("allow");
    io.user.mockRejectedValue(new Error("key store down"));
    expect((await GET(new Request(url))).status).toBe(503);
  });

  it.each([
    ["a foreign Origin", { origin: "https://evil.example", host: "poly.example" }],
    ["no Origin", { host: "poly.example" }],
  ])("refuses a cookie write with %s", async (_name, headers) => {
    const res = await POST(post(headers));
    expect(res.status).toBe(403);
    expect(io.on).not.toHaveBeenCalled();
    const off = await DELETE(
      new Request(url, { method: "DELETE", headers, body })
    );
    expect(off.status).toBe(403);
    expect(io.off).not.toHaveBeenCalled();
  });

  it("lets an admin turn the shell On from the public origin, and a bearer admin write without an Origin", async () => {
    const session = await POST(
      post({
        origin: "https://poly.example",
        "x-forwarded-host": "poly.example",
        host: "0.0.0.0:3000",
      })
    );
    expect(session.status).toBe(200);
    expect(io.on).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "admin-fixture" }),
      { ref: { principalSlug: "node-ai" }, scope: "sandbox:exec" }
    );
    const bearer = await POST(post({ authorization: "Bearer cogni_ag_sk_v1_x" }));
    expect(bearer.status).toBe(200);
    expect(io.on).toHaveBeenCalledTimes(2);
  });
});

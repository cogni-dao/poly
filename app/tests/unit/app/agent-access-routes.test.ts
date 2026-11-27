// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/agent-access-routes`
 * Purpose: Handler-level proof of the two routes that replaced Poly's own grant routes (migration 0093): the person's own table `/api/v1/agent-access/mine` (human
 *   plane) and the agent's ask `/api/v1/agent/access-requests` (AI plane).
 * Scope: The real route files and the real `@cogni/agent-grants/http` cores; session, container and the route wrapper are the only fakes.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY (any Authorization header is 403 before a read), COOKIE_WRITES_ARE_SAME_ORIGIN, KIND_PICKS_THE_PLANE (a session gets 404 on
 *   the ask route), SELF_REQUEST_ONLY (the principal is the caller, never the body).
 * Side-effects: none
 * Links: src/app/api/v1/agent-access/mine/route.ts, src/app/api/v1/agent/access-requests/route.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  sessionUser: vi.fn(),
  agentUser: vi.fn(),
  listMine: vi.fn(),
  turnMineOn: vi.fn(),
  requestAccess: vi.fn(),
  listOwnAccess: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({ getServerSessionUser: () => io.sessionUser() }));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: () => io.agentUser() }));
vi.mock("@/app/_lib/approval-origin", () => ({ resolveAgentApprovalOrigin: () => "https://poly.example" }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    agentAuthority: {
      scopeKinds: { "account:read": "account" },
      listMine: io.listMine,
      turnMineOn: io.turnMineOn,
      requestAccess: io.requestAccess,
      listOwnAccess: io.listOwnAccess,
    },
  }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_cfg: unknown, handler: (ctx: unknown, req: Request, user: unknown) => Promise<Response>) =>
    async (req: Request) => {
      const ctx = { log: { error: vi.fn(), info: vi.fn() } };
      const cfg = _cfg as { auth?: { mode?: string; getSessionUser?: () => Promise<unknown> } };
      if (cfg.auth?.mode === "required") {
        const user = await cfg.auth.getSessionUser?.();
        if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        return handler(ctx, req, user);
      }
      return handler(ctx, req, undefined);
    },
}));

import { GET as askList, POST as askCreate } from "@/app/api/v1/agent/access-requests/route";
import { DELETE, GET, POST } from "@/app/api/v1/agent-access/mine/route";
import { POST as preview } from "@/app/api/v1/agent-access/mine/preview/route";

const mine = "http://0.0.0.0:3000/api/v1/agent-access/mine";
const ownOrigin = { origin: "https://poly.example", host: "poly.example" };
const write = (method: string, headers: Record<string, string> = {}, body: unknown = { token: "x".repeat(43) }) =>
  new Request(mine, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  io.sessionUser.mockResolvedValue({ id: "person-fixture" });
  io.agentUser.mockResolvedValue({ id: "agent-fixture" });
  io.listMine.mockResolvedValue({ permissions: [], more: 0 });
  io.turnMineOn.mockResolvedValue({ changed: true });
});

describe("/api/v1/agent-access/mine (human plane)", () => {
  it("lists the signed-in person's own table", async () => {
    const res = await GET(new Request(mine));
    expect(res.status).toBe(200);
    expect(io.listMine).toHaveBeenCalledWith("person-fixture");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["GET", () => GET(new Request(mine, { headers: { authorization: "Bearer cogni_ag_sk_v1_x" } }))],
    ["POST", () => POST(write("POST", { authorization: "Bearer cogni_ag_sk_v1_x", ...ownOrigin }))],
    ["DELETE", () => DELETE(write("DELETE", { authorization: "Bearer cogni_ag_sk_v1_x", ...ownOrigin }))],
    ["preview", () => preview(write("POST", { authorization: "Bearer cogni_ag_sk_v1_x", ...ownOrigin }))],
  ])("refuses a bearer on %s with 403 human_session_required before any read or write", async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "human_session_required" });
    expect(io.sessionUser).not.toHaveBeenCalled();
    expect(io.listMine).not.toHaveBeenCalled();
    expect(io.turnMineOn).not.toHaveBeenCalled();
  });

  it("401s with no session", async () => {
    io.sessionUser.mockResolvedValue(null);
    const res = await GET(new Request(mine));
    expect(res.status).toBe(401);
    expect(io.listMine).not.toHaveBeenCalled();
  });

  it.each([
    ["a foreign Origin", { origin: "https://evil.example", host: "poly.example" }],
    ["no Origin", { host: "poly.example" }],
  ])("refuses a cookie write with %s and writes nothing", async (_name, headers) => {
    const res = await POST(write("POST", headers));
    expect(res.status).toBe(403);
    expect(io.turnMineOn).not.toHaveBeenCalled();
  });

  it("turns an ask On as the signed-in person (the approver is the session, never the body)", async () => {
    const res = await POST(write("POST", ownOrigin, { token: "t".repeat(43), accountId: "someone-elses" }));
    expect(res.status).toBe(200);
    expect(io.turnMineOn).toHaveBeenCalledTimes(1);
    expect(io.turnMineOn.mock.calls[0]?.[0]).toEqual({ userId: "person-fixture", admin: null });
  });
});

describe("/api/v1/agent/access-requests (AI plane)", () => {
  const ask = (headers: Record<string, string>, body: unknown = { scope: "account:read", principal: "someone-else" }) =>
    new Request("https://poly.example/api/v1/agent/access-requests", {
      method: "POST",
      headers: { "content-type": "application/json", host: "poly.example", ...headers },
      body: JSON.stringify(body),
    });

  it("builds the owner's link from deployment config, never from a request header", async () => {
    io.requestAccess.mockResolvedValue({ state: "pending", created: true, approvalPath: "/profile#agent-request=tok" });
    const res = await askCreate(ask({ authorization: "Bearer cogni_ag_sk_v1_x", host: "evil.example", "x-forwarded-host": "evil.example" }));
    expect(((await res.json()) as { approvalUrl?: string }).approvalUrl).toBe("https://poly.example/profile#agent-request=tok");
  });

  it("asks for the caller itself and returns the owner's one link", async () => {
    io.requestAccess.mockResolvedValue({ state: "pending", created: true, approvalPath: "/profile#agent-request=tok" });
    const res = await askCreate(ask({ authorization: "Bearer cogni_ag_sk_v1_x" }));
    expect(res.status).toBeLessThan(300);
    expect(io.requestAccess).toHaveBeenCalledWith({ principalUserId: "agent-fixture", scope: "account:read" });
    const body = (await res.json()) as { approvalUrl?: string };
    expect(body.approvalUrl).toBe("https://poly.example/profile#agent-request=tok");
  });

  it("answers a browser session with 404, as if the route did not exist for it", async () => {
    const res = await askCreate(ask({}));
    expect(res.status).toBe(404);
    expect(io.requestAccess).not.toHaveBeenCalled();
    const list = await askList(new Request("https://poly.example/api/v1/agent/access-requests"));
    expect(list.status).toBe(404);
    expect(io.listOwnAccess).not.toHaveBeenCalled();
  });
});

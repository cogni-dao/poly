// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/admin-ai-access.route`
 * Purpose: ADMIN_ACTS_IN_ADMIN (task.0116): the node-wide AI access writes pass `requireAdminSession()` (the one mint) and `NodeAdminPort`.
 *   Mint: a key is 403 `human_session_required` before any read, no session 401, non-admin 403 `authz_denied`, admin check down 503
 *   `authz_unavailable`, an admin is minted and one `admin.action` is logged. Route: admin GET 200, POST/DELETE reach the port with the
 *   minted session, non-admin 403 with no port call, and the old `/api/v1/agent-access/roles` route is gone (404).
 * Scope: The real route handlers and mint with a fake container and session; no database, no network.
 * Invariants: ONE_MINT; HUMAN_ROUTES_SESSION_ONLY; FAIL_CLOSED_WITH_DISTINCTION; NO_NEW_AUTHORITY (the port is called, the route decides nothing).
 * Side-effects: none
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  user: null as unknown,
  check: vi.fn(),
  list: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  dismiss: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request) => Promise<NextResponse>) =>
    (request: Request) =>
      handler({ log: fake.log }, request),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn(async () => fake.user) }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: fake.log,
    nodeAdmin: { check: fake.check },
    nodeAdminPort: { listNodeAi: fake.list, turnAiPermissionOn: fake.on, turnAiPermissionOff: fake.off, dismissAiRequest: fake.dismiss },
  }),
}));

import { requireAdminSession } from "@/app/(admin)/_lib/admin-session";
import { DELETE, GET, POST } from "@/app/api/v1/admin/ai-access/route";

const URL_ = "http://localhost/api/v1/admin/ai-access";
const sessionUser = (id: string, via: "session" | "bearer" = "session") => ({ id, walletAddress: `0x${id}`, displayName: null, avatarColor: null, via });
const send = (handler: typeof POST, body: unknown, headers: Record<string, string> = {}) =>
  handler(new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), undefined as never);
const get = (headers: Record<string, string> = {}) => GET(new NextRequest(URL_, { headers }), undefined as never);
const body = { principal: "prioritizer", scope: "work_item:transition" };

beforeEach(() => {
  vi.clearAllMocks();
  fake.user = sessionUser("admin-1");
  fake.check.mockResolvedValue({ ok: true });
  fake.list.mockResolvedValue({ permissions: [], more: 0 });
  fake.on.mockResolvedValue({ principalUserId: "agent-1", changed: true });
  fake.off.mockResolvedValue({ principalUserId: "agent-1", changed: true });
  fake.dismiss.mockResolvedValue({ principalUserId: "agent-1", changed: true });
});

describe("requireAdminSession (the one mint)", () => {
  const mint = () => requireAdminSession(new Request(URL_), "ai_access.test");

  it("mints for a session the node-admin check approves, and logs one admin.action with the action and admin id", async () => {
    const result = await mint();
    expect(result.ok && result.session.userId).toBe("admin-1");
    expect(fake.check).toHaveBeenCalledWith({ userId: "admin-1", walletAddress: "0xadmin-1" });
    expect(fake.log.info).toHaveBeenCalledWith(
      { event: "admin.action", action: "ai_access.test", adminUserId: "admin-1" },
      "admin.action"
    );
  });

  it("refuses any Authorization header with 403 human_session_required before reading the session or the admin check", async () => {
    const result = await requireAdminSession(new Request(URL_, { headers: { authorization: "Bearer cogni_ag_sk_v1_x" } }), "ai_access.test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toMatchObject({ code: "human_session_required" });
    }
    expect(fake.check).not.toHaveBeenCalled();
  });

  it("fails closed with distinction: no session 401, a bearer identity 401, non-admin 403, check down 503, a throwing check 503", async () => {
    fake.user = null;
    expect((await mint()).ok).toBe(false);
    const status = async () => {
      const r = await mint();
      return r.ok ? 200 : r.response.status;
    };
    expect(await status()).toBe(401);
    fake.user = sessionUser("agent-1", "bearer");
    expect(await status()).toBe(401);
    fake.user = sessionUser("member-1");
    fake.check.mockResolvedValue({ ok: false, errorCode: "authz_denied" });
    expect(await status()).toBe(403);
    fake.check.mockResolvedValue({ ok: false, errorCode: "authz_unavailable", reason: "no_node_admins_configured" });
    expect(await status()).toBe(503);
    fake.check.mockRejectedValue(new Error("down"));
    expect(await status()).toBe(503);
    expect(fake.log.info).not.toHaveBeenCalledWith(expect.objectContaining({ event: "admin.action" }), "admin.action");
  });
});

describe("/api/v1/admin/ai-access", () => {
  it("admin session: GET 200 with canManage true and no-store; POST turns On, DELETE turns Off, DELETE deny dismisses, each with the minted session", async () => {
    const list = await get();
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toEqual({ canManage: true, permissions: [], more: 0 });
    const session = expect.objectContaining({ userId: "admin-1" });
    const target = { ref: { principalSlug: "prioritizer" }, scope: "work_item:transition" };

    const on = await send(POST, body);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ principal: "prioritizer", scope: "work_item:transition", principalUserId: "agent-1", changed: true });
    expect(fake.on).toHaveBeenCalledWith(session, target);

    expect((await send(DELETE, body)).status).toBe(200);
    expect(fake.off).toHaveBeenCalledWith(session, target);
    expect((await send(DELETE, { ...body, deny: true })).status).toBe(200);
    expect(fake.dismiss).toHaveBeenCalledWith(session, target);
  });

  it("non-admin: GET, POST and DELETE are 403 authz_denied and the port is never called", async () => {
    fake.user = sessionUser("member-1");
    fake.check.mockResolvedValue({ ok: false, errorCode: "authz_denied" });
    for (const res of [await get(), await send(POST, body), await send(DELETE, body)]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "authz_denied" });
    }
    for (const port of [fake.list, fake.on, fake.off, fake.dismiss]) expect(port).not.toHaveBeenCalled();
  });

  it("a key is 403 human_session_required on every verb, even the admin's own, and the port is never called", async () => {
    for (const res of [
      await get({ authorization: "Bearer cogni_ag_sk_v1_x" }),
      await send(POST, body, { authorization: "Bearer cogni_ag_sk_v1_x" }),
      await send(DELETE, body, { authorization: "Basic nope" }),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "human_session_required" });
    }
    for (const port of [fake.list, fake.on, fake.off, fake.dismiss]) expect(port).not.toHaveBeenCalled();
  });

  it("the old /api/v1/agent-access/roles route is gone (404), and so is any bearer route that could turn a permission On or Off", () => {
    const app = resolve(__dirname, "../../../../src/app/api/v1");
    expect(existsSync(resolve(app, "agent-access/roles/route.ts"))).toBe(false);
    expect(existsSync(resolve(app, "agent/roles/route.ts"))).toBe(false);
  });
});

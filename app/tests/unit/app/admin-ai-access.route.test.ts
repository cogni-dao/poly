// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real resolver, sole mint, port and published grant policy; only IO is faked. */
import type { AgentGrantsStore, WithStore } from "@cogni/agent-grants";
import { NextRequest } from "next/server";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  headers: new Headers(),
  session: vi.fn(),
  container: vi.fn(),
  fallbackLog: vi.fn(),
  getToken: vi.fn(),
  auth: {
    authSecret: "unit-test-only",
    authOptions: { secret: "unit-test-only" },
  },
}));
vi.mock("next-auth/jwt", () => ({
  getToken: (...args: unknown[]) => io.getToken(...args),
}));
vi.mock("@/auth", () => io.auth);
vi.mock("@/shared/config", () => ({ getNodeId: () => "test-node" }));
vi.mock("next/headers", () => ({ headers: async () => io.headers }));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: () => io.session(),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => io.container(),
}));
vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({ AUTH_SECRET: "unit-test-only" }),
}));

vi.mock("@/shared/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/observability")>()),
  makeLogger: () => io.fallbackLog(),
}));

import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import {
  DELETE as deletePermission,
  GET as getPermissions,
  POST as postPermission,
} from "@/app/api/v1/admin/ai-access/route";
import { createNodeAdminPort } from "@/bootstrap/node-admin-port";
import { proxy } from "@/proxy";

const PRINCIPAL = "00000000-0000-4000-a000-0000000a0001";
const SCOPE = "sandbox:exec";
const ADMIN = "admin-fixture";
const records: Record<string, unknown>[] = [];
const log = pino(
  { level: "info" },
  {
    write: (line: string) => {
      records.push(JSON.parse(line));
    },
  },
);

async function audited(
  handler: (request: Request) => Promise<Response>,
  req: NextRequest,
) {
  const before = records.filter(
    (r) => r.event === "ai_permission.complete",
  ).length;
  const beforeRecords = records.length;
  io.headers = req.headers;
  const perimeter = await proxy(req);
  const response =
    perimeter.headers.get("x-middleware-next") === "1"
      ? await handler(req)
      : perimeter;
  expect(
    records
      .slice(beforeRecords)
      .filter((r) => r.event === "auth.perimeter.denied"),
  ).toHaveLength(0);
  expect(records.length - beforeRecords).toBeLessThanOrEqual(3);
  const terminal = records.filter((r) => r.event === "ai_permission.complete");
  expect(terminal).toHaveLength(before + 1);
  const event = terminal.at(-1);
  const body = await response.clone().json();
  expect(event).toMatchObject({
    reqId: response.headers.get("x-request-id"),
    routeId: "admin.ai-access",
    operation:
      req.method === "GET" ? "list" : req.method === "POST" ? "on" : "off",
    principalSlug: "node-ai",
    resource: "node",
    scope: SCOPE,
    status: response.status,
    errorCode:
      response.status < 400
        ? null
        : response.status === 401
          ? "unauthorized"
          : body.error,
    outcome:
      response.status < 400
        ? "success"
        : response.status === 503
          ? "unavailable"
          : response.status === 400
            ? "invalid"
            : "denied",
    durationMs: expect.any(Number),
    reason: expect.any(String),
  });
  expect(event?.reqId).toMatch(/^[0-9a-f-]{36}$/);
  expect(event?.reqId).not.toBe("caller-correlation");
  expect(terminal.slice(0, -1).map((entry) => entry.reqId)).not.toContain(
    event?.reqId,
  );
  expect(event?.durationMs).toBeGreaterThanOrEqual(0);
  expect(event).not.toHaveProperty("principalUserId");
  expect(JSON.stringify(event)).not.toMatch(
    /secret SQL details|forged|outside|Bearer|0xfixture|caller-correlation|body-actor/,
  );
  if (response.status === 401) expect(event?.actorUserId).toBeNull();
  return response;
}
const GET = (req: NextRequest) => audited(getPermissions, req);
const POST = (req: NextRequest) => audited(postPermission, req);
const DELETE = (req: NextRequest) => audited(deletePermission, req);

const adminCheck = vi.fn();
const findInternalPrincipal = vi.fn();
const hasLiveRole = vi.fn();
const approvePending = vi.fn();
const insertRole = vi.fn();
const revokeRole = vi.fn();
const storeMethods = {
  findInternalPrincipal,
  hasLiveRole,
  approvePending,
  insertRole,
  revokeRole,
};
// Any accidental list/account read fails this test; no policy logic is reproduced.
const store = new Proxy({} as AgentGrantsStore, {
  get: (_target, key) => {
    if (typeof key === "string" && key in storeMethods)
      return storeMethods[key as keyof typeof storeMethods];
    throw new Error(`unexpected store method: ${String(key)}`);
  },
});
const withStore: WithStore = async (fn) => fn(store);

function request(
  method: string,
  body?: unknown,
  options: {
    userId?: string;
    bearer?: boolean;
    origin?: string | null;
    url?: string;
  } = {},
) {
  const userId = options.userId ?? ADMIN;
  const headers = new Headers({
    host: "red.example",
    "content-type": "application/json",
    "x-request-id": "caller-correlation",
  });
  if (options.origin !== null)
    headers.set("origin", options.origin ?? "https://red.example");
  if (options.bearer)
    headers.set(
      "authorization",
      `Bearer ${issueAgentApiKey({ userId, displayName: "Fixture" })}`,
    );
  io.headers = headers;
  io.session.mockResolvedValue({
    id: userId,
    walletAddress: "0xfixture",
    displayName: "Fixture",
    avatarColor: null,
  });
  return new NextRequest(
    options.url ?? "https://red.example/api/v1/admin/ai-access",
    {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  );
}

const target = { principalUserId: PRINCIPAL, scope: SCOPE };

beforeEach(() => {
  vi.clearAllMocks();
  io.auth.authSecret = "unit-test-only";
  io.auth.authOptions.secret = "unit-test-only";
  io.getToken.mockResolvedValue({ id: ADMIN });
  records.length = 0;
  io.fallbackLog.mockReturnValue(log);
  adminCheck.mockImplementation(async (id: string) =>
    id === ADMIN ? "allow" : "denied",
  );
  findInternalPrincipal.mockResolvedValue({ userId: PRINCIPAL });
  hasLiveRole.mockResolvedValue(false);
  approvePending.mockResolvedValue(false);
  insertRole.mockResolvedValue(true);
  revokeRole.mockResolvedValue(true);
  io.container.mockReturnValue({
    log,
    agentAuthority: { guardDeps: { adminCheck, withStore } },
    nodeAdminPort: createNodeAdminPort(withStore, log),
  });
});

describe("internal AI permission HTTP and port composition", () => {
  it.each(["GET", "POST", "DELETE"])(
    "retains handler refusals across the perimeter for %s",
    async (method) => {
      const handler =
        method === "GET"
          ? getPermissions
          : method === "POST"
            ? postPermission
            : deletePermission;
      const req = () => request(method, method === "GET" ? undefined : target);
      adminCheck.mockResolvedValueOnce("denied");
      expect((await audited(handler, req())).status).toBe(403);
      adminCheck.mockResolvedValueOnce("unavailable");
      expect((await audited(handler, req())).status).toBe(503);
      adminCheck.mockRejectedValueOnce(new Error("secret SQL details"));
      expect((await audited(handler, req())).status).toBe(503);
      findInternalPrincipal.mockRejectedValueOnce(
        new Error("secret SQL details"),
      );
      expect((await audited(handler, req())).status).toBe(503);
      if (method === "DELETE") {
        revokeRole.mockRejectedValueOnce(new Error("secret SQL details"));
        expect((await audited(handler, req())).status).toBe(503);
      }
    },
  );

  it.each(["POST", "DELETE"])(
    "refuses malformed JSON, content type and origin for %s",
    async (method) => {
      const handler = method === "POST" ? postPermission : deletePermission;
      const malformed = request(method, target);
      const invalidJson = new NextRequest(malformed.url, {
        method,
        headers: malformed.headers,
        body: "{",
      });
      expect((await audited(handler, invalidJson)).status).toBe(400);
      const wrongType = request(method, target);
      wrongType.headers.set("content-type", "text/plain");
      expect((await audited(handler, wrongType)).status).toBe(400);
      expect(
        (await audited(handler, request(method, target, { origin: null })))
          .status,
      ).toBe(403);
      expect(records.at(-1)).toMatchObject({
        reason: "origin_refused",
        actorUserId: ADMIN,
      });
      expect(insertRole).not.toHaveBeenCalled();
      expect(revokeRole).not.toHaveBeenCalled();
    },
  );

  it("leaves valid machine bearer verification to the handler even without perimeter secret", async () => {
    const req = request("POST", target, { bearer: true, origin: null });
    io.auth.authSecret = "";
    io.auth.authOptions.secret = "";
    expect((await POST(req)).status).toBe(200);
    expect(io.getToken).not.toHaveBeenCalled();
    expect(adminCheck).toHaveBeenCalledWith(ADMIN);
  });

  it.each(["GET", "POST", "DELETE"])(
    "completes perimeter denials once for %s",
    async (method) => {
      for (const reason of [
        "no_session",
        "no_auth_secret",
        "malformed_bearer",
        "auth_resolution_unavailable",
      ]) {
        const req = request(method, method === "GET" ? undefined : target);
        io.auth.authSecret =
          reason === "no_auth_secret" ? "" : "unit-test-only";
        io.auth.authOptions.secret = io.auth.authSecret;
        io.getToken.mockResolvedValue(null);
        if (reason === "malformed_bearer")
          req.headers.set("authorization", "Bearer malformed-secret");
        if (reason === "auth_resolution_unavailable")
          io.getToken.mockRejectedValueOnce(new Error("secret SQL details"));
        const res = await audited(
          method === "GET"
            ? getPermissions
            : method === "POST"
              ? postPermission
              : deletePermission,
          req,
        );
        expect(res.status).toBe(
          reason === "auth_resolution_unavailable" ? 503 : 401,
        );
        expect(records.at(-1)).toMatchObject({
          actorUserId: null,
          reason: reason === "malformed_bearer" ? "no_session" : reason,
        });
      }
      expect(io.session).not.toHaveBeenCalled();
      expect(adminCheck).not.toHaveBeenCalled();
      expect(findInternalPrincipal).not.toHaveBeenCalled();
    },
  );

  it.each(["GET", "POST", "DELETE"])(
    "passes prefixed invalid bearer to the real handler for %s",
    async (method) => {
      const req = request(method, method === "GET" ? undefined : target);
      req.headers.set("authorization", "Bearer cogni_ag_sk_v1_invalid.secret");
      io.headers = req.headers;
      const res = await audited(
        method === "GET"
          ? getPermissions
          : method === "POST"
            ? postPermission
            : deletePermission,
        req,
      );
      expect(res.status).toBe(401);
      expect(io.getToken).not.toHaveBeenCalled();
      expect(io.session).not.toHaveBeenCalled();
      expect(adminCheck).not.toHaveBeenCalled();
    },
  );

  it("lists exactly the internal node permission from a fresh live-role boolean", async () => {
    const first = await GET(request("GET"));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toMatchObject({
      canManage: true,
      more: 0,
      permissions: [
        {
          ...target,
          section: "node",
          resource: "node",
          outside: false,
          on: false,
        },
      ],
    });
    hasLiveRole.mockResolvedValueOnce(true);
    const second = await GET(request("GET"));
    const body = await second.json();
    expect(body.permissions).toHaveLength(1);
    expect(body.permissions[0].on).toBe(true);
    expect(hasLiveRole).toHaveBeenCalledWith(PRINCIPAL, SCOPE);
    expect(findInternalPrincipal).toHaveBeenCalledWith("node-ai");
    expect(insertRole).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses the same authenticated admin for cookie/bearer On and Off (bearer=%s)",
    async (bearer) => {
      const on = await POST(request("POST", target, { bearer }));
      expect(on.status).toBe(200);
      expect(await on.json()).toEqual({ changed: true });
      expect(insertRole).toHaveBeenCalledWith({
        principalUserId: PRINCIPAL,
        scope: SCOPE,
        approvedBy: ADMIN,
      });
      const off = await DELETE(request("DELETE", target, { bearer }));
      expect(off.status).toBe(200);
      expect(await off.json()).toEqual({ changed: true });
      expect(revokeRole).toHaveBeenCalledWith({
        principalUserId: PRINCIPAL,
        scope: SCOPE,
      });
      expect(adminCheck).toHaveBeenNthCalledWith(1, ADMIN);
      expect(adminCheck).toHaveBeenNthCalledWith(2, ADMIN);
      expect(
        records
          .filter((r) => r.event === "ai_permission.complete")
          .map((r) => r.actorUserId),
      ).toEqual([ADMIN, ADMIN]);
      expect(
        records.filter((r) => r.event === "admin.action").map((r) => r.reqId),
      ).toEqual(
        records
          .filter((r) => r.event === "ai_permission.complete")
          .map((r) => r.reqId),
      );
    },
  );

  it.each([false, true])(
    "refuses a nonadmin before any permission read/write (bearer=%s)",
    async (bearer) => {
      const res = await POST(
        request("POST", target, { bearer, userId: "member" }),
      );
      expect(res.status).toBe(403);
      expect(findInternalPrincipal).not.toHaveBeenCalled();
      expect(insertRole).not.toHaveBeenCalled();
      expect(
        records.find((r) => r.event === "ai_permission.complete")?.actorUserId,
      ).toBe("member");
    },
  );

  it("refuses missing identity and invalid bearer without cookie fallback", async () => {
    const req = request("GET");
    io.session.mockResolvedValueOnce(null);
    expect((await GET(req)).status).toBe(401);
    const bad = request("POST", target);
    io.headers.set("authorization", "Bearer invalid");
    bad.headers.set("authorization", "Bearer invalid");
    expect((await POST(bad)).status).toBe(401);
    expect(adminCheck).not.toHaveBeenCalled();
  });

  it.each(["https://foreign.example", null])(
    "refuses cookie writes with unsafe/missing origin %s",
    async (origin) => {
      expect(
        (await POST(request("POST", target, { origin }))).status,
      ).toBeGreaterThanOrEqual(400);
      expect(insertRole).not.toHaveBeenCalled();
    },
  );

  it("accepts a cookie write whose origin matches the ingress host, not the in-pod url", async () => {
    const req = request("POST", target, {
      url: "http://0.0.0.0:3000/api/v1/admin/ai-access",
    });
    expect((await POST(req)).status).toBeLessThan(300);
    expect(insertRole).toHaveBeenCalled();
  });

  it.each([
    { ...target, scope: "account:read" },
    { ...target, scope: "unknown" },
    { ...target, approvedBy: "forged", actorUserId: "body-actor" },
    { ...target, admin: true },
    { ...target, reqId: "caller-correlation" },
    { ...target, accountId: "foreign" },
    { ...target, deny: true },
  ])(
    "refuses unsupported or caller-authority fields before store IO: %j",
    async (body) => {
      expect((await POST(request("POST", body))).status).toBe(400);
      expect(findInternalPrincipal).not.toHaveBeenCalled();
      expect(insertRole).not.toHaveBeenCalled();
    },
  );

  it("refuses a foreign principal before either published writer", async () => {
    expect(
      (await POST(request("POST", { ...target, principalUserId: "outside" })))
        .status,
    ).toBe(403);
    expect(
      (
        await DELETE(
          request("DELETE", { ...target, principalUserId: "outside" }),
        )
      ).status,
    ).toBe(403);
    expect(approvePending).not.toHaveBeenCalled();
    expect(insertRole).not.toHaveBeenCalled();
    expect(revokeRole).not.toHaveBeenCalled();
  });

  it("keeps published NO_SELF_APPROVAL on both On and Off", async () => {
    adminCheck.mockResolvedValue("allow");
    expect(
      (await POST(request("POST", target, { bearer: true, userId: PRINCIPAL })))
        .status,
    ).toBe(403);
    expect(
      (
        await DELETE(
          request("DELETE", target, { bearer: true, userId: PRINCIPAL }),
        )
      ).status,
    ).toBe(403);
    expect(insertRole).not.toHaveBeenCalled();
    expect(revokeRole).not.toHaveBeenCalled();
  });

  it("preserves idempotent published On/Off results", async () => {
    insertRole.mockResolvedValue(false);
    revokeRole.mockResolvedValue(false);
    expect(await (await POST(request("POST", target))).json()).toEqual({
      changed: false,
    });
    expect(await (await DELETE(request("DELETE", target))).json()).toEqual({
      changed: false,
    });
  });

  it("fails closed on unavailable admin config, principal and grant store", async () => {
    adminCheck.mockResolvedValueOnce("unavailable");
    expect((await POST(request("POST", target))).status).toBe(503);
    findInternalPrincipal.mockResolvedValueOnce(null);
    expect((await GET(request("GET"))).status).toBe(503);
    hasLiveRole.mockRejectedValueOnce(new Error("secret SQL details"));
    const res = await GET(request("GET"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authz_unavailable" });
    insertRole.mockRejectedValueOnce(new Error("secret SQL details"));
    expect((await POST(request("POST", target))).status).toBe(503);
    expect(revokeRole).not.toHaveBeenCalled();
    adminCheck.mockRejectedValueOnce(new Error("secret SQL details"));
    expect((await DELETE(request("DELETE", target))).status).toBe(503);
    expect(
      records.filter((r) => r.event === "ai_permission.complete").at(-1),
    ).toMatchObject({ actorUserId: ADMIN, reason: "admin_check_unavailable" });
    io.session.mockRejectedValueOnce(new Error("secret SQL details"));
    expect((await GET(request("GET"))).status).toBe(503);
    expect(
      records.filter((r) => r.event === "ai_permission.complete").at(-1),
    ).toMatchObject({ actorUserId: null, reason: "identity_unavailable" });
    io.container.mockImplementation(() => {
      throw new Error("secret SQL details");
    });
    expect((await GET(request("GET"))).status).toBe(503);
    expect(
      records.filter((r) => r.event === "ai_permission.complete").at(-1),
    ).toMatchObject({ actorUserId: ADMIN, reason: "admin_check_unavailable" });
  });
});

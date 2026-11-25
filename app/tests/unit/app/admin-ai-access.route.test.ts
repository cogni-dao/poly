// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Admin AI access route over the real admin mint and the real `createNodeAdminPort`; only the authority's IO is faked.
 * Defects named: (1) the route accepted one hard-coded scope instead of every declared scope; (2) the cookie origin check compared
 * against `request.url`, which is the in-pod bind address behind the ingress, so every admin click answered 403.
 */
import { AgentRolesError } from "@cogni/agent-grants";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ session: vi.fn(), container: vi.fn() }));
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: () => io.session(),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => io.container(),
}));

import {
  DELETE as deletePermission,
  GET as getPermissions,
  POST as postPermission,
} from "@/app/api/v1/admin/ai-access/route";
import { createNodeAdminPort } from "@/bootstrap/node-admin-port";

const ADMIN = "admin-fixture";
const NODE_AI = "00000000-0000-4000-a000-0000000a0001";
const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: () => log };
const authority = {
  adminCheck: vi.fn(),
  listNodeAi: vi.fn(),
  grantRole: vi.fn(),
  revokeRole: vi.fn(),
  denyRequest: vi.fn(),
  previewAsk: vi.fn(),
};

function request(
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  io.session.mockResolvedValue({ id: ADMIN, walletAddress: "0xfixture" });
  return new NextRequest("http://0.0.0.0:3000/api/v1/admin/ai-access", {
    method,
    headers: {
      "content-type": "application/json",
      host: "poly.example",
      "x-forwarded-host": "poly.example",
      origin: "https://poly.example",
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authority.adminCheck.mockImplementation(async (id: string) =>
    id === ADMIN ? "allow" : "denied",
  );
  authority.listNodeAi.mockResolvedValue({ permissions: [], more: 0 });
  authority.grantRole.mockResolvedValue({
    principalUserId: NODE_AI,
    created: true,
  });
  authority.revokeRole.mockResolvedValue({
    principalUserId: NODE_AI,
    revoked: true,
  });
  authority.denyRequest.mockResolvedValue({
    principalUserId: NODE_AI,
    denied: true,
  });
  io.container.mockReturnValue({
    log,
    config: { unhandledErrorPolicy: "rethrow" },
    clock: { now: () => new Date(), toISOString: () => new Date().toISOString() },
    agentAuthority: authority,
    nodeAdminPort: createNodeAdminPort(authority as never),
  });
});

describe("admin AI access route", () => {
  it.each(["sandbox:exec", "schedule:manage"])(
    "turns the declared scope %s On and Off",
    async (scope) => {
      const body = { principalUserId: NODE_AI, scope };
      const on = await postPermission(request("POST", body));
      expect(on.status).toBe(200);
      expect(authority.grantRole).toHaveBeenCalledWith(
        expect.objectContaining({ principalUserId: NODE_AI, scope }),
      );
      const off = await deletePermission(request("DELETE", body));
      expect(off.status).toBe(200);
      expect(authority.revokeRole).toHaveBeenCalledWith(
        expect.objectContaining({ principalUserId: NODE_AI, scope }),
      );
    },
  );

  it("leaves the undeclared-scope refusal to the authority and answers 400", async () => {
    authority.grantRole.mockRejectedValue(
      new AgentRolesError("invalid_scope", "undeclared scope"),
    );
    const res = await postPermission(
      request("POST", { principalUserId: NODE_AI, scope: "vcs:merge_pr" }),
    );
    expect(res.status).toBe(400);
  });

  it("dismisses a pending ask with deny: true", async () => {
    const res = await deletePermission(
      request("DELETE", {
        principalUserId: "outside-agent",
        scope: "schedule:manage",
        deny: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(authority.denyRequest).toHaveBeenCalled();
    expect(authority.revokeRole).not.toHaveBeenCalled();
  });

  it("lists for an admin and refuses everyone else before any read", async () => {
    expect((await getPermissions(request("GET"))).status).toBe(200);
    authority.adminCheck.mockResolvedValue("denied");
    authority.listNodeAi.mockClear();
    expect((await getPermissions(request("GET"))).status).toBe(403);
    authority.adminCheck.mockResolvedValue("unavailable");
    expect((await getPermissions(request("GET"))).status).toBe(503);
    expect(authority.listNodeAi).not.toHaveBeenCalled();
  });

  it("compares Origin to the public host, never to request.url", async () => {
    const body = { principalUserId: NODE_AI, scope: "sandbox:exec" };
    // request.url is the in-pod bind address; the public Origin matches x-forwarded-host.
    expect((await postPermission(request("POST", body))).status).toBe(200);
    authority.grantRole.mockClear();
    const foreign = await postPermission(
      request("POST", body, { origin: "https://evil.example" }),
    );
    expect(foreign.status).toBe(403);
    expect(authority.grantRole).not.toHaveBeenCalled();
    const missing = request("POST", body);
    missing.headers.delete("origin");
    expect((await postPermission(missing)).status).toBe(403);
  });
});

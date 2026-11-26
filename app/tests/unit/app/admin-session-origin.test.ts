// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Behind the ingress `request.url` is the in-pod address: a cookie write is judged by Origin vs the public host. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  user: vi.fn(),
  adminCheck: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: () => io.user(),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    agentAuthority: { adminCheck: io.adminCheck },
    log: { info: io.info },
  }),
}));

import { requireAdminSession } from "@/app/(admin)/_lib/admin-session";

const req = (method: string, headers: Record<string, string>) =>
  new Request("http://0.0.0.0:3000/api/v1/admin/ai-access", {
    method,
    headers,
  });

beforeEach(() => {
  vi.clearAllMocks();
  io.user.mockResolvedValue({ id: "admin-fixture" });
  io.adminCheck.mockResolvedValue("allow");
});

describe("requireAdminSession origin", () => {
  it("accepts a cookie write whose Origin is the forwarded public host", async () => {
    const result = await requireAdminSession(
      req("POST", {
        origin: "https://red.example",
        "x-forwarded-host": "red.example",
        host: "0.0.0.0:3000",
      }),
      "ai_access.on",
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    { origin: "https://foreign.example", host: "red.example" },
    { host: "red.example" },
  ])("refuses a cookie write with a foreign or missing Origin %j", async (headers) => {
    const result = await requireAdminSession(
      req("POST", headers),
      "ai_access.on",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(io.adminCheck).not.toHaveBeenCalled();
  });

  it("lets a bearer write and a cookie read through to the one admin check", async () => {
    expect(
      (
        await requireAdminSession(
          req("POST", { authorization: "Bearer token", host: "red.example" }),
          "ai_access.on",
        )
      ).ok,
    ).toBe(true);
    expect(
      (await requireAdminSession(req("GET", { host: "red.example" }), "x")).ok,
    ).toBe(true);
    expect(io.adminCheck).toHaveBeenCalledTimes(2);
  });
});

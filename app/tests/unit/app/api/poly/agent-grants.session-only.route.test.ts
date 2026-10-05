// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/poly/agent-grants.session-only.route`
 * Purpose: Prove machine Bearer transport cannot invoke owner grant lifecycle.
 * Scope: Route auth wiring only; facade and persistence are mocked.
 * Invariants: GET/POST/DELETE all require a browser server session.
 * Side-effects: none
 * @internal
 */

import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";

const getServerSessionUser = vi.fn().mockResolvedValue(null);
const listAgentGrantsFacade = vi.fn();
const createAgentGrantFacade = vi.fn();
const revokeAgentGrantFacade = vi.fn();

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: (...args: unknown[]) =>
    getServerSessionUser(...args),
}));

vi.mock("@/app/_facades/poly/agent-grants.server", () => ({
  AgentGrantFacadeError: class AgentGrantFacadeError extends Error {},
  listAgentGrantsFacade: (...args: unknown[]) =>
    listAgentGrantsFacade(...args),
  createAgentGrantFacade: (...args: unknown[]) =>
    createAgentGrantFacade(...args),
  revokeAgentGrantFacade: (...args: unknown[]) =>
    revokeAgentGrantFacade(...args),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      config: {
        auth: { getSessionUser: () => Promise<unknown> };
      },
      handler: (...args: unknown[]) => Promise<NextResponse>
    ) =>
    async (request: NextRequest, context?: unknown) => {
      const sessionUser = await config.auth.getSessionUser();
      if (!sessionUser) {
        return NextResponse.json({ error: "Session required" }, { status: 401 });
      }
      return handler(
        { log: { info: vi.fn() } },
        request,
        sessionUser,
        context
      );
    },
}));

import {
  GET,
  POST,
} from "@/app/api/v1/poly/agent-grants/route";
import { DELETE } from "@/app/api/v1/poly/agent-grants/[id]/route";

const bearerHeaders = {
  authorization: "Bearer cogni_ag_sk_v1_machine-token",
  "content-type": "application/json",
};

describe("owner agent grant routes are browser-session-only", () => {
  it("denies bearer GET and POST before invoking the facade", async () => {
    const getResponse = await GET(
      new NextRequest("http://localhost/api/v1/poly/agent-grants", {
        headers: bearerHeaders,
      })
    );
    const postResponse = await POST(
      new NextRequest("http://localhost/api/v1/poly/agent-grants", {
        method: "POST",
        headers: bearerHeaders,
        body: JSON.stringify({}),
      })
    );

    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
    expect(listAgentGrantsFacade).not.toHaveBeenCalled();
    expect(createAgentGrantFacade).not.toHaveBeenCalled();
  });

  it("denies bearer DELETE before invoking the facade", async () => {
    const response = await DELETE(
      new NextRequest(
        "http://localhost/api/v1/poly/agent-grants/30000000-0000-4000-b000-000000000001",
        { method: "DELETE", headers: bearerHeaders }
      ),
      {
        params: Promise.resolve({
          id: "30000000-0000-4000-b000-000000000001",
        }),
      }
    );

    expect(response.status).toBe(401);
    expect(revokeAgentGrantFacade).not.toHaveBeenCalled();
  });
});

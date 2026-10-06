// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/poly/agent-access-requests.auth-boundary.route`
 * Purpose: Pin transport separation between machine list/request/poll and
 *   human decisions.
 * Scope: Route auth wiring only; facades and persistence are mocked.
 * Invariants: sessions cannot list/create/poll; bearers cannot use owner
 *   list/preview/decision routes.
 * Side-effects: none
 * @internal
 */

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_USER = {
  id: "10000000-0000-4000-a000-000000000001",
  walletAddress: null,
  displayName: "Human owner",
  avatarColor: null,
};
const getRequestIdentity = vi.fn().mockResolvedValue(SESSION_USER);
const getServerSessionUser = vi.fn().mockResolvedValue(null);
const createFacade = vi.fn();
const agentListFacade = vi.fn();
const pollFacade = vi.fn();
const listFacade = vi.fn();
const previewFacade = vi.fn();
const decisionFacade = vi.fn();

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: (...args: unknown[]) => getRequestIdentity(...args),
}));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: (...args: unknown[]) =>
    getServerSessionUser(...args),
}));
vi.mock("@/app/_facades/poly/agent-access-requests.server", () => ({
  AgentAccessRequestFacadeError: class AgentAccessRequestFacadeError extends Error {},
  createAgentAccessRequestFacade: (...args: unknown[]) =>
    createFacade(...args),
  listAgentAccessRequestsFacade: (...args: unknown[]) =>
    agentListFacade(...args),
  pollAgentAccessRequestFacade: (...args: unknown[]) => pollFacade(...args),
  listOwnerAgentAccessRequestsFacade: (...args: unknown[]) =>
    listFacade(...args),
  previewAgentAccessRequestFacade: (...args: unknown[]) =>
    previewFacade(...args),
  decideAgentAccessRequestFacade: (...args: unknown[]) =>
    decisionFacade(...args),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      config: { auth: { getSessionUser: () => Promise<unknown> } },
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
  GET as AGENT_LIST,
  POST as CREATE,
} from "@/app/api/v1/agent/access-requests/route";
import { GET as POLL } from "@/app/api/v1/agent/access-requests/[id]/route";
import { GET as OWNER_LIST } from "@/app/api/v1/poly/agent-access-requests/route";
import { POST as OWNER_PREVIEW } from "@/app/api/v1/poly/agent-access-requests/preview/route";
import { POST as OWNER_DECISION } from "@/app/api/v1/poly/agent-access-requests/[id]/decision/route";

const REQUEST_ID = "30000000-0000-4000-b000-000000000001";
const TOKEN = "a".repeat(43);

describe("agent access request auth boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects cookie/session transport on agent create, list, and poll", async () => {
    const createResponse = await CREATE(
      new NextRequest("http://localhost/api/v1/agent/access-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expires_at: "2026-10-20T00:00:00.000Z" }),
      })
    );
    const listResponse = await AGENT_LIST(
      new NextRequest("http://localhost/api/v1/agent/access-requests")
    );
    const pollResponse = await POLL(
      new NextRequest(
        `http://localhost/api/v1/agent/access-requests/${REQUEST_ID}`
      ),
      { params: Promise.resolve({ id: REQUEST_ID }) }
    );

    expect(createResponse.status).toBe(404);
    expect(listResponse.status).toBe(404);
    expect(pollResponse.status).toBe(404);
    expect(createFacade).not.toHaveBeenCalled();
    expect(agentListFacade).not.toHaveBeenCalled();
    expect(pollFacade).not.toHaveBeenCalled();
  });

  it("rejects bearer transport on owner list, preview, and decision", async () => {
    const headers = {
      authorization: "Bearer cogni_ag_sk_v1_machine-token",
      "content-type": "application/json",
    };
    const listResponse = await OWNER_LIST(
      new NextRequest("http://localhost/api/v1/poly/agent-access-requests", {
        headers,
      })
    );
    const previewResponse = await OWNER_PREVIEW(
      new NextRequest(
        "http://localhost/api/v1/poly/agent-access-requests/preview",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ approval_token: TOKEN }),
        }
      )
    );
    const decisionResponse = await OWNER_DECISION(
      new NextRequest(
        `http://localhost/api/v1/poly/agent-access-requests/${REQUEST_ID}/decision`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            approval_token: TOKEN,
            decision: "approve",
          }),
        }
      ),
      { params: Promise.resolve({ id: REQUEST_ID }) }
    );

    expect(listResponse.status).toBe(401);
    expect(previewResponse.status).toBe(401);
    expect(decisionResponse.status).toBe(401);
    expect(listFacade).not.toHaveBeenCalled();
    expect(previewFacade).not.toHaveBeenCalled();
    expect(decisionFacade).not.toHaveBeenCalled();
  });

  it("accepts bearer agent transport without trusting a hostile Host", async () => {
    const pending = {
      id: REQUEST_ID,
      scope: "performance:read",
      expires_at: "2026-10-20T00:00:00.000Z",
      requested_at: "2026-10-04T00:00:00.000Z",
      decided_at: null,
      status: "pending",
      billing_account_id: null,
    };
    createFacade.mockResolvedValue({
      request: pending,
      approval_url:
        "https://poly.example.test/profile#agent-request=canonical-token",
    });
    pollFacade.mockResolvedValue({ request: pending });
    agentListFacade.mockResolvedValue({ requests: [pending] });
    const headers = {
      authorization: "Bearer cogni_ag_sk_v1_machine-token",
      host: "attacker.example",
      "content-type": "application/json",
    };

    const createResponse = await CREATE(
      new NextRequest("http://attacker.example/api/v1/agent/access-requests", {
        method: "POST",
        headers,
        body: JSON.stringify({ expires_at: pending.expires_at }),
      })
    );
    const createBody = (await createResponse.json()) as {
      approval_url: string;
    };
    const listResponse = await AGENT_LIST(
      new NextRequest("http://attacker.example/api/v1/agent/access-requests", {
        headers,
      })
    );
    const pollResponse = await POLL(
      new NextRequest(
        `http://attacker.example/api/v1/agent/access-requests/${REQUEST_ID}`,
        { headers }
      ),
      { params: Promise.resolve({ id: REQUEST_ID }) }
    );

    expect(createResponse.status).toBe(201);
    expect(createBody.approval_url).toContain("poly.example.test/profile#");
    expect(createBody.approval_url).not.toContain("attacker.example");
    expect(createFacade).toHaveBeenCalledTimes(1);
    expect(createFacade.mock.calls[0]).toHaveLength(3);
    expect(listResponse.status).toBe(200);
    expect(agentListFacade).toHaveBeenCalledWith(SESSION_USER);
    expect(pollResponse.status).toBe(200);
  });

  it("rejects all query selectors on the bearer self-list", async () => {
    const response = await AGENT_LIST(
      new NextRequest(
        "http://localhost/api/v1/agent/access-requests?billing_account_id=attacker-selected",
        {
          headers: {
            authorization: "Bearer cogni_ag_sk_v1_machine-token",
          },
        }
      )
    );

    expect(response.status).toBe(422);
    expect(agentListFacade).not.toHaveBeenCalled();
  });

  it("accepts a browser session on the owner list", async () => {
    getServerSessionUser.mockResolvedValueOnce(SESSION_USER);
    listFacade.mockResolvedValue({ requests: [] });

    const response = await OWNER_LIST(
      new NextRequest("http://localhost/api/v1/poly/agent-access-requests")
    );

    expect(response.status).toBe(200);
    expect(listFacade).toHaveBeenCalledWith(SESSION_USER);
  });
});

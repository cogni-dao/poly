// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/agent-access-discovery`
 * Purpose: Pin machine discovery for self-list/request/poll and scoped
 *   performance read.
 * Scope: Public discovery JSON only; auth behavior lives in route tests.
 * Invariants: a newly registered agent can discover every next API action.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ APP_BUILD_SHA: "test-sha" }),
}));

vi.mock("@/shared/config/repoSpec.server", () => ({
  getNodeName: () => "Poly",
  getNodeHook: () => "Test hook",
  getNodeMission: () => "Test mission",
  getNodeBrandIcon: () => "icon",
  getNodeBrandColor: () => "#000000",
  getNodeThumbnail: () => "thumbnail",
}));

import { GET } from "@/app/.well-known/agent.json/route";

describe("agent access discovery", () => {
  it("publishes self-list, request, poll, and scoped P/L actions with schemas", async () => {
    const response = await GET(
      new Request("http://0.0.0.0:3000/.well-known/agent.json", {
        headers: {
          "x-forwarded-host": "poly.example.test",
          "x-forwarded-proto": "https",
        },
      })
    );
    const body = (await response.json()) as {
      actions: Record<string, Record<string, unknown>>;
    };

    expect(body.actions.listOwnAgentAccessRequests).toMatchObject({
      method: "GET",
      endpoint: "https://poly.example.test/api/v1/agent/access-requests",
      auth: { type: "bearer" },
    });
    expect(body.actions.requestAgentAccess).toMatchObject({
      method: "POST",
      endpoint: "https://poly.example.test/api/v1/agent/access-requests",
      auth: { type: "bearer" },
    });
    expect(body.actions.pollAgentAccess).toMatchObject({
      method: "GET",
      endpoint:
        "https://poly.example.test/api/v1/agent/access-requests/{id}",
      auth: { type: "bearer" },
    });
    expect(body.actions.readCopyTradePnl).toMatchObject({
      method: "GET",
      endpoint:
        "https://poly.example.test/api/v1/poly/research/copy-trade-pnl",
      auth: { type: "bearer", requiredScope: "performance:read" },
    });
    for (const action of [
      body.actions.listOwnAgentAccessRequests,
      body.actions.requestAgentAccess,
      body.actions.pollAgentAccess,
      body.actions.readCopyTradePnl,
    ]) {
      expect(action).toHaveProperty("inputSchema");
      expect(action).toHaveProperty("outputSchema");
    }
  });
});

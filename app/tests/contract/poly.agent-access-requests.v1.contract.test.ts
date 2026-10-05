// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/poly.agent-access-requests.v1.contract`
 * Purpose: Pin agent-self and browser-owner access-request wire shapes.
 * Scope: Pure Zod contract validation; persistence/RLS live in component tests.
 * Invariants: fixed scope, no owner identity inputs, no tokens in outputs.
 * Side-effects: none
 * @internal
 */

import {
  agentAccessRequestErrorOutput,
  agentAccessRequestOwnerSchema,
  polyAgentAccessRequestCreateOperation,
  polyAgentAccessRequestDecisionOperation,
  polyAgentAccessRequestPollOperation,
  polyAgentAccessRequestPreviewOperation,
  polyAgentAccessRequestsListOperation,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";

const REQUEST_ID = "30000000-0000-4000-b000-000000000001";
const GRANT_ID = "30000000-0000-4000-b000-000000000002";
const TOKEN = "a".repeat(43);

const ownerRequest = {
  id: REQUEST_ID,
  agent_display_name: "Research agent",
  scope: "performance:read",
  expires_at: "2026-10-20T00:00:00.000Z",
  requested_at: "2026-10-04T00:00:00.000Z",
  decided_at: "2026-10-04T00:05:00.000Z",
  status: "active",
  grant_id: GRANT_ID,
};

describe("poly agent access requests v1 contract", () => {
  it("accepts the frozen agent create and poll shapes", () => {
    expect(
      polyAgentAccessRequestCreateOperation.input.parse({
        expires_at: "2026-10-20T00:00:00.000Z",
      })
    ).toEqual({ expires_at: "2026-10-20T00:00:00.000Z" });

    const agentRequest = {
      id: REQUEST_ID,
      scope: "performance:read",
      expires_at: "2026-10-20T00:00:00.000Z",
      requested_at: "2026-10-04T00:00:00.000Z",
      decided_at: null,
      status: "pending",
      billing_account_id: null,
    };
    expect(
      polyAgentAccessRequestCreateOperation.output.parse({
        request: agentRequest,
        approval_url: `https://poly.cognidao.org/profile#agent-request=${TOKEN}`,
      })
    ).toBeDefined();
    expect(
      polyAgentAccessRequestPollOperation.output.parse({
        request: {
          ...agentRequest,
          decided_at: "2026-10-04T00:05:00.000Z",
          status: "active",
          billing_account_id: "account-owner-a",
        },
      })
    ).toBeDefined();
  });

  it("accepts the frozen owner preview, decision, and list shapes", () => {
    expect(
      polyAgentAccessRequestPreviewOperation.input.parse({
        approval_token: TOKEN,
      })
    ).toEqual({ approval_token: TOKEN });
    expect(
      polyAgentAccessRequestDecisionOperation.input.parse({
        approval_token: TOKEN,
        decision: "approve",
      })
    ).toEqual({ approval_token: TOKEN, decision: "approve" });
    expect(
      polyAgentAccessRequestPreviewOperation.output.parse({
        request: { ...ownerRequest, status: "pending", grant_id: null },
      })
    ).toBeDefined();
    expect(
      polyAgentAccessRequestDecisionOperation.output.parse({
        request: ownerRequest,
      })
    ).toBeDefined();
    expect(
      polyAgentAccessRequestsListOperation.output.parse({
        requests: [ownerRequest],
      })
    ).toBeDefined();
  });

  it("rejects identity/account injection and non-performance scopes", () => {
    expect(
      polyAgentAccessRequestCreateOperation.input.safeParse({
        expires_at: "2026-10-20T00:00:00.000Z",
        requester_principal_id: "attacker-selected",
      }).success
    ).toBe(false);
    expect(
      polyAgentAccessRequestDecisionOperation.input.safeParse({
        approval_token: TOKEN,
        decision: "approve",
        billing_account_id: "attacker-selected",
      }).success
    ).toBe(false);
    expect(
      agentAccessRequestOwnerSchema.safeParse({
        ...ownerRequest,
        scope: "live:assign",
      }).success
    ).toBe(false);
  });

  it("never exposes approval tokens or internal identity IDs in owner DTOs", () => {
    const parsed = agentAccessRequestOwnerSchema.parse(ownerRequest);
    expect(parsed).not.toHaveProperty("approval_token");
    expect(parsed).not.toHaveProperty("approval_token_hash");
    expect(parsed).not.toHaveProperty("billing_account_id");
    expect(parsed).not.toHaveProperty("requester_principal_id");
  });

  it("uses a non-disclosing lifecycle error vocabulary", () => {
    for (const error of ["invalid_request", "not_found", "conflict"]) {
      expect(agentAccessRequestErrorOutput.safeParse({ error }).success).toBe(
        true
      );
    }
    expect(
      agentAccessRequestErrorOutput.safeParse({ error: "wrong_owner" }).success
    ).toBe(false);
  });
});

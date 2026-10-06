// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/poly.agent-grants.v1.contract`
 * Purpose: Pin the public grant lifecycle wire shapes and canonical scopes.
 * Scope: Pure Zod contract validation; persistence and RLS live in component tests.
 * Invariants: Grant scopes are canonical, non-empty, unique; expiry and lifecycle identifiers are mandatory.
 * Side-effects: none
 * Links: packages/poly-node-contracts/src/poly.agent-grants.v1.contract.ts, task.1791070950
 * @internal
 */

import {
  AGENT_CAPABILITY_SCOPES,
  agentCapabilityGrantSchema,
  polyAgentGrantRevokeOperation,
  polyAgentGrantsCreateOperation,
  polyAgentGrantsErrorOutput,
  polyAgentGrantsListOperation,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";

const GRANT_ID = "30000000-0000-4000-b000-000000000001";
const ACCOUNT_ID = "20000000-0000-4000-b000-000000000001";
const OWNER_ID = "10000000-0000-4000-a000-000000000001";
const AGENT_ID = "10000000-0000-4000-a000-000000000002";

const activeGrant = {
  id: GRANT_ID,
  billing_account_id: ACCOUNT_ID,
  grantee_principal_id: AGENT_ID,
  scopes: ["performance:read", "research:run"],
  expires_at: "2026-10-05T00:00:00.000Z",
  created_by_user_id: OWNER_ID,
  revoked_at: null,
  revoked_by_user_id: null,
  created_at: "2026-10-04T00:00:00.000Z",
  updated_at: "2026-10-04T00:00:00.000Z",
};

describe("poly agent grants v1 contract", () => {
  it("pins the complete canonical capability vocabulary", () => {
    expect(AGENT_CAPABILITY_SCOPES).toEqual([
      // story.5006: canonical name first, its retained legacy alias second.
      "account:read",
      "performance:read",
      "research:run",
      "policy:propose",
      "paper:assign",
      "live:approve",
      "live:assign",
    ]);
  });

  it("accepts the create, list, revoke, and grant lifecycle shapes", () => {
    expect(
      polyAgentGrantsCreateOperation.input.parse({
        billing_account_id: ACCOUNT_ID,
        grantee_principal_id: AGENT_ID,
        scopes: ["performance:read"],
        expires_at: "2026-10-05T00:00:00.000Z",
      })
    ).toEqual({
      billing_account_id: ACCOUNT_ID,
      grantee_principal_id: AGENT_ID,
      scopes: ["performance:read"],
      expires_at: "2026-10-05T00:00:00.000Z",
    });
    expect(
      polyAgentGrantsListOperation.output.parse({ grants: [activeGrant] })
    ).toEqual({
      grants: [activeGrant],
    });
    expect(
      polyAgentGrantsCreateOperation.output.parse({ grant: activeGrant })
    ).toEqual({
      grant: activeGrant,
    });
    expect(polyAgentGrantRevokeOperation.input.parse({ id: GRANT_ID })).toEqual({
      id: GRANT_ID,
    });
    expect(
      polyAgentGrantRevokeOperation.output.parse({
        grant: {
          ...activeGrant,
          revoked_at: "2026-10-04T01:00:00.000Z",
          revoked_by_user_id: OWNER_ID,
          updated_at: "2026-10-04T01:00:00.000Z",
        },
      })
    ).toBeDefined();
  });

  it.each([
    ["empty scopes", []],
    ["duplicate scopes", ["performance:read", "performance:read"]],
    ["unknown scope", ["performance:write"]],
  ])("rejects %s", (_label, scopes) => {
    expect(
      polyAgentGrantsCreateOperation.input.safeParse({
        billing_account_id: ACCOUNT_ID,
        grantee_principal_id: AGENT_ID,
        scopes,
        expires_at: "2026-10-05T00:00:00.000Z",
      }).success
    ).toBe(false);
  });

  it("requires expiry and valid principal/grant identifiers", () => {
    expect(
      polyAgentGrantsCreateOperation.input.safeParse({
        billing_account_id: ACCOUNT_ID,
        grantee_principal_id: AGENT_ID,
        scopes: ["performance:read"],
      }).success
    ).toBe(false);
    expect(
      polyAgentGrantsCreateOperation.input.safeParse({
        billing_account_id: ACCOUNT_ID,
        grantee_principal_id: "not-a-principal",
        scopes: ["performance:read"],
        expires_at: "not-a-timestamp",
      }).success
    ).toBe(false);
    expect(
      polyAgentGrantRevokeOperation.input.safeParse({ id: "not-a-grant" })
        .success
    ).toBe(false);
  });

  it("accepts only the non-disclosing lifecycle error vocabulary", () => {
    for (const error of ["invalid_request", "not_found", "conflict"]) {
      expect(polyAgentGrantsErrorOutput.safeParse({ error }).success).toBe(true);
    }
    expect(
      polyAgentGrantsErrorOutput.safeParse({ error: "other_tenant" }).success
    ).toBe(false);
  });

  it("rejects malformed persisted grant records", () => {
    expect(
      agentCapabilityGrantSchema.safeParse({
        ...activeGrant,
        scopes: [],
      }).success
    ).toBe(false);
    expect(
      agentCapabilityGrantSchema.safeParse({
        ...activeGrant,
        expires_at: "tomorrow",
      }).success
    ).toBe(false);
  });
});

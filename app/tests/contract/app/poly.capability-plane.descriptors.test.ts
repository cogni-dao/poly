// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/poly.capability-plane.descriptors`
 * Purpose: Pin the pure account-read catalog and prove machine discovery is a
 *   projection of it rather than a parallel hand-authored document.
 * Scope: Descriptors + the discovery projection. No transport, no DB.
 * Invariants: CAPABILITY_DEFINED_ONCE; GENERATED_DISCOVERY;
 *   SCOPE_ENUM_SINGLE_SOURCE; every descriptor is read-only and account-scoped.
 * Side-effects: none
 * Links: task.1791070961
 * @internal
 */

import {
  AGENT_CAPABILITY_SCOPES,
  defineAccountReadOperation,
  POLY_ACCOUNT_READ_OPERATIONS,
  polyAccountReadCopyTradeInvestigationEvidenceOperation,
  polyAccountReadCopyTradeInvestigationOperation,
  polyAccountReadCopyTradePnlOperation,
  polyResearchCopyTradePnlOperation,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  accountReadDiscoveryActions,
  accountReadDiscoveryEndpoints,
} from "@/features/capability-plane/discovery";
import { ACCOUNT_READ_TERMINAL_EVENTS } from "@/features/capability-plane/handlers";

const ORIGIN = "https://poly.example.test";

describe("account-read descriptors", () => {
  it("composes the existing operations without mutating them", () => {
    // The underlying contract files are frozen port entries; the descriptor
    // spreads them, so id/input/output must be the very same references.
    expect(polyAccountReadCopyTradePnlOperation.id).toBe(
      polyResearchCopyTradePnlOperation.id
    );
    expect(polyAccountReadCopyTradePnlOperation.input).toBe(
      polyResearchCopyTradePnlOperation.input
    );
    expect(polyAccountReadCopyTradePnlOperation.output).toBe(
      polyResearchCopyTradePnlOperation.output
    );
    expect(polyResearchCopyTradePnlOperation).not.toHaveProperty(
      "requiredScope"
    );
  });

  it("publishes a read-only, account-scoped, single-scope catalog", () => {
    expect(POLY_ACCOUNT_READ_OPERATIONS).toHaveLength(3);
    for (const operation of POLY_ACCOUNT_READ_OPERATIONS) {
      expect(operation.method).toBe("GET");
      expect(operation.readOnly).toBe(true);
      expect(operation.accountFrom).toBe("input");
      expect(operation.requiredScope).toBe("account:read");
      expect(AGENT_CAPABILITY_SCOPES).toContain(operation.requiredScope);
      expect(operation.path.startsWith("/api/v1/poly/")).toBe(true);
      expect(operation.summary.length).toBeGreaterThan(0);
    }
    // Ids are unique, so the handler/event/discovery maps cannot collide.
    const ids = POLY_ACCOUNT_READ_OPERATIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("binds every catalog entry to a terminal feature event", () => {
    for (const operation of POLY_ACCOUNT_READ_OPERATIONS) {
      expect(ACCOUNT_READ_TERMINAL_EVENTS[operation.id]).toMatch(
        /^feature\.poly_research\./
      );
    }
  });

  it("keeps defineAccountReadOperation pure", () => {
    const input = z.object({ billing_account_id: z.string().uuid() });
    const output = z.object({ ok: z.boolean() });
    const descriptor = defineAccountReadOperation({
      id: "poly.test.v1",
      summary: "test",
      input,
      output,
      requiredScope: "account:read",
      method: "GET",
      path: "/api/v1/poly/test",
      readOnly: true,
      accountFrom: "principal",
    });

    expect(descriptor).toEqual({
      id: "poly.test.v1",
      summary: "test",
      input,
      output,
      requiredScope: "account:read",
      method: "GET",
      path: "/api/v1/poly/test",
      readOnly: true,
      accountFrom: "principal",
    });
    expect(descriptor).not.toHaveProperty("handler");
  });
});

describe("discovery projection", () => {
  it("projects one action per descriptor, with both schemas derived", () => {
    const actions = accountReadDiscoveryActions(ORIGIN);

    expect(Object.keys(actions).sort()).toEqual([
      "readCopyTradeInvestigation",
      "readCopyTradeInvestigationEvidence",
      "readCopyTradePnl",
    ]);

    for (const operation of POLY_ACCOUNT_READ_OPERATIONS) {
      const action = Object.values(actions).find(
        (entry) => entry.endpoint === `${ORIGIN}${operation.path}`
      );
      expect(action).toBeDefined();
      expect(action?.method).toBe(operation.method);
      expect(action?.auth).toEqual({
        type: "bearer",
        requiredScope: "account:read",
      });
      // Derived, not hand-authored: identical to converting the descriptor.
      expect(action?.inputSchema).toEqual(z.toJSONSchema(operation.input));
      expect(action?.outputSchema).toEqual(z.toJSONSchema(operation.output));
    }
  });

  it("keeps the already-published P/L action and endpoint names stable", () => {
    expect(accountReadDiscoveryActions(ORIGIN).readCopyTradePnl).toMatchObject({
      method: "GET",
      endpoint: `${ORIGIN}/api/v1/poly/research/copy-trade-pnl`,
      auth: { type: "bearer", requiredScope: "account:read" },
    });
    expect(accountReadDiscoveryEndpoints(ORIGIN)).toEqual({
      copyTradePnl: `${ORIGIN}/api/v1/poly/research/copy-trade-pnl`,
      copyTradeInvestigation: `${ORIGIN}${polyAccountReadCopyTradeInvestigationOperation.path}`,
      copyTradeInvestigationEvidence: `${ORIGIN}${polyAccountReadCopyTradeInvestigationEvidenceOperation.path}`,
    });
  });
});

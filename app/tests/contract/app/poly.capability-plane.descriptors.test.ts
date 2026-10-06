// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/poly.capability-plane.descriptors`
 * Purpose: Pin the pure account-read catalog and prove machine discovery is a
 *   projection of it rather than a parallel hand-authored document.
 * Scope: Descriptors + the discovery projection. No transport, no DB.
 * Invariants: CAPABILITY_DEFINED_ONCE; GENERATED_DISCOVERY;
 *   SCOPE_ENUM_SINGLE_SOURCE; every descriptor is read-only and account-scoped.
 *   CATALOG_GROWTH_IS_NOT_A_REGRESSION — assertions are structural (they hold
 *   for every descriptor the catalog currently has) plus a stability floor for
 *   the already-published names. Hard-coding the catalog size or an exhaustive
 *   action list would make each new capability fail a test it did not break,
 *   which is exactly what happened when task.1791070959 landed its two.
 * Side-effects: none
 * Links: task.1791070961, task.1791070959
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
  projectSchema,
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
    // The catalog GROWS as capabilities land (task.1791070959 added copy-setup,
    // the attempt tape, and the inverted orders list). Asserting an exact
    // length would make every new capability look like a regression, so this
    // pins a floor plus the three originally-published ids, and then asserts
    // the per-descriptor invariants over whatever the catalog currently holds.
    expect(POLY_ACCOUNT_READ_OPERATIONS.length).toBeGreaterThanOrEqual(3);
    const catalogIds = POLY_ACCOUNT_READ_OPERATIONS.map((entry) => entry.id);
    expect(catalogIds).toEqual(
      expect.arrayContaining([
        polyAccountReadCopyTradePnlOperation.id,
        polyAccountReadCopyTradeInvestigationOperation.id,
        polyAccountReadCopyTradeInvestigationEvidenceOperation.id,
      ])
    );
    for (const operation of POLY_ACCOUNT_READ_OPERATIONS) {
      expect(operation.method).toBe("GET");
      expect(operation.readOnly).toBe(true);
      // `principal` is the other legal source and is STRICTLY MORE restrictive
      // than `input` — the caller cannot name an account at all — so it is
      // accepted here. What must never happen is a third, unvetted source.
      expect(["input", "principal"]).toContain(operation.accountFrom);
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
      // Namespace, not sub-namespace: capabilities outside `poly_research`
      // (account reads, copy operations) emit `feature.poly_<area>.*`. The
      // invariant is that EVERY catalog entry has a feature-namespaced
      // terminal event, not that every entry is a research read.
      expect(ACCOUNT_READ_TERMINAL_EVENTS[operation.id]).toMatch(
        /^feature\.poly_[a-z_]+\./
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
  // PROJECTION_FAILURE_IS_ISOLATED + SCHEMA_DEGRADES_NEVER_LIES.
  // `poly.account.portfolio-snapshot.v1` transitively contains
  // `PolyAddressSchema`, which ends in `.transform(s => s.toLowerCase())`.
  // Output-mode projection throws on that, and because the discovery route
  // spreads the whole-catalog projection, publishing it previously blanked
  // `.well-known/agent.json` for EVERY capability. These two assertions are
  // the regression guard for that blast radius.
  it("publishes a descriptor whose output contains a transform, without throwing", () => {
    expect(() => accountReadDiscoveryActions(ORIGIN)).not.toThrow();

    const actions = accountReadDiscoveryActions(ORIGIN);
    const portfolio = actions.readPortfolioSnapshot;

    expect(portfolio).toBeDefined();
    expect(portfolio?.endpoint).toBe(
      `${ORIGIN}/api/v1/poly/account/portfolio-snapshot`
    );
    // Degraded to input mode, not omitted and not fabricated: the pre-transform
    // type of an address `.toLowerCase()` is the same `string`.
    expect(portfolio?.outputSchema).toBeDefined();
  });

  it("keeps every other action intact when one output is unrepresentable", () => {
    const actions = accountReadDiscoveryActions(ORIGIN);

    // The whole point: one unprojectable descriptor must not cost the others
    // their schemas.
    for (const operation of POLY_ACCOUNT_READ_OPERATIONS) {
      const action = Object.values(actions).find(
        (candidate) => candidate.endpoint === `${ORIGIN}${operation.path}`
      );
      expect(action?.inputSchema).toBeDefined();
    }
  });

  it("projects one action per descriptor, with both schemas derived", () => {
    const actions = accountReadDiscoveryActions(ORIGIN);

    // Superset: the three original action names must keep existing, and every
    // descriptor must get exactly one action, but new capabilities are allowed
    // to add names. One action per descriptor is asserted by the count below.
    expect(Object.keys(actions)).toEqual(
      expect.arrayContaining([
        "readCopyTradeInvestigation",
        "readCopyTradeInvestigationEvidence",
        "readCopyTradePnl",
      ])
    );
    expect(Object.keys(actions)).toHaveLength(
      POLY_ACCOUNT_READ_OPERATIONS.length
    );

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
      // Derived, not hand-authored: identical to the seam's own projection of
      // the descriptor. Compared against `projectSchema` rather than a bare
      // `z.toJSONSchema` so the assertion does not re-implement the
      // output-mode -> input-mode fallback (and so it does not itself throw on
      // a descriptor whose output contains a transform).
      expect(action?.inputSchema).toEqual(projectSchema(operation.input));
      expect(action?.outputSchema).toEqual(projectSchema(operation.output));
    }
  });

  it("keeps the already-published P/L action and endpoint names stable", () => {
    expect(accountReadDiscoveryActions(ORIGIN).readCopyTradePnl).toMatchObject({
      method: "GET",
      endpoint: `${ORIGIN}/api/v1/poly/research/copy-trade-pnl`,
      auth: { type: "bearer", requiredScope: "account:read" },
    });
    // toMatchObject, not toEqual: these three published names must keep
    // resolving to these three paths forever, but the map legitimately gains
    // an entry per new capability.
    expect(accountReadDiscoveryEndpoints(ORIGIN)).toMatchObject({
      copyTradePnl: `${ORIGIN}/api/v1/poly/research/copy-trade-pnl`,
      copyTradeInvestigation: `${ORIGIN}${polyAccountReadCopyTradeInvestigationOperation.path}`,
      copyTradeInvestigationEvidence: `${ORIGIN}${polyAccountReadCopyTradeInvestigationEvidenceOperation.path}`,
    });
  });
});

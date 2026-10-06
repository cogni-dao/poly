// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/capability-plane/portfolio-snapshot.contract`
 * Purpose: Pin the descriptor-level guarantees of
 *   `poly.account.portfolio-snapshot.v1` — the ones that make dashboard/agent
 *   parity structural rather than something a runtime test has to chase.
 * Scope: Pure contract assertions. No DB, no HTTP, no mocks.
 * Links: story.5004, task.1791070962, docs/spec/capability-plane.md
 * @internal
 */

import {
  ACCOUNT_READ_SCOPE,
  POLY_ACCOUNT_READ_OPERATIONS,
  PolyAccountPortfolioSnapshotOutputSchema,
  polyAccountReadPortfolioSnapshotOperation,
  polyAccountReadPortfolioSnapshotOwnerOperation,
  PolyWalletDashboardOutputSchema,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";
import { accountReadDiscoveryActions } from "@/features/capability-plane/discovery";
import { ACCOUNT_READ_TERMINAL_EVENTS } from "@/features/capability-plane/handlers";

const agent = polyAccountReadPortfolioSnapshotOperation;
const owner = polyAccountReadPortfolioSnapshotOwnerOperation;

describe("poly.account.portfolio-snapshot descriptor", () => {
  it("is ONE capability reached by two transports", () => {
    // CAPABILITY_DEFINED_ONCE: same id, scope and output on both transports, so
    // `operationId` in Loki and every parity assertion treat them as one.
    expect(owner.id).toBe(agent.id);
    expect(owner.requiredScope).toBe(agent.requiredScope);
    expect(owner.output).toBe(agent.output);
    expect(owner.path).not.toBe(agent.path);
  });

  it("gates on the canonical account:read scope, not the legacy name", () => {
    expect(agent.requiredScope).toBe(ACCOUNT_READ_SCOPE);
    expect(agent.requiredScope).toBe("account:read");
  });

  it("is honestly read-only, so REPEATABLE READ READ ONLY is not a lie", () => {
    expect(agent.readOnly).toBe(true);
    expect(owner.readOnly).toBe(true);
    expect(agent.method).toBe("GET");
  });

  it("makes an agent NAME the account and an owner never need to", () => {
    // The delegation trap: a delegated principal must not be answerable about
    // a tenant derived from its own id. It names the account; authorize() rules.
    expect(agent.accountFrom).toBe("input");
    expect(agent.input.safeParse({ interval: "1W" }).success).toBe(false);
    expect(
      agent.input.safeParse({
        billing_account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }).success
    ).toBe(true);

    expect(owner.accountFrom).toBe("principal");
    expect(owner.input.safeParse({}).success).toBe(true);
    // An owner transport that accepted an account id on the wire would be a
    // second way to name a tenant; it is stripped, not honoured.
    const parsed = owner.input.parse({
      billing_account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(parsed).not.toHaveProperty("billing_account_id");
  });

  it("defaults the interval identically on both transports", () => {
    expect(owner.input.parse({}).interval).toBe("1W");
    expect(
      agent.input.parse({
        billing_account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }).interval
    ).toBe("1W");
  });

  it("only the delegable transport is published for discovery", () => {
    const ids = POLY_ACCOUNT_READ_OPERATIONS.map((operation) => operation.id);
    expect(ids).toContain(agent.id);

    const actions = accountReadDiscoveryActions("https://poly.example");
    const action = actions.readAccountPortfolioSnapshot;
    expect(action).toBeDefined();
    // GENERATED_DISCOVERY: the published method/path/scope come from the
    // descriptor, and the ONE published path is the account-on-the-wire one.
    expect(action?.endpoint).toBe(
      `https://poly.example${agent.path}`
    );
    expect(action?.auth.requiredScope).toBe("account:read");
    expect(JSON.stringify(actions)).not.toContain(owner.path);
  });

  it("has a terminal event, so it cannot ship unobservable", () => {
    expect(ACCOUNT_READ_TERMINAL_EVENTS[agent.id]).toBe(
      "feature.poly_wallet_dashboard.complete"
    );
  });
});

describe("portfolio snapshot output shape", () => {
  it("is a strict superset of the dashboard contract", () => {
    // RESPONSE_IS_A_SUPERSET: the owner UI parses `PolyWalletDashboardOutputSchema`
    // and zod strips unknown keys, so serving the snapshot on /wallet/dashboard
    // cannot break an existing client.
    const dashboardKeys = Object.keys(PolyWalletDashboardOutputSchema.shape);
    const snapshotKeys = Object.keys(
      PolyAccountPortfolioSnapshotOutputSchema.shape
    );
    for (const key of dashboardKeys) {
      expect(snapshotKeys).toContain(key);
    }
    expect(snapshotKeys).toContain("readiness");
    expect(snapshotKeys).toHaveLength(dashboardKeys.length + 1);
  });

  it("carries readiness facts but NOT the connection mutation handle", () => {
    const readiness = Object.keys(
      PolyAccountPortfolioSnapshotOutputSchema.shape.readiness.shape
    );
    expect(readiness).toEqual(
      expect.arrayContaining([
        "connected",
        "funder_address",
        "trading_ready",
        "auto_wrap_consent_at",
        "auto_wrap_floor_usdce_atomic",
      ])
    );
    // Inventory row 2.5 is an actor-only affordance: a connection id is a
    // mutation handle and must never be a shared account fact.
    expect(readiness).not.toContain("connection_id");
  });

  it("degrades on a corrupt auto-wrap floor instead of failing the whole snapshot", () => {
    // Defence in depth, not a bug fix: migration 0035 already CHECKs the
    // column `> 0`, so `0` should be unreachable. Accepting it keeps one bad
    // readiness field from collapsing the entire snapshot into a 500.
    const floor =
      PolyAccountPortfolioSnapshotOutputSchema.shape.readiness.shape
        .auto_wrap_floor_usdce_atomic;
    expect(floor.safeParse("0").success).toBe(true);
    expect(floor.safeParse(null).success).toBe(true);
    expect(floor.safeParse("00").success).toBe(false);
    expect(floor.safeParse("-1").success).toBe(false);
  });
});

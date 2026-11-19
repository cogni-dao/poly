// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/db/service-role-budget`
 * Purpose: Budget math for the service_poly role (bug.5064): injected runtimePoolLimits are
 *   honored exactly; with none injected the defaults leave one spare under the shared-tier
 *   service role (4).
 * Scope: Pure function; no database.
 * Invariants: injected => declared values exactly; defaults => service + read + leader <= 3;
 *   each pool >= 1.
 * Side-effects: none
 * @internal
 */
import { describe, expect, it } from "vitest";
import { resolveServiceRoleBudget } from "@/adapters/server/db/service-role-budget";

/** shared-default-v1: connection limit of the service role on the shared tier. */
const SHARED_TIER_SERVICE_ROLE = 4;

describe("resolveServiceRoleBudget (bug.5064)", () => {
  it("defaults (service 1, read 1, leader 1 = 3) leave one spare under the shared-tier role", () => {
    const b = resolveServiceRoleBudget({
      requestedService: 1,
      requestedRead: 1,
      injected: false,
      leaderConnections: 1,
      podBudget: 3,
    });
    expect(b).toMatchObject({
      serviceMax: 1,
      readMax: 1,
      podTotal: 3,
      injected: false,
      clamped: false,
    });
    expect(SHARED_TIER_SERVICE_ROLE - b.podTotal).toBeGreaterThanOrEqual(1);
  });

  it("honors injected runtimePoolLimits exactly (no re-clamp below the declared values)", () => {
    const b = resolveServiceRoleBudget({
      requestedService: 4,
      requestedRead: 2,
      injected: true,
      leaderConnections: 1,
      podBudget: 3,
    });
    expect(b).toMatchObject({
      serviceMax: 4,
      readMax: 2,
      podTotal: 7,
      podBudget: 7,
      injected: true,
      clamped: false,
    });
  });

  it("injected pods hold exactly declared + leader, never more", () => {
    for (let service = 1; service <= 8; service++) {
      for (let read = 1; read <= 8; read++) {
        for (const leaderConnections of [0, 1] as const) {
          const b = resolveServiceRoleBudget({
            requestedService: service,
            requestedRead: read,
            injected: true,
            leaderConnections,
            podBudget: 3,
          });
          expect(b.serviceMax).toBe(service);
          expect(b.readMax).toBe(read);
          expect(b.podTotal).toBe(service + read + leaderConnections);
        }
      }
    }
  });

  it("clamps a non-injected oversize request to the pod budget", () => {
    const b = resolveServiceRoleBudget({
      requestedService: 4,
      requestedRead: 2,
      injected: false,
      leaderConnections: 1,
      podBudget: 3,
    });
    expect(b).toMatchObject({
      serviceMax: 1,
      readMax: 1,
      podTotal: 3,
      clamped: true,
    });
  });

  it("gives the leader's slot back to the pools when election is disabled", () => {
    const b = resolveServiceRoleBudget({
      requestedService: 4,
      requestedRead: 2,
      injected: false,
      leaderConnections: 0,
      podBudget: 4,
    });
    expect(b.leaderConnections).toBe(0);
    expect(b.serviceMax + b.readMax).toBe(4);
  });

  it("never produces a pool below one connection and holds the budget for every non-injected request", () => {
    for (const leaderConnections of [0, 1] as const) {
      for (let service = 1; service <= 12; service++) {
        for (let read = 1; read <= 12; read++) {
          const b = resolveServiceRoleBudget({
            requestedService: service,
            requestedRead: read,
            injected: false,
            leaderConnections,
            podBudget: 3,
          });
          expect(b.serviceMax).toBeGreaterThanOrEqual(1);
          expect(b.readMax).toBeGreaterThanOrEqual(1);
          expect(b.podTotal).toBe(b.serviceMax + b.readMax + leaderConnections);
          expect(b.podTotal).toBeLessThanOrEqual(
            Math.max(3, leaderConnections + 2)
          );
        }
      }
    }
  });

  it("floors an impossibly small budget and a zero request at one connection per pool", () => {
    const a = resolveServiceRoleBudget({
      requestedService: 4,
      requestedRead: 2,
      injected: false,
      leaderConnections: 1,
      podBudget: 1,
    });
    expect(a).toMatchObject({
      serviceMax: 1,
      readMax: 1,
      podTotal: 3,
      podBudget: 3,
    });
    const z = resolveServiceRoleBudget({
      requestedService: 0,
      requestedRead: 0,
      injected: true,
      leaderConnections: 1,
      podBudget: 3,
    });
    expect(z).toMatchObject({ serviceMax: 1, readMax: 1 });
  });
});

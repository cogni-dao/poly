// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/db/service-role-budget`
 * Purpose: Budget math for the service_poly role (bug.5064): one pod never holds more than
 *   the per-pod budget, so two blue/green pods fit the role ceiling 8.
 * Scope: Pure function; no database.
 * Invariants: leader + service + read <= podBudget for every input; each pool >= 1.
 * Side-effects: none
 * @internal
 */
import { describe, expect, it } from "vitest";
import { resolveServiceRoleBudget } from "@/adapters/server/db/service-role-budget";

/** service_poly's role connection ceiling (rolconnlimit) — never raised from the app. */
const ROLE_CEILING = 8;
/** Blue/green: the old pod keeps its sessions while the new pod boots. */
const PODS_DURING_ROLLOUT = 2;

describe("resolveServiceRoleBudget (bug.5064)", () => {
  it("the defaults (service 2, read 1, leader 1) fit two pods under the role ceiling", () => {
    const b = resolveServiceRoleBudget({
      requestedService: 2,
      requestedRead: 1,
      leaderConnections: 1,
      podBudget: 4,
    });
    expect(b).toMatchObject({ serviceMax: 2, readMax: 1, podTotal: 4, clamped: false });
    expect(b.podTotal * PODS_DURING_ROLLOUT).toBeLessThanOrEqual(ROLE_CEILING);
  });

  it("clamps production's injected 4/2 (7 per pod, 14 across two pods) to 2/1 + leader", () => {
    const b = resolveServiceRoleBudget({
      requestedService: 4,
      requestedRead: 2,
      leaderConnections: 1,
      podBudget: 4,
    });
    expect(b).toMatchObject({ serviceMax: 2, readMax: 1, podTotal: 4, clamped: true });
    // The regression: 2 pods x (4 + 2 + 1) = 14 > 8 → SQLSTATE 53300.
    expect((4 + 2 + 1) * PODS_DURING_ROLLOUT).toBeGreaterThan(ROLE_CEILING);
    expect(b.podTotal * PODS_DURING_ROLLOUT).toBeLessThanOrEqual(ROLE_CEILING);
  });

  it("the legacy pre-bug.5045 defaults (10 + 5) clamp too", () => {
    const b = resolveServiceRoleBudget({
      requestedService: 10,
      requestedRead: 5,
      leaderConnections: 1,
      podBudget: 4,
    });
    expect(b.podTotal).toBeLessThanOrEqual(4);
    expect(b.clamped).toBe(true);
  });

  it("gives the leader's slot back to the pools when election is disabled", () => {
    const b = resolveServiceRoleBudget({
      requestedService: 4,
      requestedRead: 2,
      leaderConnections: 0,
      podBudget: 4,
    });
    expect(b.leaderConnections).toBe(0);
    expect(b.serviceMax + b.readMax).toBe(4);
    expect(b.podTotal).toBe(4);
  });

  it("never lets a request starve a pool below one connection", () => {
    const b = resolveServiceRoleBudget({
      requestedService: 1,
      requestedRead: 50,
      leaderConnections: 1,
      podBudget: 4,
    });
    expect(b.serviceMax).toBeGreaterThanOrEqual(1);
    expect(b.readMax).toBeGreaterThanOrEqual(1);
    expect(b.podTotal).toBeLessThanOrEqual(4);
  });

  it("holds the per-pod budget for every requested combination", () => {
    for (const leaderConnections of [0, 1] as const) {
      for (let service = 1; service <= 12; service++) {
        for (let read = 1; read <= 12; read++) {
          const b = resolveServiceRoleBudget({
            requestedService: service,
            requestedRead: read,
            leaderConnections,
            podBudget: 4,
          });
          expect(b.serviceMax).toBeGreaterThanOrEqual(1);
          expect(b.readMax).toBeGreaterThanOrEqual(1);
          expect(b.podTotal).toBe(b.serviceMax + b.readMax + leaderConnections);
          expect(b.podTotal).toBeLessThanOrEqual(4);
          expect(b.podTotal * PODS_DURING_ROLLOUT).toBeLessThanOrEqual(ROLE_CEILING);
          // Never grows a request.
          expect(b.serviceMax).toBeLessThanOrEqual(Math.max(service, 1));
          expect(b.readMax).toBeLessThanOrEqual(Math.max(read, 1));
        }
      }
    }
  });

  it("floors an impossibly small budget at leader + one connection per pool", () => {
    const b = resolveServiceRoleBudget({
      requestedService: 4,
      requestedRead: 2,
      leaderConnections: 1,
      podBudget: 1,
    });
    expect(b).toMatchObject({ serviceMax: 1, readMax: 1, podTotal: 3, podBudget: 3 });
  });
});

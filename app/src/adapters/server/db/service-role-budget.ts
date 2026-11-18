// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/db/service-role-budget`
 * Purpose: Pure per-pod connection budget for the service_poly role (bug.5064).
 * Scope: Clamps the requested service-pool and read-pool `max` so that
 *   service + read + leader-election connection never exceed the per-pod
 *   budget. No IO, no env access, no logging.
 * Invariants:
 *   - SERVICE_ROLE_POD_BUDGET: leader + service + read <= budget, always, even when env
 *     (runtimePoolLimits) requests more. service_poly's ceiling is 8 and blue/green
 *     runs two pods at once, so the default budget is 4 (2 pods x 4 = 8).
 *   - Each pool keeps at least 1 connection; the leader connection is never clamped.
 *   - Pure: same inputs → same outputs (unit-tested without a database).
 * Side-effects: none
 * Links: packages/db-client/src/build-client.ts (backend math), work/items/bug.5064
 * @internal
 */

export interface ServiceRoleBudgetInput {
  /** Requested service-pool max (DB_SERVICE_POOL_MAX). */
  requestedService: number;
  /** Requested service-read-pool max (DB_READ_POOL_MAX). */
  requestedRead: number;
  /** 1 when the job-leader elector holds a dedicated connection, else 0. */
  leaderConnections: 0 | 1;
  /** Per-pod ceiling on service_poly backends (DB_SERVICE_ROLE_BUDGET). */
  podBudget: number;
}

export interface ServiceRoleBudget {
  serviceMax: number;
  readMax: number;
  leaderConnections: 0 | 1;
  /** serviceMax + readMax + leaderConnections — the per-pod worst case on service_poly. */
  podTotal: number;
  podBudget: number;
  /** True when the requested maxes exceeded the budget and were reduced. */
  clamped: boolean;
}

export function resolveServiceRoleBudget(
  input: ServiceRoleBudgetInput
): ServiceRoleBudget {
  const { leaderConnections } = input;
  // Never below leader + 1 + 1: each pool needs a connection to function.
  const podBudget = Math.max(input.podBudget, leaderConnections + 2);
  const available = podBudget - leaderConnections;
  const requestedService = Math.max(1, Math.floor(input.requestedService));
  const requestedRead = Math.max(1, Math.floor(input.requestedRead));
  const requestedTotal = requestedService + requestedRead;

  if (requestedTotal <= available) {
    return {
      serviceMax: requestedService,
      readMax: requestedRead,
      leaderConnections,
      podTotal: requestedTotal + leaderConnections,
      podBudget,
      clamped: false,
    };
  }

  // Share `available` in proportion to the request, each pool keeping >= 1.
  const readMax = Math.min(
    available - 1,
    Math.max(1, Math.round((available * requestedRead) / requestedTotal))
  );
  const serviceMax = available - readMax;
  return {
    serviceMax,
    readMax,
    leaderConnections,
    podTotal: serviceMax + readMax + leaderConnections,
    podBudget,
    clamped: true,
  };
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/db/service-role-budget`
 * Purpose: Pure per-pod connection budget for the service_poly role (bug.5064).
 * Scope: Decides the effective service-pool and read-pool `max`. No IO, no env access,
 *   no logging.
 * Invariants:
 *   - CATALOG_IS_AUTHORITY: when the operator injects `runtimePoolLimits`
 *     (hub: database-state-cell-lifecycle), the declared service/read maxes are used
 *     EXACTLY; the pod holds declared service + read + leader and is never re-clamped
 *     below them. Role caps are provisioned by the operator to leave one spare.
 *   - DEFAULTS_FIT_SHARED_TIER: with no injected limits, service + read + leader <=
 *     `podBudget` (default 3 = 1 + 1 + 1), one spare under the shared-tier role (4).
 *   - Each pool keeps at least 1 connection (max < 1 is never produced); the leader
 *     connection is never clamped.
 *   - Pure: same inputs → same outputs (unit-tested without a database).
 *   - Blue/green (two replicas) overlap is an OPERATOR budget gap (operator bug.5645),
 *     not something a node can size away.
 * Side-effects: none
 * Links: packages/db-client/src/build-client.ts (backend math), work/items/bug.5064
 * @internal
 */

export interface ServiceRoleBudgetInput {
  /** Requested service-pool max: the declared value when injected, else the default. */
  requestedService: number;
  /** Requested service-read-pool max: the declared value when injected, else the default. */
  requestedRead: number;
  /** True when the operator injected DB_SERVICE_POOL_MAX and/or DB_READ_POOL_MAX. */
  injected: boolean;
  /** 1 when the job-leader elector holds a dedicated connection, else 0. */
  leaderConnections: 0 | 1;
  /** Per-pod ceiling on service_poly backends for the NON-injected case (DB_SERVICE_ROLE_BUDGET). */
  podBudget: number;
}

export interface ServiceRoleBudget {
  serviceMax: number;
  readMax: number;
  leaderConnections: 0 | 1;
  /** serviceMax + readMax + leaderConnections — the per-pod worst case on service_poly. */
  podTotal: number;
  /** The ceiling applied: declared service + read + leader when injected, else podBudget. */
  podBudget: number;
  /** True when the operator declared the limits (used exactly). */
  injected: boolean;
  /** True when the requested maxes exceeded the budget and were reduced. */
  clamped: boolean;
}

export function resolveServiceRoleBudget(
  input: ServiceRoleBudgetInput
): ServiceRoleBudget {
  const { leaderConnections, injected } = input;
  const requestedService = Math.max(1, Math.floor(input.requestedService));
  const requestedRead = Math.max(1, Math.floor(input.requestedRead));
  const requestedTotal = requestedService + requestedRead;

  if (injected) {
    // The catalog is the authority: honor the declared values exactly.
    return {
      serviceMax: requestedService,
      readMax: requestedRead,
      leaderConnections,
      podTotal: requestedTotal + leaderConnections,
      podBudget: requestedTotal + leaderConnections,
      injected: true,
      clamped: false,
    };
  }

  // Never below leader + 1 + 1: each pool needs a connection to function.
  const podBudget = Math.max(input.podBudget, leaderConnections + 2);
  const available = podBudget - leaderConnections;

  if (requestedTotal <= available) {
    return {
      serviceMax: requestedService,
      readMax: requestedRead,
      leaderConnections,
      podTotal: requestedTotal + leaderConnections,
      podBudget,
      injected: false,
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
    injected: false,
    clamped: true,
  };
}

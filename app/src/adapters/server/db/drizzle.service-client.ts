// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/drizzle.service-client`
 * Purpose: Lazy service-role database singleton (BYPASSRLS).
 * Scope: Wraps createServiceDbClient with env-derived connection string. Does not handle app-role access or tenant scoping.
 * Invariants:
 * - MUST NOT be imported from general src/ code (enforced by dependency-cruiser)
 * - Only auth.ts and explicitly-allowed files may import this
 * Side-effects: IO (database connections) - only on first access
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/database-rls.md
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { createServiceDbClient } from "@cogni/db-client/service";

import { getNodeId } from "@/shared/config/repoSpec.server";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

import {
  resolveServiceRoleBudget,
  type ServiceRoleBudget,
} from "./service-role-budget";

/**
 * Shared-tier defaults when the operator injects no `runtimePoolLimits`
 * (`shared-default-v1`: service role 4): service 1 + read 1 + leader 1 = 3, one spare.
 */
export const SHARED_TIER_SERVICE_POOL_MAX = 1;
export const SHARED_TIER_READ_POOL_MAX = 1;

// Lazy service-role connection (BYPASSRLS) for auth, workers, and bootstrap.
// DATABASE_SERVICE_URL is required in all environments (no fallback).
// Read-path service queries use the separate pool in drizzle.service-read-client.ts.
//
// PROCESS_WIDE_SINGLETON (bug.5066): the handle lives on `globalThis`, not in a
// module variable. Next can evaluate this module once per bundle graph
// (instrumentation vs route handlers) and each copy would otherwise dial its own
// pool, multiplying the per-pod service_poly budget (service 1 + read 1 + leader 1).
const processSlots = globalThis as unknown as {
  __cogniPolyServiceDb?: Database;
};

/**
 * Per-pod service_poly budget (bug.5064): the service pool, the read pool and the
 * leader connection all draw from role service_poly. The operator catalog
 * `database.<env>.runtimePoolLimits` is the authority: when it injects
 * DB_SERVICE_POOL_MAX / DB_READ_POOL_MAX they are used exactly. Absent (no injected
 * limits — candidate-a/preview on the shared tier) the defaults service 1 / read 1 +
 * leader 1 = 3 apply, bounded by DB_SERVICE_ROLE_BUDGET (default 3, one spare under 4).
 */
export function resolveServiceRoleBudgetFromEnv(): ServiceRoleBudget {
  const env = serverEnv();
  return resolveServiceRoleBudget({
    requestedService: env.DB_SERVICE_POOL_MAX ?? SHARED_TIER_SERVICE_POOL_MAX,
    requestedRead: env.DB_READ_POOL_MAX ?? SHARED_TIER_READ_POOL_MAX,
    injected:
      env.DB_SERVICE_POOL_MAX !== undefined ||
      env.DB_READ_POOL_MAX !== undefined,
    leaderConnections: env.JOB_LEADER_ELECTION_ENABLED ? 1 : 0,
    podBudget: env.DB_SERVICE_ROLE_BUDGET,
  });
}

/** Configuration receipt (not connection success): declared/requested vs effective pool max. */
export function logServicePoolConfigured(
  role: "service" | "service_read",
  requestedMax: number,
  budget: ServiceRoleBudget
): void {
  makeLogger({ nodeId: getNodeId() }).info(
    {
      event: EVENT_NAMES.DB_POOL_CONFIGURED,
      role,
      pgRole: "service_poly",
      requestedMax,
      max: role === "service" ? budget.serviceMax : budget.readMax,
      leaderConnections: budget.leaderConnections,
      podTotal: budget.podTotal,
      podBudget: budget.podBudget,
      injected: budget.injected,
      clamped: budget.clamped,
      pid: process.pid,
    },
    EVENT_NAMES.DB_POOL_CONFIGURED
  );
}

function createServiceDb(): Database {
  if (!processSlots.__cogniPolyServiceDb) {
    const env = serverEnv();
    // Pool budget: declared DB_SERVICE_POOL_MAX when injected, else default 1.
    // Backend math: packages/db-client/src/build-client.ts.
    const budget = resolveServiceRoleBudgetFromEnv();
    processSlots.__cogniPolyServiceDb = createServiceDbClient(env.DATABASE_SERVICE_URL, {
      max: budget.serviceMax,
    });
    logServicePoolConfigured(
      "service",
      env.DB_SERVICE_POOL_MAX ?? SHARED_TIER_SERVICE_POOL_MAX,
      budget
    );
  }
  return processSlots.__cogniPolyServiceDb as Database;
}

export const getServiceDb = createServiceDb;


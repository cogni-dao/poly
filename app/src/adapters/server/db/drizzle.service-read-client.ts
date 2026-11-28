// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/drizzle.service-read-client`
 * Purpose: Lazy service-role READ database singleton (BYPASSRLS, separate pool).
 * Scope: Wraps createServiceReadDbClient with env-derived connection string. Read-path
 * dashboard/research queries only — no writes, no background jobs.
 * Invariants:
 * - Same app_service credentials as drizzle.service-client.ts but its OWN connection
 *   budget (DB_READ_POOL_MAX when injected, default 1) and application_name (cogni_service_read),
 *   so background jobs on the main service pool cannot starve dashboard reads (task.5014)
 * - MUST NOT be imported from general src/ code — reach it via
 *   resolveServiceReadDb() in bootstrap/container.ts
 * Side-effects: IO (database connections) - only on first access
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/database-rls.md, packages/db-client/src/build-client.ts (backend math)
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { createServiceReadDbClient } from "@cogni/db-client/service";

import { serverEnv } from "@/shared/env";
import { processSingleton } from "@/shared/util/process-singleton";

import {
  logServicePoolConfigured,
  SHARED_TIER_READ_POOL_MAX,
  resolveServiceRoleBudgetFromEnv,
} from "./drizzle.service-client";

// Lazy service-role READ connection (BYPASSRLS) for dashboard/research read routes.
// ONE_PER_PROCESS (bug.5066): held in the process registry, not a module variable.
function createServiceReadDb(): Database {
  return processSingleton("db.service-read", () => {
    const env = serverEnv();
    // Pool budget: declared DB_READ_POOL_MAX when injected, else default 1 (bug.5064).
    // Backend math: packages/db-client/src/build-client.ts.
    const budget = resolveServiceRoleBudgetFromEnv();
    const db = createServiceReadDbClient(env.DATABASE_SERVICE_URL, {
      max: budget.readMax,
    });
    logServicePoolConfigured(
      "service_read",
      env.DB_READ_POOL_MAX ?? SHARED_TIER_READ_POOL_MAX,
      budget
    );
    return db;
  });
}

export const getServiceReadDb = createServiceReadDb;

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/drizzle.service-read-client`
 * Purpose: Lazy service-role READ database singleton (BYPASSRLS, separate pool).
 * Scope: Wraps createServiceReadDbClient with env-derived connection string. Read-path
 * dashboard/research queries only — no writes, no background jobs.
 * Invariants:
 * - Same app_service credentials as drizzle.service-client.ts but its OWN connection
 *   budget (DB_READ_POOL_MAX, default 5) and application_name (cogni_service_read),
 *   so background jobs on the main service pool cannot starve dashboard reads (task.5014)
 * - MUST NOT be imported from general src/ code — reach it via
 *   resolveServiceReadDb() in bootstrap/container.ts
 * Side-effects: IO (database connections) - only on first access
 * Links: docs/spec/database-rls.md, packages/db-client/src/build-client.ts (backend math)
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { createServiceReadDbClient } from "@cogni/db-client/service";

import { serverEnv } from "@/shared/env";

// Lazy service-role READ connection (BYPASSRLS) for dashboard/research read routes.
let _serviceReadDb: Database | null = null;

function createServiceReadDb(): Database {
  if (!_serviceReadDb) {
    const env = serverEnv();
    // Pool budget: DB_READ_POOL_MAX (default 5). Backend math: packages/db-client/src/build-client.ts.
    _serviceReadDb = createServiceReadDbClient(env.DATABASE_SERVICE_URL, {
      max: env.DB_READ_POOL_MAX,
    });
  }
  return _serviceReadDb;
}

export const getServiceReadDb = createServiceReadDb;

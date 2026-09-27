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
 * Links: docs/spec/database-rls.md
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { createServiceDbClient } from "@cogni/db-client/service";

import { serverEnv } from "@/shared/env";

// Lazy service-role connection (BYPASSRLS) for auth, workers, and bootstrap.
// DATABASE_SERVICE_URL is required in all environments (no fallback).
// Read-path service queries use the separate pool in drizzle.service-read-client.ts.
let _serviceDb: Database | null = null;

function createServiceDb(): Database {
  if (!_serviceDb) {
    const env = serverEnv();
    // Pool budget: DB_SERVICE_POOL_MAX (default 10). Backend math: packages/db-client/src/build-client.ts.
    _serviceDb = createServiceDbClient(env.DATABASE_SERVICE_URL, {
      max: env.DB_SERVICE_POOL_MAX,
    });
  }
  return _serviceDb;
}

export const getServiceDb = createServiceDb;

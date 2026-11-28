// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/drizzle.client`
 * Purpose: Lazy app-role database singleton (RLS enforced) for the Next.js web runtime.
 * Scope: Wraps createAppDbClient with env-derived connection string. Does not handle business logic, migrations, or service-role access.
 * Invariants: Single database connection instance; lazy initialization prevents build-time env access
 * Side-effects: IO (database connections) - only on first access
 * Notes: Service-role singleton (BYPASSRLS) lives in drizzle.service-client.ts, NOT here.
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/database-rls.md
 * @internal
 */

import { createAppDbClient, type Database } from "@cogni/db-client";

import { getNodeId } from "@/shared/config/repoSpec.server";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";
import { processSingleton } from "@/shared/util/process-singleton";

export type { Database };

// Lazy database connection - only created when first accessed. ONE_PER_PROCESS
// (bug.5066): held in the process registry, not a module variable — Next evaluates
// this module once per bundle graph, and each copy would dial its own pool.
function createDb(): Database {
  return processSingleton("db.app", () => {
    const env = serverEnv();
    // Pool budget: DB_POOL_MAX (default 1; explicit overrides are preserved). Backend math: packages/db-client/src/build-client.ts.
    const db = createAppDbClient(env.DATABASE_URL, { max: env.DB_POOL_MAX });
    // Construction is not a request; this is configuration, not connection success.
    makeLogger({ nodeId: getNodeId() }).info(
      {
        event: EVENT_NAMES.DB_POOL_CONFIGURED,
        role: "app",
        requestedMax: env.DB_POOL_MAX,
        max: env.DB_POOL_MAX,
        pid: process.pid,
      },
      EVENT_NAMES.DB_POOL_CONFIGURED
    );
    return db;
  });
}

// Export lazy database getter to avoid top-level runtime env access
export const getAppDb = createDb;

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-client/build-client`
 * Purpose: Shared Drizzle client constructor used by both app and service factories.
 * Scope: Internal — not exported from any package entrypoint. Does not handle env resolution.
 * Invariants:
 *   - Connection string injected, never from process.env
 *   - Pool size injected via options (env-derived at the app layer), defaults documented below
 *   - Database type preserves drizzle's `$client` accessor for pool control (e.g. `reserve()`)
 * Side-effects: IO (database connections)
 * Notes — backend math (task.5014, bug.5045):
 *   Each app pod holds THREE postgres-js pools, each with its own `max`:
 *     1. app pool        (app_user, RLS)          — `DB_POOL_MAX`,         default 1, application_name `cogni_template_app`
 *     2. service pool    (app_service, BYPASSRLS) — `DB_SERVICE_POOL_MAX`, shared-tier default 1, application_name `cogni_service` (background jobs + writers)
 *     3. service-read pool (app_service, BYPASSRLS) — `DB_READ_POOL_MAX`,  shared-tier default 1,  application_name `cogni_service_read` (dashboard/research reads)
 *   Release qualification may own ONE transient app-role backend per process,
 *   closed on its action deadline/finally. With the default app pool of 1,
 *   blue + green each holding a qualification connection use 4 app backends,
 *   within the dedicated app-role ceiling of 4. It never closes shared pools.
 *   Plus ONE dedicated leader-election connection (task.5016) outside these
 *   pools: a `max: 1` postgres-js client pinned via `reserve()` holding the
 *   session-level job-runner advisory lock, application_name
 *   `cogni_job_leader` (see app/src/adapters/server/db/job-leader-lock.client.ts;
 *   absent when JOB_LEADER_ELECTION_ENABLED=false).
 *   The real budget is per Postgres ROLE: the app pool is role app_poly; the
 *   service pool + read pool + leader all share role service_poly. The operator
 *   catalog `database.<env>.runtimePoolLimits {app, service, read}` is the
 *   authority (hub: database-state-cell-lifecycle): when injected, the declared
 *   service/read maxes are used exactly and the operator provisions role caps that
 *   leave one connection spare. With NO injected limits (candidate-a/preview on
 *   the shared tier, `shared-default-v1`: service role 4) the defaults are
 *   service 1 + read 1 + leader 1 = 3, one spare (DB_SERVICE_ROLE_BUDGET default 3).
 *   The former 4 + 2 + 1 = 7 defaults caused SQLSTATE 53300 (bug.5064); service
 *   10 + read 5 did earlier (bug.5045). Do NOT restore them. Blue/green overlap
 *   (two replicas) is an operator budget gap (operator bug.5645), not node-fixable.
 *   Tune via the env vars in `app/src/shared/env/server-env.ts` — this package
 *   never reads process.env.
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/database-rls.md
 * @internal
 */

import * as fullSchema from "@cogni/db-schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Fallback pool size for the app (app_poly, RLS) pool when no env-derived override
 * is injected. 1 mirrors the applied `DB_POOL_MAX` default and keeps app_poly far
 * under its role ceiling (bug.5045). Runtime callers inject the env-derived `max`;
 * this constant only guards direct/test callers. Service pools size themselves via
 * DEFAULT_SERVICE_POOL_MAX / DEFAULT_READ_POOL_MAX (see ./service).
 */
export const DEFAULT_POOL_MAX = 1;

/** Pool-tuning options injected by callers (env-derived at the app layer). */
export interface BuildClientOptions {
  /** Max connections for this pool (postgres-js `max`). Defaults to {@link DEFAULT_POOL_MAX}. */
  max?: number;
  /** Optional native limits for an action-owned client; existing pools keep defaults. */
  connectTimeoutSeconds?: number;
  statementTimeoutMs?: number;
}

export function buildClient(
  connectionString: string,
  applicationName: string,
  options: BuildClientOptions = {}
) {
  const client = postgres(connectionString, {
    max: options.max ?? DEFAULT_POOL_MAX,
    idle_timeout: 20,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    connection: {
      application_name: applicationName,
      ...(options.statementTimeoutMs !== undefined ? {
        statement_timeout: options.statementTimeoutMs,
        lock_timeout: options.statementTimeoutMs,
        idle_in_transaction_session_timeout: options.statementTimeoutMs,
      } : {}),
    },
  });

  return drizzle(client, { schema: fullSchema });
}

/** Drizzle client including the postgres.js `$client` accessor for pool control. */
export type Database = ReturnType<typeof buildClient>;

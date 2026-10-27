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
 *     2. service pool    (app_service, BYPASSRLS) — `DB_SERVICE_POOL_MAX`, default 4, application_name `cogni_service` (background jobs + writers)
 *     3. service-read pool (app_service, BYPASSRLS) — `DB_READ_POOL_MAX`,  default 2,  application_name `cogni_service_read` (dashboard/research reads)
 *   Plus ONE dedicated leader-election connection (task.5016) outside these
 *   pools: a `max: 1` postgres-js client pinned via `reserve()` holding the
 *   session-level job-runner advisory lock, application_name
 *   `cogni_job_leader` (see app/src/adapters/server/db/job-leader-lock.client.ts;
 *   absent when JOB_LEADER_ELECTION_ENABLED=false).
 *   The real budget is per Postgres ROLE, not just `max_connections`: the app
 *   pool is role app_poly; the service pool + read pool + leader all share role
 *   service_poly. Worst-case backends per pod = DB_POOL_MAX + DB_SERVICE_POOL_MAX
 *   + DB_READ_POOL_MAX + 1 (defaults: 1 + 4 + 2 + 1 = 8), of which app_poly = 1
 *   and service_poly = 7. The dedicated budget profile ceilings are app 4 /
 *   service 8, so defaults fit as app 1/4 and service 7/8 — the budget production
 *   runs. Lanes without runtimePoolLimits (candidate-a, preview) inherit these
 *   defaults as their APPLIED budget; the old service 10 + read 5 exceeded the
 *   service_poly ceiling 8 and caused SQLSTATE 53300 (bug.5045). Tune per-env via
 *   the three env vars in `app/src/shared/env/server-env.ts` — this package never
 *   reads process.env.
 * Links: docs/spec/database-rls.md
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
}

export function buildClient(
  connectionString: string,
  applicationName: string,
  options: BuildClientOptions = {}
) {
  const client = postgres(connectionString, {
    max: options.max ?? DEFAULT_POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      application_name: applicationName,
    },
  });

  return drizzle(client, { schema: fullSchema });
}

/** Drizzle client including the postgres.js `$client` accessor for pool control. */
export type Database = ReturnType<typeof buildClient>;

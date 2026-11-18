// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-client/service`
 * Purpose: Service-role DB client factories (BYPASSRLS) — job/writer pool + read pool.
 * Scope: Exports createServiceDbClient and createServiceReadDbClient only. Does not export SYSTEM_ACTOR (now in @cogni/ids/system).
 * Invariants:
 * - MUST NOT be imported from Next.js web runtime code (enforced by dependency-cruiser)
 * - Only the drizzle.service-*-client.ts singletons and services/ may import this
 * - Read pool shares app_service credentials but has its own connection budget
 *   and application_name so jobs cannot starve dashboard/research reads (task.5014)
 * Side-effects: IO (database connections)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/database-rls.md
 * @public
 */

import { type BuildClientOptions, buildClient } from "./build-client";

export type { BuildClientOptions };

/**
 * Default `max` for the service (jobs/writers) pool when the operator injects no
 * `runtimePoolLimits`. The shared tier gives the service role 4 connections
 * (`shared-default-v1`); service 1 + read 1 + leader 1 = 3 leaves one spare
 * (bug.5064). Injected `DB_SERVICE_POOL_MAX` is the authority and is used exactly.
 */
export const DEFAULT_SERVICE_POOL_MAX = 1;

/**
 * Default `max` for the service READ pool (read-only dashboard/research traffic) when no
 * `runtimePoolLimits` are injected. Part of the same 1 + 1 + leader 1 = 3 budget.
 */
export const DEFAULT_READ_POOL_MAX = 1;

/**
 * Creates a Drizzle database client for the `app_service` role (BYPASSRLS).
 * Use this for scheduler workers, internal services, background jobs, writers,
 * and auth bootstrap only.
 * Must NOT be used in the Next.js web runtime (enforced by dependency-cruiser).
 *
 * @param options - Pool tuning; `max` is env-derived at the app layer
 *   (`DB_SERVICE_POOL_MAX` when injected, default 1). See build-client.ts header for backend math.
 */
export function createServiceDbClient(
  connectionString: string,
  options: BuildClientOptions = {}
) {
  return buildClient(connectionString, "cogni_service", {
    max: options.max ?? DEFAULT_SERVICE_POOL_MAX,
  });
}

/**
 * Creates a Drizzle database client for READ-path service queries
 * (`app_service` role, BYPASSRLS — same credentials as createServiceDbClient,
 * separate pool). Dashboard/research read routes use this pool so background
 * jobs on the main service pool cannot starve them (task.5014). Role/RLS
 * changes for the read path are explicitly out of scope here.
 *
 * @param options - Pool tuning; `max` is env-derived at the app layer
 *   (`DB_READ_POOL_MAX`, default 1). See build-client.ts header for backend math.
 */
export function createServiceReadDbClient(
  connectionString: string,
  options: BuildClientOptions = {}
) {
  return buildClient(connectionString, "cogni_service_read", {
    max: options.max ?? DEFAULT_READ_POOL_MAX,
  });
}

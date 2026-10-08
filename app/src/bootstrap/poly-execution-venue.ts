// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/poly-execution-venue`
 * Purpose: One process-wide wiring point for "which venue does this account
 *   trade on, and who authorizes its paper intents?". Memoizes the resolver +
 *   paper venue over the service DB client so the container, the wallet-refresh
 *   route, and the manual-close route all dispatch through the same objects
 *   instead of each re-deriving execution mode.
 * Scope: Bootstrap wiring only. Contains no decision logic — the resolver lives
 *   in `@features/paper-accounts`, which is where it is unit-tested.
 * Invariants:
 *   - ONE_VENUE_RESOLVER_PER_PROCESS: the executor factory (dispatch) and the
 *     order ledger (`mode` stamping) must consume the SAME resolver, or a row
 *     could be labeled `live` while its order went to the sidecar.
 *   - NO_ENV_READ: nothing here reads `PAPER_ENFORCE_MODE`. Venue comes from
 *     `poly_wallet_connections.kind` — the env var is declared (bug.5277 keeps
 *     the declaration) and deliberately unread.
 * Side-effects: constructs the service Drizzle client on first call.
 * Links: docs/spec/capability-plane.md, migration 0081
 * @internal
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import {
  createExecutionVenueResolver,
  createPaperVenue,
  type ExecutionVenueResolver,
  type PaperVenuePort,
} from "@/features/paper-accounts";

let cachedResolver: ExecutionVenueResolver | null = null;
let cachedPaperVenue: PaperVenuePort | null = null;

/**
 * The service client, cast to the postgres-js shape the feature slice declares.
 * Same cast the container uses when handing `serviceDb` to `dbTargetSource` —
 * one driver, two slightly different generic spellings.
 */
function serviceDbForVenue(): PostgresJsDatabase<Record<string, unknown>> {
  return getServiceDb() as unknown as PostgresJsDatabase<
    Record<string, unknown>
  >;
}

/** Process-memoized `billingAccountId → 'live' | 'paper'`. */
export function getExecutionVenueResolver(): ExecutionVenueResolver {
  if (!cachedResolver) {
    cachedResolver = createExecutionVenueResolver({ db: serviceDbForVenue() });
  }
  return cachedResolver;
}

/** Process-memoized paper-account authorizer + identity reader. */
export function getPaperVenue(): PaperVenuePort {
  if (!cachedPaperVenue) {
    cachedPaperVenue = createPaperVenue({ db: serviceDbForVenue() });
  }
  return cachedPaperVenue;
}

/** For tests only — clears the memoized instances. */
export function __resetPolyExecutionVenueForTests(): void {
  cachedResolver = null;
  cachedPaperVenue = null;
}

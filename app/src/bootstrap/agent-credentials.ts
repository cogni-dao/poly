// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-credentials`
 * Purpose: This node's wiring of the `@cogni-dao/agent-grants/credentials` store: the service-role postgres.js client.
 * Scope: Composition only. `agent_credentials` is deny-all for the app role (FORCE RLS, no policy), so the store gets the
 *   BYPASSRLS service connection. No decision lives here.
 * Side-effects: none (the client is built lazily by the container); the per-client lookup limiter is in-memory
 * Links: packages/agent-grants/src/credentials
 * @internal
 */

import {
  agentRolesHasRoles,
  type CredentialSql,
  CredentialStoreUnavailableError,
  type CredentialStore,
  createPostgresCredentialStore,
  createPostgresSpawnStore,
  type SpawnStore,
} from "@cogni/agent-grants/credentials";
import { resolveServiceDb } from "@/bootstrap/container";
import { credentialLookupLimiter, extractEdgeClientIp } from "@/bootstrap/http/rateLimiter";

let store: CredentialStore | undefined;
let spawnStore: SpawnStore | undefined;

/** A missing or broken service connection is an outage (503), never a 500 or a 401. */
export function getAgentCredentialStore(): CredentialStore {
  try {
    // node-template's role read is `agent_roles` (the operator injects its OpenFGA read here instead).
    const client = resolveServiceDb().$client as unknown as CredentialSql;
    store ??= createPostgresCredentialStore(client, { hasRoles: agentRolesHasRoles(client) });
  } catch (cause) {
    throw new CredentialStoreUnavailableError(cause);
  }
  return store;
}

/**
 * The spawn-grant store (issue, redeem, list owned): the same service-role connection, because `agent_spawn_grants` is deny-all for the app role
 * and `agent_principals` is writable only by the service role. A missing connection is an outage (503), never a 500 or a refusal.
 */
export function getAgentSpawnStore(): SpawnStore {
  try {
    spawnStore ??= createPostgresSpawnStore(resolveServiceDb().$client as unknown as CredentialSql);
  } catch (cause) {
    throw new CredentialStoreUnavailableError(cause);
  }
  return spawnStore;
}

/**
 * Per-client admission for credential lookups (ADMIT_BEFORE_STORE, SPEND_ON_MISS). `admitCredentialLookup` only CHECKS the client's bucket: false = over
 * the limit, the caller answers 429 and reads nothing. `recordCredentialMiss` spends one token, and the caller invokes it only when the lookup found no
 * usable key. The client key is the Cloudflare-written `cf-connecting-ip` (see `extractEdgeClientIp` for the evidence).
 */
export function admitCredentialLookup(headers: { get(name: string): string | null }): boolean {
  return credentialLookupLimiter.hasTokens(extractEdgeClientIp({ headers }));
}

export function recordCredentialMiss(headers: { get(name: string): string | null }): void {
  credentialLookupLimiter.consume(extractEdgeClientIp({ headers }));
}

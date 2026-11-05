// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-client/tenant-scope`
 * Purpose: Transaction helpers that set PostgreSQL RLS tenant context via SET LOCAL.
 * Scope: Generic over any Drizzle PostgresJsDatabase schema type. Does not handle role switching or connection pooling.
 * Invariants:
 * - actorId must be a branded ActorId (UUID validation happens at brand construction in @cogni/ids)
 * - SET LOCAL scopes the setting to the current transaction only (no cross-request leakage)
 * Side-effects: IO (database transaction)
 * Notes: SET LOCAL does not accept parameterized $1 placeholders in PostgreSQL.
 *        We use sql.raw() after UUID format validation. This is safe because:
 *        1. The regex strictly limits the value to hex digits and hyphens
 *        2. The value comes from server-side JWT sessions, never from request body
 *        3. ActorId branded type guarantees the value was validated at construction time
 * Links: docs/spec/database-rls.md, @cogni/ids
 * @public
 */

import type { ActorId } from "@cogni/ids";
import { type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Run `fn` inside a Drizzle transaction with `app.current_user_id` set for RLS.
 *
 * Every query inside `fn` sees only rows belonging to the actor per the
 * RLS policies defined in migration 0004_enable_rls.sql.
 *
 * Generic over any PostgresJsDatabase schema type — callers pass their
 * concrete `db` instance and TypeScript infers the schema.
 *
 * @param lifetime - Optional common deadline. The caller must own/cancel its DB
 * client to bound connection/BEGIN waits; these transaction timeouts alone cannot.
 * @param actorId - Branded ActorId (validated UUID at construction time)
 */
export async function withTenantScope<
  T,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PostgresJsDatabase<TSchema>,
  actorId: ActorId,
  fn: (
    tx: Parameters<Parameters<PostgresJsDatabase<TSchema>["transaction"]>[0]>[0]
  ) => Promise<T>,
  lifetime?: { signal: AbortSignal; deadlineAt: number }
): Promise<T> {
  lifetime?.signal.throwIfAborted();
  return db.transaction(async (tx) => {
    lifetime?.signal.throwIfAborted();
    if (lifetime) {
      const remaining = Math.floor(lifetime.deadlineAt - Date.now());
      if (remaining <= 0) throw new Error("database_action_deadline");
      await tx.execute(sql`SELECT
        set_config('statement_timeout', ${String(remaining)}, true),
        set_config('lock_timeout', ${String(remaining)}, true),
        set_config('idle_in_transaction_session_timeout', ${String(remaining)}, true)`);
      lifetime.signal.throwIfAborted();
    }
    await tx.execute(
      sql`SET LOCAL app.current_user_id = '${sql.raw(actorId)}'`
    );
    const result = await fn(tx);
    lifetime?.signal.throwIfAborted();
    if (lifetime && Date.now() >= lifetime.deadlineAt) throw new Error("database_action_deadline");
    return result;
  });
}

/**
 * Set tenant context inside an existing transaction.
 *
 * Use this when the caller already has a transaction (e.g., adapter methods
 * that use `db.transaction()` for atomicity). Call as the first statement.
 *
 * Accepts any Drizzle transaction-like object with an `execute` method,
 * so it works with any schema type.
 *
 * @param actorId - Branded ActorId (validated UUID at construction time)
 */
export async function setTenantContext(
  tx: { execute(query: SQL): Promise<unknown> },
  actorId: ActorId
): Promise<void> {
  await tx.execute(sql`SET LOCAL app.current_user_id = '${sql.raw(actorId)}'`);
}

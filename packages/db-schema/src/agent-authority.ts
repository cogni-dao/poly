// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/agent-authority`
 * Purpose: Runtime agent authority tables: internal agent principals and node role rows.
 * Scope: Schema only. Reads and writes live in `@cogni-dao/agent-grants` (raw SQL over an injected client).
 * Invariants:
 *   - An internal principal row points at a seeded `users` row that has no credential.
 *   - CREDENTIALS_ONLY_ON_AGENT_PRINCIPALS: `agent_credentials` rows belong only to a user with an `external` `agent_principals` row
 *     (a trigger in the migration enforces it).
 *   - ROLE_ROWS_ARE_SOFT_REVOKED: a role row is never deleted; `revoked_at` ends it. One live row per (principal, scope).
 *   - ONE_GRANT_ROW (task.5465): node and account grants are one table, `agent_roles`; `resource` and `account_id` say which.
 *   - TOKEN_HASH_ONLY / STATE_IS_DERIVED: `agent_credentials` stores sha256 of the key and timestamps only; state (pending, active,
 *     renew_only, expired, revoked) is derived by the SQL function `agent_credential_state` (migration), never stored.
 *   - SERVICE_ROLE_ONLY_WRITES: `agent_credentials` has ENABLE + FORCE RLS and no policy (deny-all for the app role). `agent_roles` has ENABLE + FORCE RLS
 *     and ONE narrow select policy (an account row naming the connection's own user as principal); no write policy.
 *     `agent_principals` is readable by every role (its select policy) and writable only by a BYPASSRLS service
 *     connection. FORCE is added by hand in the migration.
 *   - AGENT_WALLET_IS_NOT_A_PAYEE (a payout guard, enforced in the database; it does not decide who may be admin): an agent principal may bind a wallet, but a trigger
 *     on `epoch_distribution_leaves` and `distribution_settlement_leaves` (migration 0043) refuses a payout leaf whose account is a wallet an agent principal owns.
 * Side-effects: none (schema definitions only)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { billingAccounts, users } from "./refs";

/** A marked principal. `internal` rows are seeded for a graph to act as; `external` rows are outside agents and services (orgs are not part of this node's model). */
export const agentPrincipals = pgTable(
  "agent_principals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    slug: text("slug"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "agent_principals_kind_canonical",
      sql`${table.kind} IN ('internal','external')`
    ),
    check(
      "agent_principals_internal_has_slug",
      sql`${table.kind} <> 'internal' OR ${table.slug} IS NOT NULL`
    ),
    uniqueIndex("agent_principals_slug_unique").on(table.slug),
    uniqueIndex("agent_principals_user_id_unique").on(table.userId),
    // Read-only for every role: slug and seeded user id are not secret, and the wallet-binding trigger must see
    // them whichever role binds. Writes stay deny-all for the app role (no write policy; FORCE RLS).
    pgPolicy("agent_principals_read", { for: "select", using: sql`true` }),
  ]
).enableRLS();

/**
 * One grant row: a permission (scope) for an agent principal, on the node (`resource = 'node'`) or on one account (`'account'`).
 * Pending = `approved_by IS NULL` and not revoked (the agent asked; no approver has said yes). Live = approved, not revoked and, for an
 * account row, not past `expires_at`. Denied = never approved, revoked. Revoked = approved, then revoked. Expired is a state read from
 * `expires_at` (task.5465 R14), never a write. Only a live row opens a lock.
 * Account rows (task.5465): the account owner is the approver. A pending account row has no account until its owner decides it
 * (`account_id` is set in the decide statement, from an account the approver owns). One-time approval link: `link_hash` is sha256 of the
 * token (never the token), consumed by the decision.
 */
export const agentRoles = pgTable(
  "agent_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalUserId: text("principal_user_id")
      .notNull()
      .references(() => users.id),
    scope: text("scope").notNull(),
    approvedBy: text("approved_by").references(() => users.id),
    /** Set when an approver approves. Null while pending or denied. */
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    /** The agent that asked, for a row that began as a request. Null for a row an admin wrote directly. */
    requestedBy: text("requested_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** What the row covers: the whole node, or one account. Every row before this column is a node row. */
    resource: text("resource").notNull().default("node"),
    /** The account an approved account row covers. Null on a node row and on a pending account row. */
    accountId: text("account_id").references(() => billingAccounts.id),
    /** When an approved account row ends. Null = until Off (the default, like a node row). A row with an end keeps the expired state (R14). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** sha256 of the one-time approval link token. The token is never stored. Null once consumed. */
    linkHash: text("link_hash"),
    linkExpiresAt: timestamp("link_expires_at", { withTimezone: true }),
    linkConsumedAt: timestamp("link_consumed_at", { withTimezone: true }),
  },
  (table) => [
    // EXPAND PHASE: kept as the only live-row uniqueness (one open row per principal and scope). Old pods keep their ON CONFLICT
    // target. The contract migration (task.5484) replaces it with per-account indexes.
    uniqueIndex("agent_roles_live_unique")
      .on(table.principalUserId, table.scope)
      .where(sql`${table.revokedAt} IS NULL`),
    uniqueIndex("agent_roles_link_hash_unique").on(table.linkHash),
    index("agent_roles_principal_idx").on(table.principalUserId),
    check(
      "agent_roles_resource_canonical",
      sql`${table.resource} IN ('node','account')`
    ),
    check(
      "agent_roles_node_shape",
      sql`${table.resource} <> 'node' OR (${table.accountId} IS NULL AND ${table.expiresAt} IS NULL)`
    ),
    check(
      "agent_roles_account_live_shape",
      sql`${table.resource} <> 'account' OR ${table.approvedBy} IS NULL OR (${table.accountId} IS NOT NULL AND ${table.grantedAt} IS NOT NULL AND (${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.grantedAt}))`
    ),
    check(
      "agent_roles_no_self_approval",
      sql`${table.approvedBy} IS NULL OR ${table.approvedBy} <> ${table.principalUserId}`
    ),
    check(
      "agent_roles_link_consumed_has_no_hash",
      sql`${table.linkConsumedAt} IS NULL OR ${table.linkHash} IS NULL`
    ),
    // R11: an app-role connection sees only account rows that name it as the principal (the RLS function `agent_has_scope` reads them).
    // Writes stay service-role only: no write policy.
    pgPolicy("agent_roles_account_self_read", {
      for: "select",
      using: sql`${table.resource} = 'account' AND ${table.principalUserId} = current_setting('app.current_user_id', true)`,
    }),
  ]
).enableRLS();

/**
 * One revocable agent key. `token_hash` is sha256 of the key; the key is never stored.
 * pending = `confirmed_at IS NULL` inside `pending_expires_at`. A rotation inserts a pending successor (`predecessor_id`); confirm
 * activates it and revokes the predecessor in one transaction. Revoking a row ends only that key.
 */
export const agentCredentials = pgTable(
  "agent_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    createdFrom: text("created_from").notNull(),
    predecessorId: uuid("predecessor_id"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    renewUntil: timestamp("renew_until", { withTimezone: true }).notNull(),
    pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    revokedBy: text("revoked_by"),
  },
  (table) => [
    foreignKey({
      columns: [table.predecessorId],
      foreignColumns: [table.id],
      name: "agent_credentials_predecessor_id_fk",
    }),
    check(
      "agent_credentials_created_from_canonical",
      sql`${table.createdFrom} IN ('spawn_grant','rotation','key_upgrade','binding_recovery','recovery_grant')`
    ),
    check(
      "agent_credentials_renew_after_expiry",
      sql`${table.renewUntil} > ${table.expiresAt}`
    ),
    uniqueIndex("agent_credentials_token_hash_unique").on(table.tokenHash),
    // One pending successor per predecessor: a second rotate supersedes (revokes) the first before it inserts.
    uniqueIndex("agent_credentials_one_pending_successor")
      .on(table.predecessorId)
      .where(sql`${table.confirmedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    // Not partial: the v1 gate (`everConfirmed`) reads revoked rows too, on every signed-key-authenticated request.
    index("agent_credentials_user_idx").on(table.userId),
  ]
).enableRLS();

/**
 * A payer binding (story.0038 phase 2): the subject's runs are billed to `billing_account_id` once an owner of that account approves. Pending = `approved_by IS NULL`
 * and not revoked. Live = approved and not revoked. One open (pending or live) row per subject. Never deleted: `revoked_at` ends it. The binding is the consent
 * (PAYER_IS_AUTHORIZED); there is no spend scope. Service-role only: ENABLE + FORCE RLS and no policy (FORCE is added by hand in the migration).
 */
export const payerBindings = pgTable(
  "payer_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectUserId: text("subject_user_id")
      .notNull()
      .references(() => users.id),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id),
    approvedBy: text("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("payer_bindings_open_per_subject")
      .on(table.subjectUserId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("payer_bindings_account_idx").on(table.billingAccountId),
    check(
      "payer_bindings_no_self_approval",
      sql`${table.approvedBy} IS NULL OR ${table.approvedBy} <> ${table.subjectUserId}`
    ),
    check(
      "payer_bindings_approval_is_paired",
      sql`(${table.approvedBy} IS NULL) = (${table.approvedAt} IS NULL)`
    ),
  ]
).enableRLS();

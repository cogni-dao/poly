// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/agent-authority`
 * Purpose: Runtime agent authority tables: internal agent principals and node role rows.
 * Scope: Schema only. Reads and writes live in `@cogni-dao/agent-grants` (raw SQL over an injected client).
 * Invariants:
 *   - AGENTS_HOLD_NO_WALLET: an internal principal row points at a seeded `users` row with no wallet and has no credential.
 *   - CREDENTIALS_ONLY_ON_AGENT_PRINCIPALS: `agent_credentials` rows belong only to a user with an `external` `agent_principals` row
 *     (a trigger in the migration enforces it).
 *   - ROLE_ROWS_ARE_SOFT_REVOKED: a role row is never deleted; `revoked_at` ends it. One live row per (principal, scope).
 *   - ONE_GRANT_ROW: a node permission and a person's own grant are the same row shape. `resource_kind` says which: `node` (an admin
 *     decides; `owner_user_id` is null) or `delegated` (the person who owns the agent lets it use a scope on the delegable list, `knowledge:read` and `knowledge:contribute`).
 *     A personal row names its owner in `owner_user_id`; the owner decides. A CHECK keeps a personal row to the delegable list.
 *   - PERSONAL_GRANT_IS_THE_OWNERS_AND_ENDS: a personal row is approved only by its owner (never by the agent) and always has an `expires_at`.
 *     Node rows have none in v0. Both are CHECK constraints, so no code path can write around them.
 *   - TOKEN_HASH_ONLY / STATE_IS_DERIVED: `agent_credentials` stores sha256 of the key and timestamps only; state (pending, active,
 *     renew_only, expired, revoked) is derived by the SQL function `agent_credential_state` (migration), never stored.
 *   - SERVICE_ROLE_ONLY_WRITES: `agent_credentials`, `agent_roles` and `agent_claims` have ENABLE + FORCE RLS and no policy (deny-all for the app role).
 *     `agent_principals` is readable by every role (its select policy) and writable only by a BYPASSRLS service
 *     connection. FORCE is added by hand in the migration.
 *   - CLAIM_IS_AGENT_INITIATED: `agent_claims` holds a claim an EXISTING agent started with its own key (15 minutes, single use, bound to that agent). A signed-in person's click sets
 *     `agent_principals.owner_user_id` once, only where it is NULL. No secret travels through a human.
 *   - OWNER_IS_THE_ISSUER: an `external` principal made from a spawn grant stores the person who issued that grant in `owner_user_id`.
 *     A principal with no owner (anonymous registration, or an agent that predates ownership) is ownerless. An internal principal never has an owner.
 *   - SPAWN_GRANT_HASH_ONLY: `agent_spawn_grants` stores sha256 of the one-time grant and timestamps. It has ENABLE + FORCE RLS and no policy
 *     (service role only). A grant is one-use: `redeemed_at` and `redeemed_user_id` are set together, once.
 *   - AGENTS_HOLD_NO_WALLET (a payout guard, enforced in the database; it does not decide who may be admin): a trigger on `user_bindings` (migration) refuses a wallet
 *     binding for any user that has an `agent_principals` row, on every binding path.
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

import { users } from "./refs";

/**
 * A marked agent. `internal` rows are seeded for a graph to act as; `external` rows come from redeemed spawn grants (owner set),
 * from a signed-key upgrade, or from anonymous registration (both ownerless).
 */
export const agentPrincipals = pgTable(
  "agent_principals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    slug: text("slug"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /** The person who issued the spawn grant this agent redeemed. Null = ownerless. */
    ownerUserId: text("owner_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "agent_principals_owner_external_only",
      sql`${table.kind} = 'external' OR ${table.ownerUserId} IS NULL`
    ),
    check(
      "agent_principals_owner_not_self",
      sql`${table.ownerUserId} IS NULL OR ${table.ownerUserId} <> ${table.userId}`
    ),
    index("agent_principals_owner_idx").on(table.ownerUserId),
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
 * One grant row: a permission (scope) for an agent principal.
 * Pending = `approved_by IS NULL` and not revoked (the agent asked; no admin has said yes). Live = approved and not revoked.
 * Denied = never approved, revoked. Revoked = approved, then revoked. Only a live row opens a lock.
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
    /** Set when an admin approves. Null while pending or denied. */
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    /** The agent that asked, for a row that began as a request. Null for a row an admin wrote directly. */
    requestedBy: text("requested_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** `node` (default; every row before personal grants), or `delegated`: an owner's grant of a delegable scope to their agent. */
    resourceKind: text("resource_kind").notNull().default("node"),
    /** The person who owns the agent and decides a personal row. Null for a node row. */
    ownerUserId: text("owner_user_id").references(() => users.id),
    /** When a personal grant ends. Always set on an approved personal row; null for a node row. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "agent_roles_resource_kind_canonical",
      sql`${table.resourceKind} IN ('node','delegated')`
    ),
    check(
      "agent_roles_owner_shape",
      sql`(${table.resourceKind} = 'node') = (${table.ownerUserId} IS NULL)`
    ),
    check(
      "agent_roles_personal_approver",
      sql`${table.resourceKind} = 'node' OR ${table.approvedBy} IS NULL OR (${table.approvedBy} = ${table.ownerUserId} AND ${table.approvedBy} <> ${table.principalUserId} AND ${table.expiresAt} IS NOT NULL)`
    ),
    check(
      "agent_roles_personal_scope_delegable",
      sql`${table.resourceKind} = 'node' OR ${table.scope} IN ('knowledge:read','knowledge:contribute')`
    ),
    uniqueIndex("agent_roles_live_unique")
      .on(table.principalUserId, table.scope)
      .where(sql`${table.revokedAt} IS NULL`),
    index("agent_roles_principal_idx").on(table.principalUserId),
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
 * One spawn grant: a signed-in person's one-time, short-lived permission for ONE new agent to register under them.
 * `token_hash` is sha256 of the grant; the grant is never stored. pending = not redeemed and not expired (`expires_at` > now()).
 * Redeeming creates the agent's user, its owned `external` principal and a pending key, then sets `redeemed_at` and `redeemed_user_id`.
 */
export const agentSpawnGrants = pgTable(
  "agent_spawn_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issuerUserId: text("issuer_user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    redeemedUserId: text("redeemed_user_id").references(() => users.id),
  },
  (table) => [
    check(
      "agent_spawn_grants_redeemed_together",
      sql`(${table.redeemedAt} IS NULL) = (${table.redeemedUserId} IS NULL)`
    ),
    check(
      "agent_spawn_grants_expiry_after_issue",
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
    uniqueIndex("agent_spawn_grants_token_hash_unique").on(table.tokenHash),
    index("agent_spawn_grants_issuer_idx").on(table.issuerUserId),
  ]
).enableRLS();

/**
 * One claim: an EXISTING agent asked to become some person's, with its own key. The claim id is the `?claim=<id>` of the link into the person's profile (`/profile?claim=<id>`).
 * Open = `claimed_at IS NULL` and `expires_at > now()`. Single use: the person's click sets `claimed_at` and `claimed_by` together, in the same transaction that sets the owner.
 */
export const agentClaims = pgTable(
  "agent_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentUserId: text("agent_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by").references(() => users.id),
  },
  (table) => [
    check(
      "agent_claims_claimed_together",
      sql`(${table.claimedAt} IS NULL) = (${table.claimedBy} IS NULL)`
    ),
    check(
      "agent_claims_claimant_not_agent",
      sql`${table.claimedBy} IS NULL OR ${table.claimedBy} <> ${table.agentUserId}`
    ),
    index("agent_claims_agent_idx").on(table.agentUserId),
  ]
).enableRLS();

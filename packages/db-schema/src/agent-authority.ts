// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/agent-authority`
 * Purpose: Runtime agent authority tables: internal agent principals and node role rows.
 * Scope: Schema only. Reads and writes live in `@cogni-dao/agent-grants` (raw SQL over an injected client).
 * Invariants: Role rows are soft revoked; only owner-approved live rows authorize.
 *   Node and account grants share one table, with durable account grants until Off.
 *   The migration forces RLS; app-role writes are denied, account reads are self-scoped.
 *   Canonical internal identity bootstrap never grants a capability.
 * Side-effects: none (schema definitions only)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { billingAccounts, users } from "./refs";

/** Internal graph identities and external agent principals. */
export const agentPrincipals = pgTable(
  "agent_principals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    slug: text("slug"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("agent_principals_kind_canonical", sql`${table.kind} IN ('internal','external')`),
    check(
      "agent_principals_internal_has_slug",
      sql`${table.kind} <> 'internal' OR ${table.slug} IS NOT NULL`,
    ),
    uniqueIndex("agent_principals_slug_unique").on(table.slug),
    uniqueIndex("agent_principals_user_id_unique").on(table.userId),
    // Principal metadata is readable on a fresh database. FORCE RLS denies app writes;
    // legacy adoption preserves any narrower existing read policy.
    pgPolicy("agent_principals_read", { for: "select", using: sql`true` }),
  ],
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    resource: text("resource").notNull().default("node"),
    accountId: text("account_id").references(() => billingAccounts.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
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
    index("agent_roles_principal_idx").on(table.principalUserId),
    uniqueIndex("agent_roles_link_hash_unique").on(table.linkHash),
    check("agent_roles_resource_canonical", sql`${table.resource} IN ('node','account')`),
    check(
      "agent_roles_node_shape",
      sql`${table.resource} <> 'node' OR (${table.accountId} IS NULL AND ${table.expiresAt} IS NULL)`,
    ),
    check(
      "agent_roles_account_live_shape",
      sql`${table.resource} <> 'account' OR ${table.approvedBy} IS NULL OR (${table.accountId} IS NOT NULL AND ${table.grantedAt} IS NOT NULL AND (${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.grantedAt}))`,
    ),
    check(
      "agent_roles_no_self_approval",
      sql`${table.approvedBy} IS NULL OR ${table.approvedBy} <> ${table.principalUserId}`,
    ),
    check(
      "agent_roles_link_consumed_has_no_hash",
      sql`${table.linkConsumedAt} IS NULL OR ${table.linkHash} IS NULL`,
    ),
    pgPolicy("agent_roles_account_self_read", {
      for: "select",
      using: sql`${table.resource} = 'account' AND ${table.principalUserId} = current_setting('app.current_user_id', true)`,
    }),
  ],
).enableRLS();

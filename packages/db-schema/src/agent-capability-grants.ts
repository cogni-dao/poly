// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/agent-capability-grants`
 * Purpose: Expiring, revocable delegation grants from one billing account to
 *   another authenticated human or machine principal.
 * Scope: Operational Postgres schema only. Grant resolution and lifecycle
 *   behavior live in the Poly application feature.
 * Invariants:
 *   - ACCOUNT_SCOPED: every grant belongs to exactly one billing account.
 *   - EXPIRES: every grant has a mandatory expiry later than its creation.
 *   - OWNER_WRITES: only the account owner may insert, update, or delete rows.
 *   - GRANTEE_READS: a grantee may select only grants issued directly to it.
 *   - SINGLE_CURRENT_GRANT: at most one non-revoked row exists per
 *     (billing_account_id, grantee_principal_id).
 * Side-effects: none (schema only)
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

export const AGENT_CAPABILITY_SCOPE_VALUES = [
  "performance:read",
  "research:run",
  "policy:propose",
  "paper:assign",
  "live:approve",
  "live:assign",
] as const;

export const agentCapabilityGrants = pgTable(
  "agent_capability_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "cascade" }),
    granteePrincipalId: text("grantee_principal_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "agent_capability_grants_scopes_nonempty",
      sql`cardinality(${table.scopes}) > 0`
    ),
    check(
      "agent_capability_grants_scopes_canonical",
      sql`${table.scopes} <@ ARRAY['performance:read','research:run','policy:propose','paper:assign','live:approve','live:assign']::text[]`
    ),
    check(
      "agent_capability_grants_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
    check(
      "agent_capability_grants_revocation_audit",
      sql`(${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revokedByUserId} IS NOT NULL)`
    ),
    uniqueIndex("agent_capability_grants_current_idx")
      .on(table.billingAccountId, table.granteePrincipalId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("agent_capability_grants_grantee_active_idx").on(
      table.granteePrincipalId,
      table.expiresAt
    ),
    index("agent_capability_grants_account_created_idx").on(
      table.billingAccountId,
      table.createdAt
    ),
    pgPolicy("agent_capability_grants_select", {
      for: "select",
      using: sql`${table.billingAccountId} IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      ) OR ${table.granteePrincipalId} = current_setting('app.current_user_id', true)`,
    }),
    pgPolicy("agent_capability_grants_insert", {
      for: "insert",
      withCheck: sql`${table.billingAccountId} IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      ) AND ${table.createdByUserId} = current_setting('app.current_user_id', true)`,
    }),
    pgPolicy("agent_capability_grants_update", {
      for: "update",
      using: sql`${table.billingAccountId} IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      )`,
      withCheck: sql`${table.billingAccountId} IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      )`,
    }),
  ]
).enableRLS();

export type AgentCapabilityGrantRow =
  typeof agentCapabilityGrants.$inferSelect;
export type AgentCapabilityGrantInsert =
  typeof agentCapabilityGrants.$inferInsert;

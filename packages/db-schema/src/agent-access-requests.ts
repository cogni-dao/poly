// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/agent-access-requests`
 * Purpose: One-time, owner-approved requests from machine principals for a
 *   narrowly scoped capability grant.
 * Scope: Operational Postgres schema only. Raw approval tokens never persist.
 * Invariants:
 *   - REQUESTER_SELF_ONLY: agents insert and read only their own requests.
 *   - TOKEN_BOUND_OWNER_DECISION: a browser owner can preview/decide only the
 *     pending request selected by a transaction-local approval-token hash.
 *   - GRANT_IS_AUTHORITY: this row records lifecycle UX; only the linked
 *     agent_capability_grants row authorizes data-plane access.
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

import { agentCapabilityGrants } from "./agent-capability-grants";
import { billingAccounts, users } from "./refs";

export const AGENT_ACCESS_REQUEST_STATUS_VALUES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "revoked",
] as const;

export const agentAccessRequests = pgTable(
  "agent_access_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requesterPrincipalId: text("requester_principal_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requesterDisplayName: text("requester_display_name").notNull(),
    requestedScopes: text("requested_scopes").array().notNull(),
    grantExpiresAt: timestamp("grant_expires_at", {
      withTimezone: true,
    }).notNull(),
    approvalTokenHash: text("approval_token_hash").notNull(),
    approvalTokenExpiresAt: timestamp("approval_token_expires_at", {
      withTimezone: true,
    }).notNull(),
    status: text("status").notNull().default("pending"),
    billingAccountId: text("billing_account_id").references(
      () => billingAccounts.id,
      { onDelete: "cascade" }
    ),
    approvedGrantId: uuid("approved_grant_id").references(
      () => agentCapabilityGrants.id
    ),
    decisionByUserId: text("decision_by_user_id").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    tokenConsumedAt: timestamp("token_consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "agent_access_requests_status_canonical",
      sql`${table.status} IN ('pending','approved','denied','expired','revoked')`
    ),
    check(
      "agent_access_requests_scope_performance_read",
      sql`${table.requestedScopes} = ARRAY['performance:read']::text[]`
    ),
    check(
      "agent_access_requests_expiry_after_creation",
      sql`${table.grantExpiresAt} > ${table.createdAt} AND ${table.approvalTokenExpiresAt} > ${table.createdAt}`
    ),
    check(
      "agent_access_requests_lifecycle_consistent",
      sql`(
        ${table.status} IN ('pending','expired')
        AND ${table.billingAccountId} IS NULL
        AND ${table.approvedGrantId} IS NULL
        AND ${table.decisionByUserId} IS NULL
        AND ${table.decidedAt} IS NULL
        AND ${table.tokenConsumedAt} IS NULL
      ) OR (
        ${table.status} = 'denied'
        AND ${table.billingAccountId} IS NOT NULL
        AND ${table.approvedGrantId} IS NULL
        AND ${table.decisionByUserId} IS NOT NULL
        AND ${table.decidedAt} IS NOT NULL
        AND ${table.tokenConsumedAt} IS NOT NULL
      ) OR (
        ${table.status} IN ('approved','revoked')
        AND ${table.billingAccountId} IS NOT NULL
        AND ${table.approvedGrantId} IS NOT NULL
        AND ${table.decisionByUserId} IS NOT NULL
        AND ${table.decidedAt} IS NOT NULL
        AND ${table.tokenConsumedAt} IS NOT NULL
      )`
    ),
    uniqueIndex("agent_access_requests_token_hash_idx").on(
      table.approvalTokenHash
    ),
    uniqueIndex("agent_access_requests_approved_grant_idx")
      .on(table.approvedGrantId)
      .where(sql`${table.approvedGrantId} IS NOT NULL`),
    uniqueIndex("agent_access_requests_requester_pending_idx")
      .on(table.requesterPrincipalId)
      .where(sql`${table.status} = 'pending'`),
    index("agent_access_requests_account_created_idx").on(
      table.billingAccountId,
      table.createdAt
    ),
    pgPolicy("agent_access_requests_select", {
      for: "select",
      using: sql`${table.requesterPrincipalId} = current_setting('app.current_user_id', true)
        OR ${table.billingAccountId} IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = current_setting('app.current_user_id', true)
        )
        OR (
          ${table.status} = 'pending'
          AND ${table.approvalTokenHash} = current_setting('app.agent_access_request_token_hash', true)
          AND ${table.approvalTokenExpiresAt} > now()
        )`,
    }),
    pgPolicy("agent_access_requests_insert", {
      for: "insert",
      withCheck: sql`${table.requesterPrincipalId} = current_setting('app.current_user_id', true)
        AND ${table.status} = 'pending'
        AND ${table.billingAccountId} IS NULL
        AND ${table.approvedGrantId} IS NULL
        AND ${table.decisionByUserId} IS NULL`,
    }),
    pgPolicy("agent_access_requests_requester_expire", {
      for: "update",
      using: sql`${table.requesterPrincipalId} = current_setting('app.current_user_id', true)
        AND ${table.status} = 'pending'
        AND ${table.approvalTokenExpiresAt} <= now()`,
      withCheck: sql`${table.requesterPrincipalId} = current_setting('app.current_user_id', true)
        AND ${table.status} = 'expired'
        AND ${table.billingAccountId} IS NULL
        AND ${table.approvedGrantId} IS NULL
        AND ${table.decisionByUserId} IS NULL`,
    }),
    pgPolicy("agent_access_requests_owner_update", {
      for: "update",
      using: sql`${table.billingAccountId} IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = current_setting('app.current_user_id', true)
        ) OR (
          ${table.status} = 'pending'
          AND ${table.approvalTokenHash} = current_setting('app.agent_access_request_token_hash', true)
          AND ${table.approvalTokenExpiresAt} > now()
        )`,
      withCheck: sql`${table.billingAccountId} IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = current_setting('app.current_user_id', true)
        )
        AND ${table.decisionByUserId} = current_setting('app.current_user_id', true)`,
    }),
  ]
).enableRLS();

export type AgentAccessRequestRow = typeof agentAccessRequests.$inferSelect;
export type AgentAccessRequestInsert = typeof agentAccessRequests.$inferInsert;

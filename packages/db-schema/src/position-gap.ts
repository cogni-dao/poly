// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/position-gap`
 * Purpose: Durable position-gap v3 reconciliation, entitlement, action, and reservation state.
 * Scope: Schema only. Runtime transitions live in the copy-trade feature.
 * Invariants: FORCE_RLS_IN_MIGRATION, DURABLE_COHORT_ENTITLEMENT,
 *   ONE_ACTIVE_BUY_PER_COHORT, CASH_GUARD_IS_NOT_A_MEASURED_FEE.
 * Side-effects: none
 * Links: story.5015, task.1791070974
 * @public
 */

import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	check,
	index,
	jsonb,
	numeric,
	pgPolicy,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

import { billingAccounts, users } from "./refs";

function ownsAccount(column: AnyPgColumn) {
	return sql`${column} IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  )`;
}

function mayReadAccount(column: AnyPgColumn) {
	return sql`${ownsAccount(column)} OR EXISTS (
    SELECT 1 FROM agent_capability_grants grant_row
    WHERE grant_row.billing_account_id = ${column}
      AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
      AND grant_row.revoked_at IS NULL
      AND grant_row.expires_at > now()
      AND grant_row.scopes && ARRAY['account:read','performance:read']::text[]
  )`;
}

/** One auditable whole-book reconciliation attempt. */
export const polyPositionGapRuns = pgTable(
	"poly_position_gap_runs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		billingAccountId: text("billing_account_id")
			.notNull()
			.references(() => billingAccounts.id, { onDelete: "cascade" }),
		createdByUserId: text("created_by_user_id")
			.notNull()
			.references(() => users.id),
		targetId: uuid("target_id").notNull(),
		triggerReasons: jsonb("trigger_reasons")
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		targetSnapshotId: text("target_snapshot_id"),
		targetSnapshotHash: text("target_snapshot_hash"),
		targetSnapshotAsOf: timestamp("target_snapshot_as_of", {
			withTimezone: true,
		}),
		targetSnapshotExpiresAt: timestamp("target_snapshot_expires_at", {
			withTimezone: true,
		}),
		targetSnapshot: jsonb("target_snapshot").$type<Record<string, unknown>>(),
		plannerVersion: text("planner_version"),
		budgetUsdc: numeric("budget_usdc", { precision: 20, scale: 8 }).notNull(),
		eligibleNetNavUsdc: numeric("eligible_net_nav_usdc", {
			precision: 20,
			scale: 8,
		}),
		scale: numeric("scale", { precision: 30, scale: 18 }),
		walletCashUsdcAtStart: numeric("wallet_cash_usdc_at_start", {
			precision: 20,
			scale: 8,
		}).notNull(),
		reservedBudgetUsdcAtStart: numeric("reserved_budget_usdc_at_start", {
			precision: 20,
			scale: 8,
		})
			.notNull()
			.default("0"),
		reservedCashAtomicAtStart: numeric("reserved_cash_atomic_at_start", {
			precision: 30,
			scale: 0,
		})
			.notNull()
			.default("0"),
		reservedBudgetUsdcAtEnd: numeric("reserved_budget_usdc_at_end", {
			precision: 20,
			scale: 8,
		}),
		reservedCashAtomicAtEnd: numeric("reserved_cash_atomic_at_end", {
			precision: 30,
			scale: 0,
		}),
		status: text("status").notNull().default("running"),
		plan: jsonb("plan").$type<Record<string, unknown>>(),
		errorCode: text("error_code"),
		errorDetail: text("error_detail"),
		startedAt: timestamp("started_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("poly_position_gap_runs_account_target_started_idx").on(
			table.billingAccountId,
			table.targetId,
			table.startedAt.desc(),
		),
		index("poly_position_gap_runs_running_idx")
			.on(table.billingAccountId, table.targetId)
			.where(sql`${table.status} = 'running'`),
		check(
			"poly_position_gap_runs_status_check",
			sql`${table.status} IN ('running','completed','skipped','halted','failed')`,
		),
		check(
			"poly_position_gap_runs_nonnegative_check",
			sql`${table.budgetUsdc} > 0
        AND ${table.walletCashUsdcAtStart} >= 0
        AND ${table.reservedBudgetUsdcAtStart} >= 0
        AND ${table.reservedCashAtomicAtStart} >= 0
        AND (${table.eligibleNetNavUsdc} IS NULL OR ${table.eligibleNetNavUsdc} >= 0)
        AND (${table.reservedBudgetUsdcAtEnd} IS NULL OR ${table.reservedBudgetUsdcAtEnd} >= 0)
        AND (${table.reservedCashAtomicAtEnd} IS NULL OR ${table.reservedCashAtomicAtEnd} >= 0)`,
		),
		pgPolicy("poly_position_gap_runs_select", {
			for: "select",
			using: mayReadAccount(table.billingAccountId),
		}),
		pgPolicy("poly_position_gap_runs_insert", {
			for: "insert",
			withCheck: ownsAccount(table.billingAccountId),
		}),
		pgPolicy("poly_position_gap_runs_update", {
			for: "update",
			using: ownsAccount(table.billingAccountId),
			withCheck: ownsAccount(table.billingAccountId),
		}),
		pgPolicy("poly_position_gap_runs_delete", {
			for: "delete",
			using: ownsAccount(table.billingAccountId),
		}),
	],
).enableRLS();

/**
 * Durable position entitlement slices. Existing allowance only decreases;
 * target/config growth creates a new, provenance-bound cohort.
 */
export const polyPositionGapCohorts = pgTable(
	"poly_position_gap_cohorts",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		billingAccountId: text("billing_account_id")
			.notNull()
			.references(() => billingAccounts.id, { onDelete: "cascade" }),
		createdByUserId: text("created_by_user_id")
			.notNull()
			.references(() => users.id),
		targetId: uuid("target_id").notNull(),
		cohortKey: text("cohort_key").notNull(),
		sourceKind: text("source_kind").notNull(),
		sourceEventId: text("source_event_id"),
		sourceConfigRevision: text("source_config_revision"),
		sourceSnapshotId: text("source_snapshot_id").notNull(),
		sourceSnapshotHash: text("source_snapshot_hash").notNull(),
		sourceSnapshotAsOf: timestamp("source_snapshot_as_of", {
			withTimezone: true,
		}).notNull(),
		sourceProvenance: jsonb("source_provenance")
			.$type<Record<string, unknown>>()
			.notNull(),
		createdRunId: uuid("created_run_id")
			.notNull()
			.references(() => polyPositionGapRuns.id, { onDelete: "restrict" }),
		conditionId: text("condition_id").notNull(),
		tokenId: text("token_id").notNull(),
		marketId: text("market_id").notNull(),
		outcome: text("outcome").notNull(),
		targetDeltaShares: numeric("target_delta_shares", {
			precision: 30,
			scale: 12,
		}).notNull(),
		scaleAtCreation: numeric("scale_at_creation", {
			precision: 30,
			scale: 18,
		}).notNull(),
		allowedMirrorShares: numeric("allowed_mirror_shares", {
			precision: 30,
			scale: 12,
		}).notNull(),
		initialAllowedMirrorShares: numeric("initial_allowed_mirror_shares", {
			precision: 30,
			scale: 12,
		}).notNull(),
		benchmarkTargetVwap: numeric("benchmark_target_vwap", {
			precision: 20,
			scale: 10,
		}).notNull(),
		acquiredShares: numeric("acquired_shares", {
			precision: 30,
			scale: 12,
		})
			.notNull()
			.default("0"),
		openOrderShares: numeric("open_order_shares", {
			precision: 30,
			scale: 12,
		})
			.notNull()
			.default("0"),
		remainingShares: numeric("remaining_shares", {
			precision: 30,
			scale: 12,
		}).notNull(),
		status: text("status").notNull().default("available"),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("poly_position_gap_cohorts_key_unique").on(
			table.billingAccountId,
			table.targetId,
			table.cohortKey,
		),
		index("poly_position_gap_cohorts_reduction_idx").on(
			table.billingAccountId,
			table.targetId,
			table.benchmarkTargetVwap.desc(),
			table.createdAt.desc(),
		),
		check(
			"poly_position_gap_cohorts_source_kind_check",
			sql`${table.sourceKind} IN ('activation','target_buy','config_increase')`,
		),
		check(
			"poly_position_gap_cohorts_status_check",
			sql`${table.status} IN ('available','resting','exhausted','reduced','over_target','resolved')`,
		),
		check(
			"poly_position_gap_cohorts_nonnegative_check",
			sql`${table.targetDeltaShares} >= 0
        AND ${table.scaleAtCreation} >= 0
        AND ${table.allowedMirrorShares} >= 0
		AND ${table.initialAllowedMirrorShares} >= ${table.allowedMirrorShares}
        AND ${table.benchmarkTargetVwap} > 0
        AND ${table.benchmarkTargetVwap} < 1
        AND ${table.acquiredShares} >= 0
        AND ${table.openOrderShares} >= 0
        AND ${table.remainingShares} >= 0`,
		),
		check(
			"poly_position_gap_cohorts_accounting_check",
			// Filled/resting shares may temporarily exceed a reduced buy-only target;
			// `over_target` makes that drift explicit while cancellation catches up.
			sql`${table.remainingShares} <= ${table.allowedMirrorShares}`,
		),
		pgPolicy("poly_position_gap_cohorts_select", {
			for: "select",
			using: mayReadAccount(table.billingAccountId),
		}),
		pgPolicy("poly_position_gap_cohorts_insert", {
			for: "insert",
			withCheck: ownsAccount(table.billingAccountId),
		}),
		pgPolicy("poly_position_gap_cohorts_update", {
			for: "update",
			using: ownsAccount(table.billingAccountId),
			withCheck: ownsAccount(table.billingAccountId),
		}),
		pgPolicy("poly_position_gap_cohorts_delete", {
			for: "delete",
			using: ownsAccount(table.billingAccountId),
		}),
	],
).enableRLS();

/** Durable order/cancel command tape emitted by a reconciliation run. */
export const polyPositionGapActions = pgTable(
	"poly_position_gap_actions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		billingAccountId: text("billing_account_id")
			.notNull()
			.references(() => billingAccounts.id, { onDelete: "cascade" }),
		createdByUserId: text("created_by_user_id")
			.notNull()
			.references(() => users.id),
		targetId: uuid("target_id").notNull(),
		runId: uuid("run_id")
			.notNull()
			.references(() => polyPositionGapRuns.id, { onDelete: "restrict" }),
		cohortId: uuid("cohort_id")
			.notNull()
			.references(() => polyPositionGapCohorts.id, { onDelete: "restrict" }),
		cohortKey: text("cohort_key").notNull(),
		actionKey: text("action_key").notNull(),
		kind: text("kind").notNull(),
		relatedBuyActionId: uuid("related_buy_action_id"),
		conditionId: text("condition_id").notNull(),
		tokenId: text("token_id").notNull(),
		marketId: text("market_id").notNull(),
		outcome: text("outcome").notNull(),
		desiredShares: numeric("desired_shares", { precision: 30, scale: 12 }),
		notionalUsdc: numeric("notional_usdc", { precision: 20, scale: 8 }),
		limitPrice: numeric("limit_price", { precision: 20, scale: 10 }),
		filledShares: numeric("filled_shares", { precision: 30, scale: 12 })
			.notNull()
			.default("0"),
		filledUsdc: numeric("filled_usdc", { precision: 20, scale: 8 })
			.notNull()
			.default("0"),
		plannerAction: jsonb("planner_action")
			.$type<Record<string, unknown>>()
			.notNull(),
		clientOrderId: text("client_order_id"),
		orderId: text("order_id"),
		status: text("status").notNull().default("reserved"),
		venueStatus: text("venue_status"),
		venueObservedAt: timestamp("venue_observed_at", { withTimezone: true }),
		errorCode: text("error_code"),
		errorDetail: text("error_detail"),
		submitStartedAt: timestamp("submit_started_at", { withTimezone: true }),
		submittedAt: timestamp("submitted_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("poly_position_gap_actions_key_unique").on(
			table.billingAccountId,
			table.targetId,
			table.actionKey,
		),
		uniqueIndex("poly_position_gap_actions_client_order_unique")
			.on(table.clientOrderId)
			.where(sql`${table.clientOrderId} IS NOT NULL`),
		uniqueIndex("poly_position_gap_actions_one_open_buy_per_cohort")
			.on(table.billingAccountId, table.targetId, table.cohortKey)
			.where(
				sql`${table.kind} = 'buy'
			  AND ${table.status} IN ('reserved','ledgered','submitting','open','partial','cancel_requested','ambiguous')`,
			),
		index("poly_position_gap_actions_run_idx").on(table.runId, table.createdAt),
		index("poly_position_gap_actions_order_idx").on(table.orderId),
		check(
			"poly_position_gap_actions_kind_check",
			sql`${table.kind} IN ('buy','cancel')`,
		),
		check(
			"poly_position_gap_actions_status_check",
			sql`${table.status} IN ('reserved','ledgered','submitting','open','partial','filled','cancel_requested','canceled','rejected','ambiguous')`,
		),
		check(
			"poly_position_gap_actions_buy_shape_check",
			sql`${table.kind} <> 'buy' OR (
        ${table.desiredShares} > 0
        AND ${table.notionalUsdc} > 0
        AND ${table.limitPrice} > 0
        AND ${table.limitPrice} < 1
        AND ${table.clientOrderId} IS NOT NULL
      )`,
		),
		check(
			"poly_position_gap_actions_filled_check",
			sql`${table.filledShares} >= 0 AND ${table.filledUsdc} >= 0`,
		),
		pgPolicy("poly_position_gap_actions_select", {
			for: "select",
			using: mayReadAccount(table.billingAccountId),
		}),
		pgPolicy("poly_position_gap_actions_insert", {
			for: "insert",
			withCheck: ownsAccount(table.billingAccountId),
		}),
		pgPolicy("poly_position_gap_actions_update", {
			for: "update",
			using: ownsAccount(table.billingAccountId),
			withCheck: ownsAccount(table.billingAccountId),
		}),
		pgPolicy("poly_position_gap_actions_delete", {
			for: "delete",
			using: ownsAccount(table.billingAccountId),
		}),
	],
).enableRLS();

/** Durable budget and executor cash-guard hold for one BUY action. */
export const polyPositionGapReservations = pgTable(
	"poly_position_gap_reservations",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		billingAccountId: text("billing_account_id")
			.notNull()
			.references(() => billingAccounts.id, { onDelete: "cascade" }),
		createdByUserId: text("created_by_user_id")
			.notNull()
			.references(() => users.id),
		targetId: uuid("target_id").notNull(),
		cohortId: uuid("cohort_id")
			.notNull()
			.references(() => polyPositionGapCohorts.id, { onDelete: "restrict" }),
		buyActionId: uuid("buy_action_id")
			.notNull()
			.references(() => polyPositionGapActions.id, { onDelete: "restrict" }),
		budgetNotionalUsdc: numeric("budget_notional_usdc", {
			precision: 20,
			scale: 8,
		}).notNull(),
		executorCashGuardAtomic: numeric("executor_cash_guard_atomic", {
			precision: 30,
			scale: 0,
		}).notNull(),
		cashGuardSource: text("cash_guard_source").notNull(),
		filledCostUsdc: numeric("filled_cost_usdc", {
			precision: 20,
			scale: 8,
		})
			.notNull()
			.default("0"),
		releasedBudgetUsdc: numeric("released_budget_usdc", {
			precision: 20,
			scale: 8,
		})
			.notNull()
			.default("0"),
		releasedCashGuardAtomic: numeric("released_cash_guard_atomic", {
			precision: 30,
			scale: 0,
		})
			.notNull()
			.default("0"),
		state: text("state").notNull().default("active"),
		releaseReason: text("release_reason"),
		releasedAt: timestamp("released_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("poly_position_gap_reservations_buy_action_unique").on(
			table.buyActionId,
		),
		index("poly_position_gap_reservations_active_account_idx")
			.on(table.billingAccountId, table.targetId)
			.where(sql`${table.state} = 'active'`),
		check(
			"poly_position_gap_reservations_state_check",
			sql`${table.state} IN ('active','released')`,
		),
		check(
			"poly_position_gap_reservations_amounts_check",
			sql`${table.budgetNotionalUsdc} > 0
        AND ${table.executorCashGuardAtomic} > 0
        AND ${table.filledCostUsdc} >= 0
        AND ${table.releasedBudgetUsdc} >= 0
        AND ${table.releasedBudgetUsdc} <= ${table.budgetNotionalUsdc}
        AND ${table.releasedCashGuardAtomic} >= 0
        AND ${table.releasedCashGuardAtomic} <= ${table.executorCashGuardAtomic}`,
		),
		pgPolicy("poly_position_gap_reservations_select", {
			for: "select",
			using: mayReadAccount(table.billingAccountId),
		}),
		pgPolicy("poly_position_gap_reservations_insert", {
			for: "insert",
			withCheck: ownsAccount(table.billingAccountId),
		}),
		pgPolicy("poly_position_gap_reservations_update", {
			for: "update",
			using: ownsAccount(table.billingAccountId),
			withCheck: ownsAccount(table.billingAccountId),
		}),
		pgPolicy("poly_position_gap_reservations_delete", {
			for: "delete",
			using: ownsAccount(table.billingAccountId),
		}),
	],
).enableRLS();

export type PolyPositionGapRun = typeof polyPositionGapRuns.$inferSelect;
export type NewPolyPositionGapRun = typeof polyPositionGapRuns.$inferInsert;
export type PolyPositionGapCohort = typeof polyPositionGapCohorts.$inferSelect;
export type NewPolyPositionGapCohort =
	typeof polyPositionGapCohorts.$inferInsert;
export type PolyPositionGapAction = typeof polyPositionGapActions.$inferSelect;
export type NewPolyPositionGapAction =
	typeof polyPositionGapActions.$inferInsert;
export type PolyPositionGapReservation =
	typeof polyPositionGapReservations.$inferSelect;
export type NewPolyPositionGapReservation =
	typeof polyPositionGapReservations.$inferInsert;

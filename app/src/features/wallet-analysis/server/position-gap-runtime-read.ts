// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Bounded latest-run read model shared by the owner UI and account-read agents. */

import { polyCopyTradeFills } from "@cogni/db-schema/copy-trade";
import {
	polyPositionGapActions,
	polyPositionGapRuns,
} from "@cogni/db-schema/position-gap";
import {
	PolyPositionGapFillAccountingMismatchReasonSchema,
	type PolyPositionGapRuntime,
	PolyPositionGapRuntimeSchema,
} from "@cogni/poly-node-contracts";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { AgentGrantTransaction } from "@/features/agent-grants/authorization";
import { targetIdFromWallet } from "@/shared/util/poly-target-id";

const MAX_POSITIONS = 2_000;
const MAX_RECENT_ORDERS = 50;
type Run = {
	id: string;
	targetId: string;
	triggerReasons: string[];
	targetSnapshotId: string | null;
	targetSnapshotAsOf: Date | string | null;
	targetSnapshotExpiresAt: Date | string | null;
	targetSnapshot: Record<string, unknown> | null;
	plannerVersion: string | null;
	budgetUsdc: string | number;
	eligibleNetNavUsdc: string | number | null;
	scale: string | number | null;
	walletCashUsdcAtStart: string | number;
	reservedBudgetUsdcAtStart: string | number;
	reservedCashAtomicAtStart: string | number;
	reservedBudgetUsdcAtEnd: string | number | null;
	reservedCashAtomicAtEnd: string | number | null;
	status: string;
	plan: Record<string, unknown> | null;
	errorCode: string | null;
	startedAt: Date | string;
	completedAt: Date | string | null;
};

type RecentOrder = {
	id: string;
	targetId: string;
	clientOrderId: string;
	orderId: string | null;
	conditionId: string;
	tokenId: string;
	status: string;
	submitStartedAt: Date | string | null;
	completedAt: Date | string | null;
	desiredShares: string | number;
	notionalUsdc: string | number;
	limitPrice: string | number;
	plannerAction: Record<string, unknown>;
	ledgerPrice: string | number | null;
	ledgerShares: string | number | null;
	ledgerFeesUsdc: string | number | null;
	ledgerAttributes: Record<string, unknown> | null;
};

const rowsOf = <T>(result: unknown): T[] =>
	Array.isArray(result)
		? (result as T[])
		: (((result as { rows?: T[] }).rows ?? []) as T[]);

const numberOf = (value: unknown): number | null => {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const recordOf = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
const isoOf = (value: Date | string | null): string | null => {
	if (value === null) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

function toRecentOrder(row: RecentOrder) {
	const attributes = recordOf(row.ledgerAttributes) ?? {};
	const source = attributes.realized_fill_source;
	const realizedShares = numberOf(row.ledgerShares);
	const realizedUsdc = numberOf(attributes.filled_size_usdc);
	const realizedPrice = numberOf(row.ledgerPrice);
	const verified =
		(source === "clob_associated_trades" ||
			source === "data_api_activity_position") &&
		realizedShares !== null &&
		realizedShares > 0 &&
		realizedUsdc !== null &&
		realizedUsdc > 0 &&
		realizedPrice !== null &&
		realizedPrice > 0;
	const mismatchReason =
		row.plannerAction.fill_accounting_status === "mismatch"
			? PolyPositionGapFillAccountingMismatchReasonSchema.safeParse(
					row.plannerAction.fill_accounting_mismatch_reason,
				).data
			: undefined;
	const fillAccounting = verified
		? {
				status: "verified" as const,
				source,
				matched_order_count: 1,
				realized_shares: realizedShares,
				realized_entry_notional_usdc: realizedUsdc,
			}
		: mismatchReason
			? {
					status: "mismatch" as const,
					source: "data_api_activity_position" as const,
					reason: mismatchReason,
				}
			: {
					status: "pending" as const,
					source: "clob_order_receipt" as const,
				};
	return {
		action_id: row.id,
		client_order_id: row.clientOrderId,
		order_id: row.orderId,
		condition_id: row.conditionId,
		token_id: row.tokenId,
		status: row.status,
		submit_started_at: isoOf(row.submitStartedAt),
		completed_at: isoOf(row.completedAt),
		intended_shares: numberOf(row.desiredShares),
		intended_notional_usdc: numberOf(row.notionalUsdc),
		limit_price: numberOf(row.limitPrice),
		fill_accounting: fillAccounting,
		realized_fill_price: verified ? realizedPrice : null,
		fees_usdc: verified ? numberOf(row.ledgerFeesUsdc) : null,
	};
}

function runtimeFromRun(
	run: Run,
	execution: {
		submitted: unknown;
		reportedMatched: unknown;
		verifiedMatched: unknown;
		verifiedShares: unknown;
		verifiedUsdc: unknown;
		clobVerified: unknown;
		dataApiVerified: unknown;
		mismatched: unknown;
		mismatchReason: unknown;
	},
	recentOrders: readonly RecentOrder[],
	capturedAt: Date,
): PolyPositionGapRuntime {
	const plan = recordOf(run.plan);
	const snapshot = recordOf(run.targetSnapshot);
	if (
		!plan ||
		!snapshot ||
		!Array.isArray(plan.diagnostics) ||
		!Array.isArray(plan.intents) ||
		!Array.isArray(plan.lockedOverweights)
	) {
		return { status: "unavailable", reason: "invalid_reconciliation_record" };
	}

	const locked = new Map<string, number>();
	for (const value of plan.lockedOverweights) {
		const row = recordOf(value);
		const conditionId = row?.conditionId;
		const tokenId = row?.tokenId;
		const shares = numberOf(row?.excessShares);
		if (
			typeof conditionId !== "string" ||
			typeof tokenId !== "string" ||
			shares === null
		) {
			return { status: "unavailable", reason: "invalid_reconciliation_record" };
		}
		locked.set(
			`${conditionId}\0${tokenId}`,
			(locked.get(`${conditionId}\0${tokenId}`) ?? 0) + shares,
		);
	}

	const positions = plan.diagnostics.map((value) => {
		const row = recordOf(value) ?? {};
		return {
			condition_id: row.conditionId,
			token_id: row.tokenId,
			cohort_id: row.cohortId,
			decision_reason: row.reason,
			desired_shares: numberOf(row.desiredShares),
			held_shares: numberOf(row.heldShares),
			open_shares: numberOf(row.openShares),
			gap_shares: numberOf(row.gapShares),
			target_weight: numberOf(row.targetWeight),
			price_cap: row.limitPrice === null ? null : numberOf(row.limitPrice),
			market_floor_usdc:
				row.floorNotionalUsdc === null ? null : numberOf(row.floorNotionalUsdc),
			minimum_sleeve_usdc:
				row.minimumSleeveUsdc === null ? null : numberOf(row.minimumSleeveUsdc),
			locked_overweight_shares:
				typeof row.conditionId === "string" && typeof row.tokenId === "string"
					? (locked.get(`${row.conditionId}\0${row.tokenId}`) ?? 0)
					: null,
		};
	});
	positions.sort(
		(left, right) =>
			Number(right.target_weight) - Number(left.target_weight) ||
			String(left.condition_id).localeCompare(String(right.condition_id)) ||
			String(left.token_id).localeCompare(String(right.token_id)),
	);

	const savedSleeve = numberOf(plan.sleeveBudgetUsdc);
	const sleeve =
		savedSleeve && savedSleeve > 0 ? savedSleeve : numberOf(run.budgetUsdc);
	const reservedBudget =
		numberOf(run.reservedBudgetUsdcAtEnd) ??
		numberOf(run.reservedBudgetUsdcAtStart);
	const reservedCash =
		(numberOf(run.reservedCashAtomicAtEnd) ??
			numberOf(run.reservedCashAtomicAtStart) ??
			0) / 1_000_000;
	const walletCash = numberOf(run.walletCashUsdcAtStart);
	const expiresAt = run.targetSnapshotExpiresAt;
	const expiresAtMs = expiresAt === null ? null : new Date(expiresAt).getTime();
	const reportedMatched = numberOf(execution.reportedMatched) ?? 0;
	const verifiedMatched = numberOf(execution.verifiedMatched) ?? 0;
	const verifiedShares = numberOf(execution.verifiedShares) ?? 0;
	const verifiedUsdc = numberOf(execution.verifiedUsdc) ?? 0;
	const mismatch = PolyPositionGapFillAccountingMismatchReasonSchema.safeParse(
		execution.mismatchReason,
	);
	const mismatchReason = mismatch.success ? mismatch.data : null;
	const mismatched = numberOf(execution.mismatched) ?? 0;
	const clobVerified = (numberOf(execution.clobVerified) ?? 0) > 0;
	const dataApiVerified = (numberOf(execution.dataApiVerified) ?? 0) > 0;
	const verifiedSource =
		clobVerified && dataApiVerified
			? ("mixed_verified_sources" as const)
			: dataApiVerified
				? ("data_api_activity_position" as const)
				: ("clob_associated_trades" as const);
	const fillAccounting =
		reportedMatched > 0 &&
		reportedMatched === verifiedMatched &&
		verifiedShares > 0 &&
		verifiedUsdc > 0
			? {
					status: "verified" as const,
					source: verifiedSource,
					matched_order_count: verifiedMatched,
					realized_shares: verifiedShares,
					realized_entry_notional_usdc: verifiedUsdc,
				}
			: mismatched > 0 && mismatchReason !== null
				? {
						status: "mismatch" as const,
						source: "data_api_activity_position" as const,
						reason: mismatchReason,
					}
				: {
						status: "pending" as const,
						source: "clob_order_receipt" as const,
					};
	const orderRows = recentOrders.map(toRecentOrder);
	const parsed = PolyPositionGapRuntimeSchema.safeParse({
		status: "observed",
		run: {
			run_id: run.id,
			status: run.status,
			planner_version: run.plannerVersion,
			started_at: isoOf(run.startedAt),
			completed_at: isoOf(run.completedAt),
			trigger_reasons: run.triggerReasons,
			error_code: run.errorCode,
		},
		snapshot: {
			snapshot_id: run.targetSnapshotId,
			as_of: isoOf(run.targetSnapshotAsOf),
			expires_at: isoOf(expiresAt),
			completeness: snapshot.complete === true ? "complete" : "incomplete",
			freshness:
				expiresAtMs !== null && Number.isFinite(expiresAtMs)
					? expiresAtMs > capturedAt.getTime()
						? "fresh"
						: "stale"
					: "unknown",
		},
		plan: {
			status: plan.status,
			block_reason: plan.blockReason,
			eligible_net_nav_usdc:
				numberOf(plan.eligibleNetNavUsdc) ?? numberOf(run.eligibleNetNavUsdc),
			scale: numberOf(plan.scale) ?? numberOf(run.scale),
			sleeve_budget_usdc: sleeve,
			reserved_budget_usdc: reservedBudget,
			free_sleeve_budget_usdc:
				sleeve === null || reservedBudget === null
					? null
					: Math.max(0, sleeve - reservedBudget),
			reserved_cash_guard_usdc: reservedCash,
			free_wallet_cash_after_guards_usdc:
				walletCash === null ? null : Math.max(0, walletCash - reservedCash),
			minimum_feasible_sleeve_usdc: plan.minimumFeasibleSleeveUsdc,
			planned_order_count: plan.intents.length,
			locked_overweight_count: plan.lockedOverweights.length,
		},
		execution: {
			scope: "target_lifetime",
			submitted_order_count: numberOf(execution.submitted),
			fill_accounting: fillAccounting,
			recent_orders_truncated: orderRows.length > MAX_RECENT_ORDERS,
			recent_orders: orderRows.slice(0, MAX_RECENT_ORDERS),
		},
		position_count: positions.length,
		positions_truncated: positions.length > MAX_POSITIONS,
		positions: positions.slice(0, MAX_POSITIONS),
	});
	return parsed.success
		? parsed.data
		: { status: "unavailable", reason: "invalid_reconciliation_record" };
}

export async function readPositionGapRuntimeByWallet(
	tx: AgentGrantTransaction,
	accountId: string,
	wallets: readonly string[],
	capturedAt: Date,
): Promise<Map<string, PolyPositionGapRuntime>> {
	const walletByTargetId = new Map(
		wallets.map((wallet) => [
			targetIdFromWallet(wallet as `0x${string}`),
			wallet.toLowerCase(),
		]),
	);
	const targetIds = [...walletByTargetId.keys()];
	if (targetIds.length === 0) return new Map();
	const runs = rowsOf<Run>(
		await tx.execute(positionGapLatestRunsSelect(accountId, targetIds)),
	);
	const observedTargetIds = runs.map((run) => run.targetId);
	const actionRows =
		runs.length === 0
			? []
			: await positionGapActionAggregateSelect(
					tx,
					accountId,
					observedTargetIds,
				);
	const execution = new Map(actionRows.map((row) => [row.targetId, row]));
	const recentOrders =
		runs.length === 0
			? []
			: rowsOf<RecentOrder>(
					await tx.execute(
						positionGapRecentOrdersSelect(accountId, observedTargetIds),
					),
				);
	const recentOrdersByTarget = new Map<string, RecentOrder[]>();
	for (const order of recentOrders) {
		const rows = recentOrdersByTarget.get(order.targetId) ?? [];
		rows.push(order);
		recentOrdersByTarget.set(order.targetId, rows);
	}
	return new Map(
		runs.map((run) => [
			walletByTargetId.get(run.targetId) ?? "",
			runtimeFromRun(
				run,
				execution.get(run.targetId) ?? {
					submitted: 0,
					reportedMatched: 0,
					verifiedMatched: 0,
					verifiedShares: 0,
					verifiedUsdc: 0,
					clobVerified: 0,
					dataApiVerified: 0,
					mismatched: 0,
					mismatchReason: null,
				},
				recentOrdersByTarget.get(run.targetId) ?? [],
				capturedAt,
			),
		]),
	);
}

/** Bounded newest PGv3 BUY tape per target for account-read parity. */
export const positionGapRecentOrdersSelect = (
	accountId: string,
	targetIds: readonly string[],
) => sql`
	SELECT
		a.id AS "id", a.target_id AS "targetId",
		a.client_order_id AS "clientOrderId", a.order_id AS "orderId",
		a.condition_id AS "conditionId", a.token_id AS "tokenId",
		a.status AS "status", a.submit_started_at AS "submitStartedAt",
		a.completed_at AS "completedAt", a.desired_shares AS "desiredShares",
		a.notional_usdc AS "notionalUsdc", a.limit_price AS "limitPrice",
		a.planner_action AS "plannerAction", f.price AS "ledgerPrice",
		f.shares AS "ledgerShares", f.fees_usdc AS "ledgerFeesUsdc",
		f.attributes AS "ledgerAttributes"
	FROM unnest(ARRAY[${sql.join(
		targetIds.map((id) => sql`${id}::uuid`),
		sql`, `,
	)}]::uuid[]) AS wanted(target_id)
	CROSS JOIN LATERAL (
		SELECT * FROM ${polyPositionGapActions}
		WHERE ${polyPositionGapActions.billingAccountId} = ${accountId}
			AND ${polyPositionGapActions.targetId} = wanted.target_id
			AND ${polyPositionGapActions.kind} = 'buy'
			AND ${polyPositionGapActions.clientOrderId} IS NOT NULL
		ORDER BY ${polyPositionGapActions.createdAt} DESC
		LIMIT ${MAX_RECENT_ORDERS + 1}
	) AS a
	LEFT JOIN ${polyCopyTradeFills} AS f
		ON f.billing_account_id = a.billing_account_id
		AND f.target_id = a.target_id
		AND f.client_order_id = a.client_order_id
	ORDER BY a.target_id, a.created_at DESC
`;

/** Exact latest-run query, exported for its component EXPLAIN proof. */
export const positionGapLatestRunsSelect = (
	accountId: string,
	targetIds: readonly string[],
) =>
	sql`
		SELECT
			r.id AS "id", r.target_id AS "targetId",
			r.trigger_reasons AS "triggerReasons",
			r.target_snapshot_id AS "targetSnapshotId",
			r.target_snapshot_as_of AS "targetSnapshotAsOf",
			r.target_snapshot_expires_at AS "targetSnapshotExpiresAt",
			r.target_snapshot AS "targetSnapshot",
			r.planner_version AS "plannerVersion", r.budget_usdc AS "budgetUsdc",
			r.eligible_net_nav_usdc AS "eligibleNetNavUsdc", r.scale AS "scale",
			r.wallet_cash_usdc_at_start AS "walletCashUsdcAtStart",
			r.reserved_budget_usdc_at_start AS "reservedBudgetUsdcAtStart",
			r.reserved_cash_atomic_at_start AS "reservedCashAtomicAtStart",
			r.reserved_budget_usdc_at_end AS "reservedBudgetUsdcAtEnd",
			r.reserved_cash_atomic_at_end AS "reservedCashAtomicAtEnd",
			r.status AS "status", r.plan AS "plan", r.error_code AS "errorCode",
			r.started_at AS "startedAt", r.completed_at AS "completedAt"
		FROM unnest(ARRAY[${sql.join(
			targetIds.map((id) => sql`${id}::uuid`),
			sql`, `,
		)}]::uuid[]) AS wanted(target_id)
		CROSS JOIN LATERAL (
			SELECT * FROM ${polyPositionGapRuns}
			WHERE ${polyPositionGapRuns.billingAccountId} = ${accountId}
				AND ${polyPositionGapRuns.targetId} = wanted.target_id
			ORDER BY ${polyPositionGapRuns.startedAt} DESC
			LIMIT 1
		) AS r
		ORDER BY r.target_id
	`;

/** Exact action aggregate, exported for its component EXPLAIN proof. */
export const positionGapActionAggregateSelect = (
	tx: AgentGrantTransaction,
	accountId: string,
	targetIds: readonly string[],
) =>
	tx
		.select({
			targetId: polyPositionGapActions.targetId,
			submitted: sql<string>`count(*) FILTER (WHERE ${polyPositionGapActions.kind} = 'buy' AND ${polyPositionGapActions.submittedAt} IS NOT NULL)`,
			reportedMatched: sql<string>`count(*) FILTER (WHERE ${polyPositionGapActions.kind} = 'buy' AND ${polyPositionGapActions.filledShares} > 0)`,
			verifiedMatched: sql<string>`count(*) FILTER (WHERE ${polyPositionGapActions.kind} = 'buy' AND ${polyCopyTradeFills.attributes}->>'realized_fill_source' IN ('clob_associated_trades', 'data_api_activity_position') AND ${polyCopyTradeFills.shares} > 0 AND COALESCE(${polyCopyTradeFills.attributes}->>'filled_size_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$')`,
			verifiedShares: sql<string>`COALESCE(SUM(${polyCopyTradeFills.shares}) FILTER (WHERE ${polyPositionGapActions.kind} = 'buy' AND ${polyCopyTradeFills.attributes}->>'realized_fill_source' IN ('clob_associated_trades', 'data_api_activity_position') AND ${polyCopyTradeFills.shares} > 0 AND COALESCE(${polyCopyTradeFills.attributes}->>'filled_size_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$'), 0)`,
			verifiedUsdc: sql<string>`COALESCE(SUM(CASE WHEN ${polyPositionGapActions.kind} = 'buy' AND ${polyCopyTradeFills.attributes}->>'realized_fill_source' IN ('clob_associated_trades', 'data_api_activity_position') AND COALESCE(${polyCopyTradeFills.attributes}->>'filled_size_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (${polyCopyTradeFills.attributes}->>'filled_size_usdc')::numeric ELSE 0 END), 0)`,
			clobVerified: sql<string>`count(*) FILTER (WHERE ${polyCopyTradeFills.attributes}->>'realized_fill_source' = 'clob_associated_trades')`,
			dataApiVerified: sql<string>`count(*) FILTER (WHERE ${polyCopyTradeFills.attributes}->>'realized_fill_source' = 'data_api_activity_position')`,
			mismatched: sql<string>`count(*) FILTER (WHERE ${polyPositionGapActions.plannerAction}->>'fill_accounting_status' = 'mismatch')`,
			mismatchReason: sql<
				string | null
			>`min(${polyPositionGapActions.plannerAction}->>'fill_accounting_mismatch_reason') FILTER (WHERE ${polyPositionGapActions.plannerAction}->>'fill_accounting_status' = 'mismatch')`,
		})
		.from(polyPositionGapActions)
		.leftJoin(
			polyCopyTradeFills,
			and(
				eq(
					polyCopyTradeFills.billingAccountId,
					polyPositionGapActions.billingAccountId,
				),
				eq(polyCopyTradeFills.targetId, polyPositionGapActions.targetId),
				eq(
					polyCopyTradeFills.clientOrderId,
					polyPositionGapActions.clientOrderId,
				),
			),
		)
		.where(
			and(
				eq(polyPositionGapActions.billingAccountId, accountId),
				inArray(polyPositionGapActions.targetId, targetIds),
			),
		)
		.groupBy(polyPositionGapActions.targetId);

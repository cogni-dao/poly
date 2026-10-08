// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Bounded latest-run read model shared by the owner UI and account-read agents. */

import {
	polyPositionGapActions,
	polyPositionGapRuns,
} from "@cogni/db-schema/position-gap";
import {
	type PolyPositionGapRuntime,
	PolyPositionGapRuntimeSchema,
} from "@cogni/poly-node-contracts";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { AgentGrantTransaction } from "@/features/agent-grants/authorization";
import { targetIdFromWallet } from "@/shared/util/poly-target-id";

const MAX_POSITIONS = 2_000;
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

function runtimeFromRun(
	run: Run,
	execution: {
		submitted: unknown;
		filled: unknown;
		shares: unknown;
		usdc: unknown;
	},
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
			filled_order_count: numberOf(execution.filled),
			filled_shares: numberOf(execution.shares),
			filled_usdc: numberOf(execution.usdc),
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
	const targetIds = wallets.map((wallet) =>
		targetIdFromWallet(wallet as `0x${string}`),
	);
	const walletByTargetId = new Map(
		targetIds.map((targetId, index) => [
			targetId,
			wallets[index]?.toLowerCase() ?? "",
		]),
	);
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
	return new Map(
		runs.map((run) => [
			walletByTargetId.get(run.targetId) ?? "",
			runtimeFromRun(
				run,
				execution.get(run.targetId) ?? {
					submitted: 0,
					filled: 0,
					shares: 0,
					usdc: 0,
				},
				capturedAt,
			),
		]),
	);
}

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
			filled: sql<string>`count(*) FILTER (WHERE ${polyPositionGapActions.kind} = 'buy' AND ${polyPositionGapActions.filledShares} > 0)`,
			shares: sql<string>`COALESCE(SUM(${polyPositionGapActions.filledShares}) FILTER (WHERE ${polyPositionGapActions.kind} = 'buy'), 0)`,
			usdc: sql<string>`COALESCE(SUM(${polyPositionGapActions.filledUsdc}) FILTER (WHERE ${polyPositionGapActions.kind} = 'buy'), 0)`,
		})
		.from(polyPositionGapActions)
		.where(
			and(
				eq(polyPositionGapActions.billingAccountId, accountId),
				inArray(polyPositionGapActions.targetId, targetIds),
			),
		)
		.groupBy(polyPositionGapActions.targetId);

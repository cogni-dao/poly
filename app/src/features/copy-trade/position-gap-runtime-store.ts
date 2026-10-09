// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/copy-trade/position-gap-runtime-store`
 * Purpose: Durable cohort/action/reservation transitions for position-gap v3.
 * Scope: Service-role worker repository with explicit tenant clamps.
 * Invariants: INSERT_BEFORE_PLACE, ACCOUNT_LOCKED_RESERVATIONS,
 *   AMBIGUOUS_NEVER_REPLAYS, CANCEL_RELEASES_ONLY_AFTER_CONFIRMATION.
 * Side-effects: Postgres writes through the injected service database.
 * Links: story.5015, task.1791070974
 * @internal
 */

import { randomUUID } from "node:crypto";
import type { Database } from "@cogni/db-client";
import { polyCopyTradeFills } from "@cogni/db-schema/copy-trade";
import {
	polyPositionGapActions,
	polyPositionGapCohorts,
	polyPositionGapReservations,
	polyPositionGapRuns,
} from "@cogni/db-schema/position-gap";
import { polyWalletGrants } from "@cogni/db-schema/wallet-grants";
import type {
	OrderReceipt,
	TargetBookSnapshotV1,
} from "@cogni/poly-market-provider";
import {
	and,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	notExists,
	or,
	sql,
	sum,
} from "drizzle-orm";
import { requiredBuyCollateralAtomic } from "@/bootstrap/capabilities/poly-trade-executor";
import type {
	PositionGapCohortCreation,
	PositionGapCohortReduction,
	PositionGapCohortState,
} from "@/features/copy-trade/position-gap-cohorts";
import {
	POSITION_GAP_DATA_API_FILL_SOURCE,
	type PositionGapFillEvidenceMismatchReason,
	type PositionGapFillEvidenceResult,
} from "@/features/copy-trade/position-gap-fill-evidence";
import {
	type RecoverableHardClobRejectionCode,
	recoverableHardClobRejectionCode,
} from "@/features/copy-trade/position-gap-placement-errors";
import type {
	PositionGapHoldingV1,
	PositionGapOpenBuyOrderV1,
	PositionGapPriceCohortV1,
} from "@/features/copy-trade/position-gap-v3/model";
import { targetIdFromWallet } from "@/shared/util/poly-target-id";

const CASH_GUARD_SOURCE = "poly_trade_executor.requiredBuyCollateralAtomic/v1";
const EPSILON = 1e-9;

export interface PositionGapRuntimeScope {
	billingAccountId: string;
	createdByUserId: string;
	targetId: string;
}

export class PositionGapTargetLineageMismatchError extends Error {
	constructor() {
		super("position-gap target wallet lineage mismatch");
		this.name = "PositionGapTargetLineageMismatchError";
	}
}

export interface PositionGapPreparedBuy {
	actionKey: string;
	cohortKey: string;
	conditionId: string;
	tokenId: string;
	marketId: string;
	outcome: string;
	shares: number;
	notionalUsdc: number;
	limitPrice: number;
	clientOrderId: string;
	plannerAction: Record<string, unknown>;
}

export interface PositionGapPreparedCancel {
	actionKey: string;
	cohortKey: string;
	orderId: string;
	reason:
		| "condition_closed"
		| "opposite_hold"
		| "price_cap_lowered"
		| "runtime_safety"
		| "target_reduced";
	plannerAction: Record<string, unknown>;
}

export interface PersistPositionGapPlanInput {
	scope: PositionGapRuntimeScope;
	triggerReasons: readonly string[];
	snapshot: {
		id: string;
		hash: string;
		asOf: Date;
		expiresAt: Date;
		value: Record<string, unknown>;
	};
	plannerVersion: string;
	budgetUsdc: number;
	eligibleNetNavUsdc: number;
	scale: number;
	walletCashUsdc: number;
	plan: Record<string, unknown>;
	cohortCreations: readonly PositionGapCohortCreation[];
	cohortReductions: readonly PositionGapCohortReduction[];
	buys: readonly PositionGapPreparedBuy[];
	cancellations: readonly PositionGapPreparedCancel[];
}

export interface PersistedPositionGapPlan {
	runId: string;
	buys: readonly {
		id: string;
		actionKey: string;
		clientOrderId: string;
		cohortKey: string;
	}[];
	cancellations: readonly {
		id: string;
		orderId: string;
		relatedBuyActionId: string;
	}[];
}

export interface PositionGapActiveBuy {
	id: string;
	runId: string;
	clientOrderId: string;
	orderId: string | null;
	conditionId: string;
	tokenId: string;
	cohortKey: string;
	marketId: string;
	outcome: string;
	shares: number;
	filledShares: number;
	notionalUsdc: number;
	limitPrice: number;
	status: string;
	submitStartedAt: Date | null;
	completedAt: Date | null;
}

export interface PositionGapAccountBuyExposure {
	clientOrderId: string;
	orderId: string | null;
	mode: "live" | "paper";
	conditionId: string;
	tokenId: string;
	remainingShares: number;
}

export interface PositionGapAccountingTransition {
	actionId: string;
	from: "mismatch" | "pending" | "verified";
	to: "mismatch" | "pending" | "verified";
	source:
		| "clob_associated_trades"
		| typeof POSITION_GAP_DATA_API_FILL_SOURCE
		| null;
	reason: string | null;
}

export class PositionGapReservationConflictError extends Error {
	constructor(
		public readonly reason: "budget" | "cash" | "cohort" | "duplicate",
		message: string,
	) {
		super(message);
		this.name = "PositionGapReservationConflictError";
	}
}

function numberOf(value: string | number | null | undefined): number {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sameNumber(left: string | number | null, right: number): boolean {
	return Math.abs(numberOf(left) - right) <= EPSILON;
}

function fillAccountingStatus(
	plannerAction: Record<string, unknown>,
): "mismatch" | "pending" | "verified" {
	return plannerAction.fill_accounting_status === "verified"
		? "verified"
		: plannerAction.fill_accounting_status === "mismatch"
			? "mismatch"
			: "pending";
}

function verifiedFillSource(
	plannerAction: Record<string, unknown>,
): PositionGapAccountingTransition["source"] {
	return plannerAction.realized_fill_source === "clob_associated_trades"
		? "clob_associated_trades"
		: plannerAction.realized_fill_source === POSITION_GAP_DATA_API_FILL_SOURCE
			? POSITION_GAP_DATA_API_FILL_SOURCE
			: null;
}

function statusFromReceipt(status: OrderReceipt["status"]) {
	switch (status) {
		case "pending":
			// The existing dashboard ledger has no distinct internal pending/open
			// split after placement; venueStatus preserves the exact value.
			return "open" as const;
		case "filled":
			return "filled" as const;
		case "partial":
			return "partial" as const;
		case "canceled":
			return "canceled" as const;
		case "open":
			return "open" as const;
		case "error":
			throw new Error(
				"error receipt is not proof of rejection; caller must classify placement outcome",
			);
	}
}

function nextActionStatus(
	current: string,
	observed: ReturnType<typeof statusFromReceipt>,
): "open" | "partial" | "filled" | "cancel_requested" | "canceled" | null {
	if (["filled", "canceled", "rejected", "ambiguous"].includes(current)) {
		return null;
	}
	if (observed === "filled" || observed === "canceled") return observed;
	if (current === "cancel_requested") return "cancel_requested";
	if (current === "partial" || observed === "partial") return "partial";
	return "open";
}

export class PositionGapRuntimeStore {
	constructor(private readonly db: Database) {}

	async loadCohorts(
		scope: PositionGapRuntimeScope,
	): Promise<readonly PositionGapCohortState[]> {
		const rows = await this.db
			.select()
			.from(polyPositionGapCohorts)
			.where(
				and(
					eq(polyPositionGapCohorts.billingAccountId, scope.billingAccountId),
					eq(polyPositionGapCohorts.targetId, scope.targetId),
				),
			)
			.orderBy(
				polyPositionGapCohorts.createdAt,
				polyPositionGapCohorts.cohortKey,
			);

		return rows.map((row) => ({
			id: row.id,
			cohortKey: row.cohortKey,
			sourceKind: row.sourceKind as PositionGapCohortState["sourceKind"],
			conditionId: row.conditionId,
			tokenId: row.tokenId,
			marketId: row.marketId,
			outcome: row.outcome,
			targetDeltaShares: numberOf(row.targetDeltaShares),
			scaleAtCreation: numberOf(row.scaleAtCreation),
			allowedMirrorShares: numberOf(row.allowedMirrorShares),
			benchmarkTargetVwap: numberOf(row.benchmarkTargetVwap),
			acquiredShares: numberOf(row.acquiredShares),
			openOrderShares: numberOf(row.openOrderShares),
			remainingShares: numberOf(row.remainingShares),
			createdAtMs: row.createdAt.getTime(),
		}));
	}

	async loadPlannerState(scope: PositionGapRuntimeScope): Promise<{
		cohorts: readonly PositionGapPriceCohortV1[];
		openBuyOrders: readonly PositionGapOpenBuyOrderV1[];
		activeBuys: readonly PositionGapActiveBuy[];
		provisionalFilledHoldings: readonly PositionGapHoldingV1[];
	}> {
		const [
			cohortRows,
			activeActionRows,
			terminalRepairRows,
			provisionalHoldingRows,
		] = await Promise.all([
			this.db
				.select()
				.from(polyPositionGapCohorts)
				.where(
					and(
						eq(polyPositionGapCohorts.billingAccountId, scope.billingAccountId),
						eq(polyPositionGapCohorts.targetId, scope.targetId),
						sql`${polyPositionGapCohorts.status} <> 'resolved'`,
					),
				)
				.orderBy(
					polyPositionGapCohorts.createdAt,
					polyPositionGapCohorts.cohortKey,
				),
			this.db
				.select()
				.from(polyPositionGapActions)
				.where(
					and(
						eq(polyPositionGapActions.billingAccountId, scope.billingAccountId),
						eq(polyPositionGapActions.targetId, scope.targetId),
						eq(polyPositionGapActions.kind, "buy"),
						inArray(polyPositionGapActions.status, [
							"reserved",
							"ledgered",
							"submitting",
							"open",
							"partial",
							"cancel_requested",
							"ambiguous",
						]),
					),
				)
				.orderBy(polyPositionGapActions.createdAt),
			this.db
				.select()
				.from(polyPositionGapActions)
				.where(
					and(
						eq(polyPositionGapActions.billingAccountId, scope.billingAccountId),
						eq(polyPositionGapActions.targetId, scope.targetId),
						eq(polyPositionGapActions.kind, "buy"),
						inArray(polyPositionGapActions.status, ["filled", "canceled"]),
						sql`${polyPositionGapActions.filledShares} > 0`,
						notExists(
							this.db
								.select({ one: sql`1` })
								.from(polyCopyTradeFills)
								.where(
									and(
										eq(
											polyCopyTradeFills.clientOrderId,
											polyPositionGapActions.clientOrderId,
										),
										eq(
											polyCopyTradeFills.billingAccountId,
											scope.billingAccountId,
										),
										eq(polyCopyTradeFills.targetId, scope.targetId),
										or(
											sql`${polyCopyTradeFills.attributes}->>'realized_fill_source' = 'clob_associated_trades'`,
											sql`${polyCopyTradeFills.attributes}->>'realized_fill_source' = ${POSITION_GAP_DATA_API_FILL_SOURCE}`,
										),
									),
								),
						),
					),
				)
				.orderBy(
					sql`NULLIF(${polyPositionGapActions.plannerAction}->>'fill_accounting_last_attempt_at', '')::timestamptz ASC NULLS FIRST`,
					polyPositionGapActions.completedAt,
				)
				.limit(8),
			this.db
				.select({
					conditionId: polyPositionGapActions.conditionId,
					tokenId: polyPositionGapActions.tokenId,
					shares: sum(polyPositionGapActions.filledShares),
				})
				.from(polyPositionGapActions)
				.innerJoin(
					polyPositionGapCohorts,
					eq(polyPositionGapCohorts.id, polyPositionGapActions.cohortId),
				)
				.where(
					and(
						eq(polyPositionGapActions.billingAccountId, scope.billingAccountId),
						eq(polyPositionGapActions.targetId, scope.targetId),
						eq(polyPositionGapActions.kind, "buy"),
						eq(polyPositionGapActions.status, "canceled"),
						sql`${polyPositionGapActions.filledShares} > 0`,
						sql`${polyPositionGapCohorts.status} <> 'resolved'`,
						notExists(
							this.db
								.select({ one: sql`1` })
								.from(polyCopyTradeFills)
								.where(
									and(
										eq(
											polyCopyTradeFills.clientOrderId,
											polyPositionGapActions.clientOrderId,
										),
										eq(
											polyCopyTradeFills.billingAccountId,
											scope.billingAccountId,
										),
										eq(polyCopyTradeFills.targetId, scope.targetId),
										or(
											sql`${polyCopyTradeFills.attributes}->>'realized_fill_source' = 'clob_associated_trades'`,
											sql`${polyCopyTradeFills.attributes}->>'realized_fill_source' = ${POSITION_GAP_DATA_API_FILL_SOURCE}`,
										),
									),
								),
						),
					),
				)
				.groupBy(
					polyPositionGapActions.conditionId,
					polyPositionGapActions.tokenId,
				),
		]);
		const actionRows = [...activeActionRows, ...terminalRepairRows];
		const activeCohortKeys = new Set(
			activeActionRows.map((row) => row.cohortKey),
		);
		const activeBuys: PositionGapActiveBuy[] = actionRows
			.filter((row) => row.clientOrderId !== null)
			.map((row) => ({
				id: row.id,
				runId: row.runId,
				clientOrderId: row.clientOrderId as string,
				orderId: row.orderId,
				conditionId: row.conditionId,
				tokenId: row.tokenId,
				cohortKey: row.cohortKey,
				marketId: row.marketId,
				outcome: row.outcome,
				shares: numberOf(row.desiredShares),
				filledShares: numberOf(row.filledShares),
				notionalUsdc: numberOf(row.notionalUsdc),
				limitPrice: numberOf(row.limitPrice),
				status: row.status,
				submitStartedAt: row.submitStartedAt,
				completedAt: row.completedAt,
			}));
		return {
			cohorts: cohortRows.map((row) => ({
				cohortId: row.cohortKey,
				conditionId: row.conditionId,
				tokenId: row.tokenId,
				kind: row.sourceKind === "target_buy" ? "forward" : "activation",
				allowedMirrorShares: numberOf(row.allowedMirrorShares),
				acquiredMirrorShares: numberOf(row.acquiredShares),
				availableNewBuyShares: activeCohortKeys.has(row.cohortKey)
					? 0
					: numberOf(row.remainingShares),
				targetVwap: numberOf(row.benchmarkTargetVwap),
			})),
			openBuyOrders: activeBuys.flatMap((row) =>
				row.orderId &&
				["open", "partial", "cancel_requested"].includes(row.status)
					? [
							{
								orderId: row.orderId,
								conditionId: row.conditionId,
								tokenId: row.tokenId,
								cohortId: row.cohortKey,
								remainingShares: Math.max(0, row.shares - row.filledShares),
								reservedUsdc: Math.max(
									0,
									(row.shares - row.filledShares) * row.limitPrice,
								),
								limitPrice: row.limitPrice,
							},
						]
					: [],
			),
			activeBuys,
			provisionalFilledHoldings: provisionalHoldingRows.map((row) => ({
				conditionId: row.conditionId,
				tokenId: row.tokenId,
				shares: numberOf(row.shares),
			})),
		};
	}

	/**
	 * Every active BUY reservation in the account, across targets and sizing
	 * policies. Position-gap subtracts these before creating new demand.
	 */
	async loadAccountBuyExposure(
		scope: PositionGapRuntimeScope,
	): Promise<readonly PositionGapAccountBuyExposure[]> {
		const rows = await this.db
			.select({
				clientOrderId: polyCopyTradeFills.clientOrderId,
				orderId: polyCopyTradeFills.orderId,
				mode: polyCopyTradeFills.mode,
				marketId: polyCopyTradeFills.marketId,
				conditionId: sql<
					string | null
				>`${polyCopyTradeFills.attributes}->>'condition_id'`,
				tokenId: sql<
					string | null
				>`${polyCopyTradeFills.attributes}->>'token_id'`,
				sizeUsdc: sql<
					string | null
				>`${polyCopyTradeFills.attributes}->>'size_usdc'`,
				limitPrice: sql<
					string | null
				>`${polyCopyTradeFills.attributes}->>'limit_price'`,
				filledShares: polyCopyTradeFills.shares,
			})
			.from(polyCopyTradeFills)
			.where(
				and(
					eq(polyCopyTradeFills.billingAccountId, scope.billingAccountId),
					inArray(polyCopyTradeFills.status, ["pending", "open", "partial"]),
					sql`${polyCopyTradeFills.attributes}->>'side' = 'BUY'`,
					sql`${polyCopyTradeFills.attributes}->>'closed_at' IS NULL`,
				),
			);
		return rows.map((row) => {
			const tokenId = row.tokenId?.trim() ?? "";
			const conditionId =
				row.conditionId?.trim() ||
				row.marketId.replace(/^prediction-market:polymarket:/, "");
			const sizeUsdc =
				row.sizeUsdc === null ? Number.NaN : Number(row.sizeUsdc);
			const limitPrice =
				row.limitPrice === null ? Number.NaN : Number(row.limitPrice);
			const filledShares =
				row.filledShares === null ? 0 : Number(row.filledShares);
			if (
				conditionId.length === 0 ||
				tokenId.length === 0 ||
				!Number.isFinite(sizeUsdc) ||
				sizeUsdc <= 0 ||
				!Number.isFinite(limitPrice) ||
				limitPrice <= 0 ||
				limitPrice >= 1 ||
				!Number.isFinite(filledShares) ||
				filledShares < 0
			) {
				throw new Error(
					`active BUY exposure was malformed for ${row.clientOrderId}`,
				);
			}
			return {
				clientOrderId: row.clientOrderId,
				orderId: row.orderId,
				mode: row.mode,
				conditionId,
				tokenId,
				remainingShares: Math.max(0, sizeUsdc / limitPrice - filledShares),
			};
		});
	}

	async previousBudgetUsdc(
		scope: PositionGapRuntimeScope,
	): Promise<number | null> {
		const [row] = await this.db
			.select({ budget: polyPositionGapRuns.budgetUsdc })
			.from(polyPositionGapRuns)
			.where(
				and(
					eq(polyPositionGapRuns.billingAccountId, scope.billingAccountId),
					eq(polyPositionGapRuns.targetId, scope.targetId),
				),
			)
			.orderBy(desc(polyPositionGapRuns.startedAt))
			.limit(1);
		return row ? numberOf(row.budget) : null;
	}

	/**
	 * Repair the one PGv3 producer-field omission that predates canonical
	 * copy-target correlation. The deterministic target id proves the wallet;
	 * tenant + target + account-resolved mode + policy version clamp the
	 * idempotent update.
	 */
	async repairTargetWalletLineage(
		scope: PositionGapRuntimeScope,
		targetWallet: string,
		mode: "live" | "paper",
	): Promise<void> {
		const normalized = targetWallet.toLowerCase();
		if (
			!/^0x[0-9a-f]{40}$/.test(normalized) ||
			targetIdFromWallet(normalized as `0x${string}`) !== scope.targetId
		) {
			throw new PositionGapTargetLineageMismatchError();
		}
		await this.db
			.update(polyCopyTradeFills)
			.set({
				attributes: sql`COALESCE(${polyCopyTradeFills.attributes}, '{}'::jsonb) || jsonb_build_object('target_wallet', ${normalized}::text)`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(polyCopyTradeFills.billingAccountId, scope.billingAccountId),
					eq(polyCopyTradeFills.targetId, scope.targetId),
					eq(polyCopyTradeFills.mode, mode),
					sql`${polyCopyTradeFills.attributes}->>'position_gap_version' = '3'`,
					sql`NULLIF(${polyCopyTradeFills.attributes}->>'target_wallet', '') IS NULL`,
				),
			);
	}

	async loadLastSnapshot(
		scope: PositionGapRuntimeScope,
	): Promise<TargetBookSnapshotV1 | null> {
		const [row] = await this.db
			.select({ snapshot: polyPositionGapRuns.targetSnapshot })
			.from(polyPositionGapRuns)
			.where(
				and(
					eq(polyPositionGapRuns.billingAccountId, scope.billingAccountId),
					eq(polyPositionGapRuns.targetId, scope.targetId),
					sql`${polyPositionGapRuns.targetSnapshot} IS NOT NULL`,
				),
			)
			.orderBy(desc(polyPositionGapRuns.startedAt))
			.limit(1);
		return (row?.snapshot as TargetBookSnapshotV1 | undefined) ?? null;
	}

	async loadConfirmedCapacity(scope: PositionGapRuntimeScope): Promise<{
		perOrderUsdc: number;
		dailyHeadroomUsdc: number;
		remainingIntentCount: number;
	}> {
		const [grant] = await this.db
			.select({
				perOrder: polyWalletGrants.perOrderUsdcCap,
				daily: polyWalletGrants.dailyUsdcCap,
				hourly: polyWalletGrants.hourlyFillsCap,
			})
			.from(polyWalletGrants)
			.where(
				and(
					eq(polyWalletGrants.billingAccountId, scope.billingAccountId),
					eq(polyWalletGrants.createdByUserId, scope.createdByUserId),
					isNull(polyWalletGrants.revokedAt),
					or(
						isNull(polyWalletGrants.expiresAt),
						sql`${polyWalletGrants.expiresAt} > now()`,
					),
					sql`${polyWalletGrants.scopes} @> ARRAY['poly:trade:buy']::text[]`,
				),
			)
			.orderBy(desc(polyWalletGrants.createdAt))
			.limit(1);
		if (!grant) {
			return { perOrderUsdc: 0, dailyHeadroomUsdc: 0, remainingIntentCount: 0 };
		}
		const activeStatuses = ["pending", "open", "filled", "partial"];
		const [daily] = await this.db
			.select({
				spent: sum(
					sql<string>`COALESCE((${polyCopyTradeFills.attributes}->>'size_usdc')::numeric, 0)`,
				),
			})
			.from(polyCopyTradeFills)
			.where(
				and(
					eq(polyCopyTradeFills.billingAccountId, scope.billingAccountId),
					gte(polyCopyTradeFills.createdAt, sql`now() - interval '24 hours'`),
					inArray(polyCopyTradeFills.status, activeStatuses),
				),
			);
		const [hourly] = await this.db
			.select({ n: count() })
			.from(polyCopyTradeFills)
			.where(
				and(
					eq(polyCopyTradeFills.billingAccountId, scope.billingAccountId),
					gte(polyCopyTradeFills.createdAt, sql`now() - interval '1 hour'`),
					inArray(polyCopyTradeFills.status, activeStatuses),
				),
			);
		return {
			perOrderUsdc: numberOf(grant.perOrder),
			dailyHeadroomUsdc: Math.max(
				0,
				numberOf(grant.daily) - numberOf(daily?.spent),
			),
			remainingIntentCount: Math.max(0, grant.hourly - Number(hourly?.n ?? 0)),
		};
	}

	async activeReservationTotals(scope: PositionGapRuntimeScope): Promise<{
		budgetUsdc: number;
		cashGuardAtomicForAccount: bigint;
	}> {
		const [target] = await this.db
			.select({
				budget: sql<string>`COALESCE(SUM(${polyPositionGapReservations.budgetNotionalUsdc} - ${polyPositionGapReservations.releasedBudgetUsdc}), 0)`,
			})
			.from(polyPositionGapReservations)
			.where(
				and(
					eq(
						polyPositionGapReservations.billingAccountId,
						scope.billingAccountId,
					),
					eq(polyPositionGapReservations.targetId, scope.targetId),
					eq(polyPositionGapReservations.state, "active"),
				),
			);
		const [account] = await this.db
			.select({
				cash: sql<string>`COALESCE(SUM(${polyPositionGapReservations.executorCashGuardAtomic} - ${polyPositionGapReservations.releasedCashGuardAtomic}), 0)`,
			})
			.from(polyPositionGapReservations)
			.where(
				and(
					eq(
						polyPositionGapReservations.billingAccountId,
						scope.billingAccountId,
					),
					eq(polyPositionGapReservations.state, "active"),
				),
			);
		return {
			budgetUsdc: numberOf(target?.budget),
			cashGuardAtomicForAccount: BigInt(account?.cash ?? "0"),
		};
	}

	async persistPlan(
		input: PersistPositionGapPlanInput,
	): Promise<PersistedPositionGapPlan> {
		if (input.buys.length > 8) {
			throw new Error(
				"position-gap plan exceeds the eight-intent runtime limit",
			);
		}
		for (const buy of input.buys) {
			if (
				!Number.isFinite(buy.notionalUsdc) ||
				buy.notionalUsdc <= 0 ||
				!Number.isFinite(buy.shares) ||
				buy.shares <= 0 ||
				!Number.isFinite(buy.limitPrice) ||
				buy.limitPrice <= 0 ||
				buy.limitPrice >= 1
			) {
				throw new Error("invalid position-gap BUY plan");
			}
		}

		return this.db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${`position-gap-v3:${input.scope.billingAccountId}`}))`,
			);
			const isSafetyCancellationOnly =
				input.buys.length === 0 &&
				input.cohortCreations.length === 0 &&
				input.cohortReductions.length === 0 &&
				input.cancellations.length > 0 &&
				input.cancellations.every(
					(cancellation) => cancellation.reason === "runtime_safety",
				);

			const [ambiguous] = await tx
				.select({ id: polyPositionGapActions.id })
				.from(polyPositionGapActions)
				.where(
					and(
						eq(
							polyPositionGapActions.billingAccountId,
							input.scope.billingAccountId,
						),
						eq(polyPositionGapActions.targetId, input.scope.targetId),
						eq(polyPositionGapActions.status, "ambiguous"),
					),
				)
				.limit(1);
			if (ambiguous && !isSafetyCancellationOnly) {
				throw new PositionGapReservationConflictError(
					"duplicate",
					"position-gap target is halted by an ambiguous placement",
				);
			}

			const requestedActionKeys = [
				...input.buys.map((buy) => buy.actionKey),
				...input.cancellations.map((cancel) => cancel.actionKey),
			];
			const existingActions =
				requestedActionKeys.length === 0
					? []
					: await tx
							.select()
							.from(polyPositionGapActions)
							.where(
								and(
									eq(
										polyPositionGapActions.billingAccountId,
										input.scope.billingAccountId,
									),
									eq(polyPositionGapActions.targetId, input.scope.targetId),
									inArray(
										polyPositionGapActions.actionKey,
										requestedActionKeys,
									),
								),
							);
			const actionByKey = new Map(
				existingActions.map((action) => [action.actionKey, action]),
			);
			for (const buy of input.buys) {
				const existing = actionByKey.get(buy.actionKey);
				if (!existing) continue;
				if (
					existing.kind !== "buy" ||
					existing.cohortKey !== buy.cohortKey ||
					existing.conditionId !== buy.conditionId ||
					existing.tokenId !== buy.tokenId ||
					existing.marketId !== buy.marketId ||
					existing.outcome !== buy.outcome ||
					existing.clientOrderId !== buy.clientOrderId ||
					!sameNumber(existing.desiredShares, buy.shares) ||
					!sameNumber(existing.notionalUsdc, buy.notionalUsdc) ||
					!sameNumber(existing.limitPrice, buy.limitPrice) ||
					stableJson(existing.plannerAction) !== stableJson(buy.plannerAction)
				) {
					throw new PositionGapReservationConflictError(
						"duplicate",
						`action key ${buy.actionKey} collided with different BUY payload`,
					);
				}
			}
			for (const cancellation of input.cancellations) {
				const existing = actionByKey.get(cancellation.actionKey);
				if (!existing) continue;
				if (
					existing.kind !== "cancel" ||
					existing.cohortKey !== cancellation.cohortKey ||
					existing.orderId !== cancellation.orderId ||
					stableJson(existing.plannerAction) !==
						stableJson(cancellation.plannerAction)
				) {
					throw new PositionGapReservationConflictError(
						"duplicate",
						`action key ${cancellation.actionKey} collided with different cancel payload`,
					);
				}
			}
			const newBuys = input.buys.filter(
				(buy) => !actionByKey.has(buy.actionKey),
			);

			const [targetReserved] = await tx
				.select({
					budget: sql<string>`COALESCE(SUM(${polyPositionGapReservations.budgetNotionalUsdc} - ${polyPositionGapReservations.releasedBudgetUsdc}), 0)`,
				})
				.from(polyPositionGapReservations)
				.where(
					and(
						eq(
							polyPositionGapReservations.billingAccountId,
							input.scope.billingAccountId,
						),
						eq(polyPositionGapReservations.targetId, input.scope.targetId),
						eq(polyPositionGapReservations.state, "active"),
					),
				);
			const [accountReserved] = await tx
				.select({
					cash: sql<string>`COALESCE(SUM(${polyPositionGapReservations.executorCashGuardAtomic} - ${polyPositionGapReservations.releasedCashGuardAtomic}), 0)`,
				})
				.from(polyPositionGapReservations)
				.where(
					and(
						eq(
							polyPositionGapReservations.billingAccountId,
							input.scope.billingAccountId,
						),
						eq(polyPositionGapReservations.state, "active"),
					),
				);

			const newBudget = newBuys.reduce((sum, buy) => sum + buy.notionalUsdc, 0);
			const newCashAtomic = newBuys.reduce(
				(sum, buy) => sum + requiredBuyCollateralAtomic(buy.notionalUsdc),
				0n,
			);
			if (
				newBuys.length > 0 &&
				numberOf(targetReserved?.budget) + newBudget >
				input.budgetUsdc + EPSILON
			) {
				throw new PositionGapReservationConflictError(
					"budget",
					"position-gap plan exceeds durable sleeve capacity",
				);
			}
			const walletCashAtomic = BigInt(
				Math.max(0, Math.floor(input.walletCashUsdc * 1_000_000)),
			);
			if (
				newBuys.length > 0 &&
				BigInt(accountReserved?.cash ?? "0") + newCashAtomic >
				walletCashAtomic
			) {
				throw new PositionGapReservationConflictError(
					"cash",
					"position-gap plan exceeds durable wallet cash capacity",
				);
			}

			const runId = randomUUID();
			await tx.insert(polyPositionGapRuns).values({
				id: runId,
				billingAccountId: input.scope.billingAccountId,
				createdByUserId: input.scope.createdByUserId,
				targetId: input.scope.targetId,
				triggerReasons: [...input.triggerReasons],
				targetSnapshotId: input.snapshot.id,
				targetSnapshotHash: input.snapshot.hash,
				targetSnapshotAsOf: input.snapshot.asOf,
				targetSnapshotExpiresAt: input.snapshot.expiresAt,
				targetSnapshot: input.snapshot.value,
				plannerVersion: input.plannerVersion,
				budgetUsdc: input.budgetUsdc.toString(),
				eligibleNetNavUsdc: input.eligibleNetNavUsdc.toString(),
				scale: input.scale.toString(),
				walletCashUsdcAtStart: input.walletCashUsdc.toString(),
				reservedBudgetUsdcAtStart: numberOf(targetReserved?.budget).toString(),
				reservedCashAtomicAtStart: accountReserved?.cash ?? "0",
				plan: input.plan,
				status: "running",
			});

			for (const creation of input.cohortCreations) {
				const [existingCohort] = await tx
					.select()
					.from(polyPositionGapCohorts)
					.where(
						and(
							eq(
								polyPositionGapCohorts.billingAccountId,
								input.scope.billingAccountId,
							),
							eq(polyPositionGapCohorts.targetId, input.scope.targetId),
							eq(polyPositionGapCohorts.cohortKey, creation.cohortKey),
						),
					)
					.limit(1);
				if (existingCohort) {
					if (
						existingCohort.sourceKind !== creation.sourceKind ||
						existingCohort.sourceEventId !== creation.sourceEventId ||
						existingCohort.sourceConfigRevision !==
							creation.sourceConfigRevision ||
						existingCohort.sourceSnapshotId !== input.snapshot.id ||
						existingCohort.sourceSnapshotHash !== input.snapshot.hash ||
						existingCohort.conditionId !== creation.conditionId ||
						existingCohort.tokenId !== creation.tokenId ||
						existingCohort.marketId !== creation.marketId ||
						existingCohort.outcome !== creation.outcome ||
						!sameNumber(
							existingCohort.targetDeltaShares,
							creation.targetDeltaShares,
						) ||
						!sameNumber(
							existingCohort.scaleAtCreation,
							creation.scaleAtCreation,
						) ||
						!sameNumber(
							existingCohort.initialAllowedMirrorShares,
							creation.allowedMirrorShares,
						) ||
						!sameNumber(
							existingCohort.benchmarkTargetVwap,
							creation.benchmarkTargetVwap,
						) ||
						stableJson(existingCohort.sourceProvenance) !==
							stableJson(creation.provenance)
					) {
						throw new PositionGapReservationConflictError(
							"cohort",
							`cohort key ${creation.cohortKey} collided with different immutable provenance`,
						);
					}
					continue;
				}
				await tx.insert(polyPositionGapCohorts).values({
					billingAccountId: input.scope.billingAccountId,
					createdByUserId: input.scope.createdByUserId,
					targetId: input.scope.targetId,
					cohortKey: creation.cohortKey,
					sourceKind: creation.sourceKind,
					sourceEventId: creation.sourceEventId,
					sourceConfigRevision: creation.sourceConfigRevision,
					sourceSnapshotId: input.snapshot.id,
					sourceSnapshotHash: input.snapshot.hash,
					sourceSnapshotAsOf: input.snapshot.asOf,
					sourceProvenance: creation.provenance,
					createdRunId: runId,
					conditionId: creation.conditionId,
					tokenId: creation.tokenId,
					marketId: creation.marketId,
					outcome: creation.outcome,
					targetDeltaShares: creation.targetDeltaShares.toString(),
					scaleAtCreation: creation.scaleAtCreation.toString(),
					allowedMirrorShares: creation.allowedMirrorShares.toString(),
					initialAllowedMirrorShares: creation.allowedMirrorShares.toString(),
					benchmarkTargetVwap: creation.benchmarkTargetVwap.toString(),
					remainingShares: creation.remainingShares.toString(),
					createdAt: new Date(creation.createdAtMs),
					updatedAt: new Date(),
				});
			}

			for (const reduction of input.cohortReductions) {
				const changed = await tx
					.update(polyPositionGapCohorts)
					.set({
						allowedMirrorShares: reduction.allowedMirrorShares.toString(),
						remainingShares: reduction.remainingShares.toString(),
						status: reduction.status,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(
								polyPositionGapCohorts.billingAccountId,
								input.scope.billingAccountId,
							),
							eq(polyPositionGapCohorts.targetId, input.scope.targetId),
							eq(polyPositionGapCohorts.cohortKey, reduction.cohortKey),
							sql`ABS(${polyPositionGapCohorts.allowedMirrorShares} - ${reduction.previousAllowedMirrorShares}) <= ${EPSILON}`,
						),
					)
					.returning({ id: polyPositionGapCohorts.id });
				if (changed.length === 0) {
					const [current] = await tx
						.select({ allowed: polyPositionGapCohorts.allowedMirrorShares })
						.from(polyPositionGapCohorts)
						.where(
							and(
								eq(
									polyPositionGapCohorts.billingAccountId,
									input.scope.billingAccountId,
								),
								eq(polyPositionGapCohorts.targetId, input.scope.targetId),
								eq(polyPositionGapCohorts.cohortKey, reduction.cohortKey),
							),
						)
						.limit(1);
					if (
						!current ||
						!sameNumber(current.allowed, reduction.allowedMirrorShares)
					) {
						throw new PositionGapReservationConflictError(
							"cohort",
							`stale cohort reduction for ${reduction.cohortKey}`,
						);
					}
				}
			}

			const cohortKeys = Array.from(
				new Set([
					...input.buys.map((buy) => buy.cohortKey),
					...input.cancellations.map((cancel) => cancel.cohortKey),
				]),
			);
			const cohortRows =
				cohortKeys.length === 0
					? []
					: await tx
							.select()
							.from(polyPositionGapCohorts)
							.where(
								and(
									eq(
										polyPositionGapCohorts.billingAccountId,
										input.scope.billingAccountId,
									),
									eq(polyPositionGapCohorts.targetId, input.scope.targetId),
									inArray(polyPositionGapCohorts.cohortKey, cohortKeys),
								),
							);
			const cohortByKey = new Map(
				cohortRows.map((cohort) => [cohort.cohortKey, cohort]),
			);

			const persistedBuys: Array<{
				id: string;
				actionKey: string;
				clientOrderId: string;
				cohortKey: string;
			}> = existingActions
				.filter(
					(action) =>
						action.kind === "buy" &&
						(action.status === "reserved" || action.status === "ledgered") &&
						action.clientOrderId !== null,
				)
				.map((action) => ({
					id: action.id,
					actionKey: action.actionKey,
					clientOrderId: action.clientOrderId as string,
					cohortKey: action.cohortKey,
				}));
			for (const buy of newBuys) {
				const cohort = cohortByKey.get(buy.cohortKey);
				if (!cohort) {
					throw new PositionGapReservationConflictError(
						"cohort",
						`missing persisted cohort ${buy.cohortKey}`,
					);
				}
				const actionId = randomUUID();
				try {
					await tx.insert(polyPositionGapActions).values({
						id: actionId,
						billingAccountId: input.scope.billingAccountId,
						createdByUserId: input.scope.createdByUserId,
						targetId: input.scope.targetId,
						runId,
						cohortId: cohort.id,
						cohortKey: cohort.cohortKey,
						actionKey: buy.actionKey,
						kind: "buy",
						conditionId: buy.conditionId,
						tokenId: buy.tokenId,
						marketId: buy.marketId,
						outcome: buy.outcome,
						desiredShares: buy.shares.toString(),
						notionalUsdc: buy.notionalUsdc.toString(),
						limitPrice: buy.limitPrice.toString(),
						plannerAction: buy.plannerAction,
						clientOrderId: buy.clientOrderId,
						status: "reserved",
					});
				} catch (error) {
					throw new PositionGapReservationConflictError(
						"duplicate",
						`cohort already has an active BUY: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				const cashGuard = requiredBuyCollateralAtomic(buy.notionalUsdc);
				await tx.insert(polyPositionGapReservations).values({
					billingAccountId: input.scope.billingAccountId,
					createdByUserId: input.scope.createdByUserId,
					targetId: input.scope.targetId,
					cohortId: cohort.id,
					buyActionId: actionId,
					budgetNotionalUsdc: buy.notionalUsdc.toString(),
					executorCashGuardAtomic: cashGuard.toString(),
					cashGuardSource: CASH_GUARD_SOURCE,
				});
				const reservedCohort = await tx
					.update(polyPositionGapCohorts)
					.set({
						openOrderShares: sql`${polyPositionGapCohorts.openOrderShares} + ${buy.shares}`,
						remainingShares: sql`GREATEST(0, ${polyPositionGapCohorts.remainingShares} - ${buy.shares})`,
						status: "resting",
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(polyPositionGapCohorts.id, cohort.id),
							sql`${polyPositionGapCohorts.remainingShares} + ${EPSILON} >= ${buy.shares}`,
						),
					)
					.returning({ id: polyPositionGapCohorts.id });
				if (reservedCohort.length === 0) {
					throw new PositionGapReservationConflictError(
						"cohort",
						`cohort ${buy.cohortKey} no longer has sufficient entitlement`,
					);
				}
				persistedBuys.push({
					id: actionId,
					actionKey: buy.actionKey,
					clientOrderId: buy.clientOrderId,
					cohortKey: buy.cohortKey,
				});
			}

			const persistedCancellations: Array<{
				id: string;
				orderId: string;
				relatedBuyActionId: string;
			}> = existingActions
				.filter(
					(action) =>
						action.kind === "cancel" &&
						action.status === "cancel_requested" &&
						action.orderId !== null &&
						action.relatedBuyActionId !== null,
				)
				.map((action) => ({
					id: action.id,
					orderId: action.orderId as string,
					relatedBuyActionId: action.relatedBuyActionId as string,
				}));
			for (const cancellation of input.cancellations) {
				if (actionByKey.has(cancellation.actionKey)) continue;
				const cohort = cohortByKey.get(cancellation.cohortKey);
				if (!cohort) continue;
				const [buy] = await tx
					.select()
					.from(polyPositionGapActions)
					.where(
						and(
							eq(
								polyPositionGapActions.billingAccountId,
								input.scope.billingAccountId,
							),
							eq(polyPositionGapActions.targetId, input.scope.targetId),
							eq(polyPositionGapActions.orderId, cancellation.orderId),
							eq(polyPositionGapActions.kind, "buy"),
						),
					)
					.limit(1);
				if (!buy) continue;
				const cancelId = randomUUID();
				await tx.insert(polyPositionGapActions).values({
					id: cancelId,
					billingAccountId: input.scope.billingAccountId,
					createdByUserId: input.scope.createdByUserId,
					targetId: input.scope.targetId,
					runId,
					cohortId: cohort.id,
					cohortKey: cohort.cohortKey,
					actionKey: cancellation.actionKey,
					kind: "cancel",
					relatedBuyActionId: buy.id,
					conditionId: buy.conditionId,
					tokenId: buy.tokenId,
					marketId: buy.marketId,
					outcome: buy.outcome,
					plannerAction: cancellation.plannerAction,
					orderId: cancellation.orderId,
					status: "cancel_requested",
				});
				await tx
					.update(polyPositionGapActions)
					.set({ status: "cancel_requested", updatedAt: new Date() })
					.where(eq(polyPositionGapActions.id, buy.id));
				persistedCancellations.push({
					id: cancelId,
					orderId: cancellation.orderId,
					relatedBuyActionId: buy.id,
				});
			}

			return {
				runId,
				buys: persistedBuys,
				cancellations: persistedCancellations,
			};
		});
	}

	async markLedgered(actionId: string): Promise<void> {
		await this.db
			.update(polyPositionGapActions)
			.set({ status: "ledgered", updatedAt: new Date() })
			.where(
				and(
					eq(polyPositionGapActions.id, actionId),
					eq(polyPositionGapActions.status, "reserved"),
				),
			);
	}

	async markSubmitting(actionId: string): Promise<void> {
		await this.db
			.update(polyPositionGapActions)
			.set({
				status: "submitting",
				submitStartedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(polyPositionGapActions.id, actionId),
					eq(polyPositionGapActions.status, "ledgered"),
				),
			);
	}

	async markAmbiguous(actionId: string, detail: string): Promise<void> {
		await this.db.transaction(async (tx) => {
			const [action] = await tx
				.update(polyPositionGapActions)
				.set({
					status: "ambiguous",
					errorCode: "placement_ambiguous",
					errorDetail: detail.slice(0, 500),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(polyPositionGapActions.id, actionId),
						eq(polyPositionGapActions.status, "submitting"),
					),
				)
				.returning({ runId: polyPositionGapActions.runId });
			if (action) {
				await tx
					.update(polyPositionGapRuns)
					.set({
						status: "halted",
						errorCode: "placement_ambiguous",
						errorDetail: detail.slice(0, 500),
						completedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(polyPositionGapRuns.id, action.runId));
			}
		});
	}

	async recoverSubmittingAsAmbiguous(
		scope: PositionGapRuntimeScope,
	): Promise<number> {
		return this.db.transaction(async (tx) => {
			const rows = await tx
				.update(polyPositionGapActions)
				.set({
					status: "ambiguous",
					errorCode: "process_restarted_during_submit",
					errorDetail:
						"submit began before process restart; venue outcome cannot be replayed safely",
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(polyPositionGapActions.billingAccountId, scope.billingAccountId),
						eq(polyPositionGapActions.targetId, scope.targetId),
						eq(polyPositionGapActions.status, "submitting"),
					),
				)
				.returning({ runId: polyPositionGapActions.runId });
			const runIds = [...new Set(rows.map((row) => row.runId))];
			if (runIds.length > 0) {
				await tx
					.update(polyPositionGapRuns)
					.set({
						status: "halted",
						errorCode: "process_restarted_during_submit",
						completedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(inArray(polyPositionGapRuns.id, runIds));
			}
			return rows.length;
		});
	}

	async markKnownRejected(actionId: string, detail: string): Promise<boolean> {
		return this.db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT 1 FROM ${polyPositionGapActions} WHERE ${polyPositionGapActions.id} = ${actionId} FOR UPDATE`,
			);
			const [before] = await tx
				.select()
				.from(polyPositionGapActions)
				.where(eq(polyPositionGapActions.id, actionId))
				.limit(1);
			if (!before) return false;
			const recoverableAmbiguity =
				before.status === "ambiguous" &&
				recoverableHardClobRejectionCode(
					before.errorDetail,
					before.submitStartedAt,
				) !== null;
			if (
				!["reserved", "ledgered", "submitting"].includes(before.status) &&
				!recoverableAmbiguity
			)
				return false;
			const durableDetail = recoverableAmbiguity
				? (before.errorDetail ?? detail)
				: detail;
			const [action] = await tx
				.update(polyPositionGapActions)
				.set({
					status: "rejected",
					errorCode: "placement_rejected",
					errorDetail: durableDetail.slice(0, 500),
					completedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(polyPositionGapActions.id, actionId),
						eq(polyPositionGapActions.status, before.status),
					),
				)
				.returning();
			if (!action) return false;
			await tx
				.update(polyPositionGapReservations)
				.set({
					releasedBudgetUsdc: sql`${polyPositionGapReservations.budgetNotionalUsdc}`,
					releasedCashGuardAtomic: sql`${polyPositionGapReservations.executorCashGuardAtomic}`,
					state: "released",
					releaseReason: "known_rejected",
					releasedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(polyPositionGapReservations.buyActionId, action.id));
			await tx
				.update(polyPositionGapCohorts)
				.set({
					openOrderShares: sql`GREATEST(0, ${polyPositionGapCohorts.openOrderShares} - ${action.desiredShares ?? "0"})`,
					remainingShares: sql`LEAST(${polyPositionGapCohorts.allowedMirrorShares}, ${polyPositionGapCohorts.remainingShares} + ${action.desiredShares ?? "0"})`,
					status: "available",
					updatedAt: new Date(),
				})
				.where(eq(polyPositionGapCohorts.id, action.cohortId));
			if (recoverableAmbiguity && action.clientOrderId) {
				const ledgerError =
					durableDetail.length > 512
						? `${durableDetail.slice(0, 512)}…`
						: durableDetail;
				await tx
					.update(polyCopyTradeFills)
					.set({
						status: "error",
						updatedAt: new Date(),
						attributes: sql`COALESCE(${polyCopyTradeFills.attributes}, '{}'::jsonb) || ${JSON.stringify(
							{ error: ledgerError },
						)}::jsonb`,
					})
					.where(
						and(
							eq(
								polyCopyTradeFills.billingAccountId,
								action.billingAccountId,
							),
							eq(polyCopyTradeFills.targetId, action.targetId),
							eq(polyCopyTradeFills.clientOrderId, action.clientOrderId),
						),
					);
			}
			return true;
		});
	}

	async recoverKnownRejectedAmbiguities(
		scope: PositionGapRuntimeScope,
	): Promise<
		readonly {
			id: string;
			clientOrderId: string;
			errorCode: RecoverableHardClobRejectionCode;
		}[]
	> {
		const rows = await this.db
			.select({
				id: polyPositionGapActions.id,
				clientOrderId: polyPositionGapActions.clientOrderId,
				errorDetail: polyPositionGapActions.errorDetail,
				submitStartedAt: polyPositionGapActions.submitStartedAt,
			})
			.from(polyPositionGapActions)
			.where(
				and(
					eq(
						polyPositionGapActions.billingAccountId,
						scope.billingAccountId,
					),
					eq(polyPositionGapActions.targetId, scope.targetId),
					eq(polyPositionGapActions.kind, "buy"),
					eq(polyPositionGapActions.status, "ambiguous"),
				),
			);
		const recovered = [] as {
			id: string;
			clientOrderId: string;
			errorCode: RecoverableHardClobRejectionCode;
		}[];
		for (const row of rows) {
			const errorCode = recoverableHardClobRejectionCode(
				row.errorDetail,
				row.submitStartedAt,
			);
			if (!errorCode || !row.clientOrderId || !row.errorDetail) continue;
			if (await this.markKnownRejected(row.id, row.errorDetail)) {
				recovered.push({
					id: row.id,
					clientOrderId: row.clientOrderId,
					errorCode,
				});
			}
		}
		return recovered;
	}

	/**
	 * Release a runtime BUY only after the shared ledger reconciler has observed
	 * typed CLOB `not_found` beyond its configured grace window, or the actor has
	 * matched a no-order-id ambiguity to durable `never_placed` ledger evidence.
	 * The evidence check remains outside this transition; admitting `ambiguous`
	 * here is what lets that already-proven terminal state retire durably.
	 */
	async markVenueNotFoundCanceled(actionId: string): Promise<void> {
		await this.db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT 1 FROM ${polyPositionGapActions} WHERE ${polyPositionGapActions.id} = ${actionId} FOR UPDATE`,
			);
			const [action] = await tx
				.select()
				.from(polyPositionGapActions)
				.where(eq(polyPositionGapActions.id, actionId))
				.limit(1);
			if (
				!action ||
				["filled", "canceled", "rejected"].includes(action.status)
			)
				return;
			const desiredShares = numberOf(action.desiredShares);
			const filledShares = numberOf(action.filledShares);
			const unfilledShares = Math.max(0, desiredShares - filledShares);
			const intended = numberOf(action.notionalUsdc);
			const filled = numberOf(action.filledUsdc);
			await tx
				.update(polyPositionGapActions)
				.set({
					status: "canceled",
					venueStatus: "not_found_after_grace",
					errorCode: "clob_not_found",
					completedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(polyPositionGapActions.id, action.id));
			await tx
				.update(polyPositionGapActions)
				.set({
					status: "canceled",
					errorCode: "clob_not_found",
					completedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(polyPositionGapActions.relatedBuyActionId, action.id),
						eq(polyPositionGapActions.status, "cancel_requested"),
					),
				);
			await tx
				.update(polyPositionGapReservations)
				.set({
					releasedBudgetUsdc: Math.max(0, intended - filled).toString(),
					releasedCashGuardAtomic:
						polyPositionGapReservations.executorCashGuardAtomic,
					state: filled > EPSILON ? "active" : "released",
					releaseReason: "clob_not_found",
					...(filled > EPSILON ? {} : { releasedAt: new Date() }),
					updatedAt: new Date(),
				})
				.where(eq(polyPositionGapReservations.buyActionId, action.id));
			await tx
				.update(polyPositionGapCohorts)
				.set({
					openOrderShares: sql`GREATEST(0, ${polyPositionGapCohorts.openOrderShares} - ${unfilledShares})`,
					remainingShares: sql`LEAST(GREATEST(0, ${polyPositionGapCohorts.allowedMirrorShares} - ${polyPositionGapCohorts.acquiredShares}), ${polyPositionGapCohorts.remainingShares} + ${unfilledShares})`,
					status: filled > EPSILON ? "exhausted" : "available",
					updatedAt: new Date(),
				})
				.where(eq(polyPositionGapCohorts.id, action.cohortId));
		});
	}

	/** Recover terminal ledger evidence even when its callback raced actor boot. */
	async reconcileLedgerTerminals(
		scope: PositionGapRuntimeScope,
	): Promise<number> {
		const rows = await this.db
			.select({
				actionId: polyPositionGapActions.id,
				ledgerStatus: polyCopyTradeFills.status,
				reason: sql<string | null>`${polyCopyTradeFills.attributes}->>'reason'`,
			})
			.from(polyPositionGapActions)
			.innerJoin(
				polyCopyTradeFills,
				eq(
					polyCopyTradeFills.clientOrderId,
					polyPositionGapActions.clientOrderId,
				),
			)
			.where(
				and(
					eq(
						polyPositionGapActions.billingAccountId,
						scope.billingAccountId,
					),
					eq(polyPositionGapActions.targetId, scope.targetId),
					eq(polyPositionGapActions.kind, "buy"),
					inArray(polyPositionGapActions.status, [
						"reserved",
						"ledgered",
						"submitting",
						"open",
						"partial",
						"cancel_requested",
					]),
					or(
						and(
							eq(polyCopyTradeFills.status, "canceled"),
							sql`${polyCopyTradeFills.attributes}->>'reason' = 'clob_not_found'`,
						),
						and(
							eq(polyCopyTradeFills.status, "error"),
							sql`${polyCopyTradeFills.attributes}->>'reason' = 'never_placed'`,
						),
					),
				),
			);
		for (const row of rows) {
			if (row.ledgerStatus === "canceled" && row.reason === "clob_not_found") {
				await this.markVenueNotFoundCanceled(row.actionId);
			} else if (row.ledgerStatus === "error" && row.reason === "never_placed") {
				await this.markKnownRejected(row.actionId, "never_placed");
			}
		}
		return rows.length;
	}

	async markPlacementReceipt(
		actionId: string,
		receipt: OrderReceipt,
	): Promise<void> {
		await this.db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT 1 FROM ${polyPositionGapActions} WHERE ${polyPositionGapActions.id} = ${actionId} FOR UPDATE`,
			);
			const [before] = await tx
				.select()
				.from(polyPositionGapActions)
				.where(eq(polyPositionGapActions.id, actionId))
				.limit(1);
			if (!before) return;
			const observedFilledUsdc = Math.max(0, receipt.filled_size_usdc ?? 0);
			const observedFilledShares = Math.max(
				0,
				receipt.total_shares ??
					(receipt.fill_price && receipt.fill_price > 0
						? observedFilledUsdc / receipt.fill_price
						: 0),
			);
			const oldFilledShares = numberOf(before.filledShares);
			const oldFilledUsdc = numberOf(before.filledUsdc);
			const desiredShares = numberOf(before.desiredShares);
			const intendedNotional = numberOf(before.notionalUsdc);
			const authoritativeTradeCost =
				receipt.attributes?.realizedFillSource === "clob_associated_trades";
			const priorTradeCostSource =
				before.plannerAction.realized_fill_source ===
				"clob_associated_trades";
			const authoritativeObservationIsCurrent =
				authoritativeTradeCost &&
				(observedFilledShares > oldFilledShares + EPSILON ||
					(!priorTradeCostSource &&
						observedFilledShares + EPSILON >= oldFilledShares));
			const filledShares = Math.min(
				desiredShares,
				Math.max(oldFilledShares, observedFilledShares),
			);
			const filledUsdc = Math.min(
				intendedNotional,
				authoritativeObservationIsCurrent
					? observedFilledUsdc
					: Math.max(oldFilledUsdc, observedFilledUsdc),
			);
			const deltaFilledShares = Math.max(0, filledShares - oldFilledShares);
			const observedStatus = statusFromReceipt(receipt.status);
			const nextStatus = nextActionStatus(before.status, observedStatus);
			const correctsTerminalTradeCost =
				nextStatus === null &&
				authoritativeObservationIsCurrent &&
				["filled", "canceled"].includes(before.status);
			if (nextStatus === null && !correctsTerminalTradeCost) return;
			const status = (nextStatus ?? before.status) as
				| "open"
				| "partial"
				| "filled"
				| "cancel_requested"
				| "canceled";
			const limitPrice = numberOf(before.limitPrice);
			const unfilledShares = Math.max(0, desiredShares - filledShares);
			await tx
				.update(polyPositionGapActions)
				.set({
					orderId: receipt.order_id,
					status,
					venueStatus: receipt.status,
					venueObservedAt: new Date(),
					filledShares: filledShares.toString(),
					filledUsdc: filledUsdc.toString(),
					plannerAction: authoritativeObservationIsCurrent
						? {
								...before.plannerAction,
								realized_fill_source: "clob_associated_trades",
								fill_accounting_status: "verified",
								fill_accounting_last_attempt_at: new Date().toISOString(),
							}
						: before.plannerAction,
					errorCode: authoritativeObservationIsCurrent ? null : before.errorCode,
					errorDetail: authoritativeObservationIsCurrent ? null : before.errorDetail,
					submittedAt: new Date(),
					...(status === "filled" || status === "canceled"
						? { completedAt: new Date() }
						: {}),
					updatedAt: new Date(),
				})
				.where(eq(polyPositionGapActions.id, actionId));
			if (status === "canceled") {
				await tx
					.update(polyPositionGapActions)
					.set({
						status: "canceled",
						completedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(polyPositionGapActions.kind, "cancel"),
							eq(polyPositionGapActions.relatedBuyActionId, actionId),
							eq(polyPositionGapActions.status, "cancel_requested"),
						),
					);
			}

			const remainingWorstCaseNotional =
				status === "filled" || status === "canceled"
					? 0
					: unfilledShares * limitPrice;
			const desiredCashGuard = requiredBuyCollateralAtomic(
				remainingWorstCaseNotional,
			);
			const [reservation] = await tx
				.select()
				.from(polyPositionGapReservations)
				.where(eq(polyPositionGapReservations.buyActionId, actionId))
				.limit(1);
			if (reservation) {
				const originalGuard = BigInt(reservation.executorCashGuardAtomic);
				const releasedGuardNow =
					originalGuard > desiredCashGuard
						? originalGuard - desiredCashGuard
						: 0n;
				const releasedGuard =
					releasedGuardNow > BigInt(reservation.releasedCashGuardAtomic)
						? releasedGuardNow
						: BigInt(reservation.releasedCashGuardAtomic);
				const activeBudget = Math.min(
					intendedNotional,
					filledUsdc + remainingWorstCaseNotional,
				);
				const releasedBudget = Math.max(
					numberOf(reservation.releasedBudgetUsdc),
					intendedNotional - activeBudget,
				);
				await tx
					.update(polyPositionGapReservations)
					.set({
						filledCostUsdc: filledUsdc.toString(),
						releasedBudgetUsdc: releasedBudget.toString(),
						releasedCashGuardAtomic: releasedGuard.toString(),
						...(status === "canceled" && filledUsdc <= EPSILON
							? {
									state: "released" as const,
									releaseReason: "venue_cancel_confirmed",
									releasedAt: new Date(),
								}
							: {}),
						updatedAt: new Date(),
					})
					.where(eq(polyPositionGapReservations.id, reservation.id));
			}
			let restoreCanceledEntitlement = status === "canceled";
			if (status === "canceled") {
				const [requestedCancel] = await tx
					.select({ plannerAction: polyPositionGapActions.plannerAction })
					.from(polyPositionGapActions)
					.where(
						and(
							eq(polyPositionGapActions.kind, "cancel"),
							eq(polyPositionGapActions.relatedBuyActionId, before.id),
						),
					)
					.orderBy(desc(polyPositionGapActions.createdAt))
					.limit(1);
				const reason = String(
					requestedCancel?.plannerAction.reason ?? "venue_canceled",
				);
				restoreCanceledEntitlement = [
					"venue_canceled",
					"price_cap_lowered",
					"opposite_hold",
					"runtime_safety",
				].includes(reason);
			}
			if (deltaFilledShares > EPSILON || status === "canceled") {
				await tx
					.update(polyPositionGapCohorts)
					.set({
						acquiredShares: sql`${polyPositionGapCohorts.acquiredShares} + ${deltaFilledShares}`,
						openOrderShares: sql`GREATEST(0, ${polyPositionGapCohorts.openOrderShares} - ${
							status === "canceled"
								? deltaFilledShares + unfilledShares
								: deltaFilledShares
						})`,
						...(status === "canceled" && restoreCanceledEntitlement
							? {
									remainingShares: sql`LEAST(GREATEST(0, ${polyPositionGapCohorts.allowedMirrorShares} - ${polyPositionGapCohorts.acquiredShares} - ${deltaFilledShares}), ${polyPositionGapCohorts.remainingShares} + ${unfilledShares})`,
								}
							: {}),
						status:
							status === "filled"
								? "exhausted"
								: status === "canceled"
									? filledShares > EPSILON
										? "exhausted"
										: "available"
									: "resting",
						updatedAt: new Date(),
					})
					.where(eq(polyPositionGapCohorts.id, before.cohortId));
			}
		});
	}

	async hasOverlappingFillEvidenceOrder(
		scope: PositionGapRuntimeScope,
		action: PositionGapActiveBuy,
	): Promise<boolean> {
		if (!action.submitStartedAt || !action.completedAt) return true;
		const [row] = await this.db
			.select({ n: count() })
			.from(polyPositionGapActions)
			.where(
				and(
					eq(polyPositionGapActions.billingAccountId, scope.billingAccountId),
					eq(polyPositionGapActions.kind, "buy"),
					eq(polyPositionGapActions.tokenId, action.tokenId),
					sql`${polyPositionGapActions.id} <> ${action.id}::uuid`,
					sql`${polyPositionGapActions.submitStartedAt} IS NOT NULL`,
					sql`${polyPositionGapActions.submitStartedAt} <= ${new Date(action.completedAt.getTime() + 30_000)}`,
					sql`COALESCE(${polyPositionGapActions.completedAt}, now()) >= ${new Date(action.submitStartedAt.getTime() - 5_000)}`,
					sql`${polyPositionGapActions.status} <> 'rejected'`,
				),
			);
		return Number(row?.n ?? 0) > 0;
	}

	/**
	 * Atomically converges PGv3 runtime, ledger, and reservation accounting.
	 * Exact CLOB trade evidence wins over the Data-API fallback on replay.
	 */
	async applyDataApiFillAccounting(
		scope: PositionGapRuntimeScope,
		actionId: string,
		evidence: Extract<PositionGapFillEvidenceResult, { status: "verified" }>,
	): Promise<PositionGapAccountingTransition> {
		return this.db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT 1 FROM ${polyPositionGapActions}
					WHERE ${polyPositionGapActions.id} = ${actionId}
						AND ${polyPositionGapActions.billingAccountId} = ${scope.billingAccountId}
						AND ${polyPositionGapActions.targetId} = ${scope.targetId}::uuid
					FOR UPDATE`,
			);
			const [action] = await tx
				.select()
				.from(polyPositionGapActions)
				.where(
					and(
						eq(polyPositionGapActions.id, actionId),
						eq(polyPositionGapActions.billingAccountId, scope.billingAccountId),
						eq(polyPositionGapActions.targetId, scope.targetId),
						eq(polyPositionGapActions.createdByUserId, scope.createdByUserId),
					),
				)
				.limit(1);
			if (!action?.clientOrderId || !action.orderId) {
				throw new Error("position-gap fill repair action attribution changed");
			}
			if (!["filled", "canceled"].includes(action.status)) {
				throw new Error("position-gap fill repair requires a terminal action");
			}

			await tx.execute(
				sql`SELECT 1 FROM ${polyCopyTradeFills}
					WHERE ${polyCopyTradeFills.clientOrderId} = ${action.clientOrderId}
						AND ${polyCopyTradeFills.billingAccountId} = ${scope.billingAccountId}
						AND ${polyCopyTradeFills.targetId} = ${scope.targetId}::uuid
					FOR UPDATE`,
			);
			const [ledger] = await tx
				.select()
				.from(polyCopyTradeFills)
				.where(
					and(
						eq(polyCopyTradeFills.clientOrderId, action.clientOrderId),
						eq(polyCopyTradeFills.billingAccountId, scope.billingAccountId),
						eq(polyCopyTradeFills.targetId, scope.targetId),
					),
				)
				.limit(1);
			if (!ledger || ledger.orderId !== action.orderId) {
				throw new Error("position-gap fill repair ledger attribution changed");
			}
			const ledgerAttributes =
				ledger.attributes && typeof ledger.attributes === "object"
					? (ledger.attributes as Record<string, unknown>)
					: {};
			await tx.execute(
				sql`SELECT 1 FROM ${polyPositionGapReservations}
					WHERE ${polyPositionGapReservations.buyActionId} = ${action.id}
					FOR UPDATE`,
			);
			const [reservation] = await tx
				.select()
				.from(polyPositionGapReservations)
				.where(eq(polyPositionGapReservations.buyActionId, action.id))
				.limit(1);

			const actionShares = numberOf(action.filledShares);
			if (!sameNumber(action.filledShares, evidence.shares)) {
				throw new Error("position-gap fill repair shares changed");
			}
			const priorStatus = fillAccountingStatus(action.plannerAction);
			const actionSource = verifiedFillSource(action.plannerAction);
			const ledgerSource = verifiedFillSource(ledgerAttributes);
			const source =
				actionSource === "clob_associated_trades" ||
				ledgerSource === "clob_associated_trades"
					? "clob_associated_trades"
					: POSITION_GAP_DATA_API_FILL_SOURCE;
			const clobCost =
				ledgerSource === "clob_associated_trades"
					? numberOf(
							ledgerAttributes.filled_size_usdc as number | string | null,
						)
					: numberOf(action.filledUsdc);
			const clobShares =
				ledgerSource === "clob_associated_trades"
					? numberOf(ledger.shares)
					: actionShares;
			if (
				source === "clob_associated_trades" &&
				(!sameNumber(clobShares, actionShares) || clobCost <= 0)
			) {
				throw new Error("position-gap CLOB fill repair evidence changed");
			}
			const filledUsdc =
				source === "clob_associated_trades" ? clobCost : evidence.filledUsdc;
			const fillPrice =
				source === "clob_associated_trades"
					? filledUsdc / actionShares
					: evidence.fillPrice;
			const ledgerFee = numberOf(ledger.feesUsdc);
			const hasClobLedgerFee =
				ledgerSource === "clob_associated_trades" &&
				ledger.feesUsdc !== null &&
				Number.isFinite(ledgerFee) &&
				ledgerFee >= 0;
			const feesUsdc =
				hasClobLedgerFee ? ledgerFee : evidence.feesUsdc;
			const grossCashUsdc =
				source === POSITION_GAP_DATA_API_FILL_SOURCE
					? evidence.grossCashUsdc
					: filledUsdc + (feesUsdc ?? 0);
			const intendedNotional = numberOf(action.notionalUsdc);
			if (grossCashUsdc > intendedNotional + EPSILON) {
				throw new Error("position-gap fill repair exceeds intended notional");
			}
			const evidenceAttributes = {
				realized_fill_source: source,
				fill_accounting_status: "verified",
				fill_accounting_wallet: evidence.wallet,
				fill_accounting_transaction_hashes: evidence.transactionHashes,
				fill_accounting_gross_cash_usdc: grossCashUsdc,
				fill_accounting_evidence_start: evidence.evidenceStart,
				fill_accounting_evidence_end: evidence.evidenceEnd,
				fill_accounting_last_attempt_at: new Date().toISOString(),
			};
			await tx
				.update(polyPositionGapActions)
				.set({
					filledUsdc: filledUsdc.toString(),
					plannerAction: {
						...action.plannerAction,
						...evidenceAttributes,
					},
					errorCode: null,
					errorDetail: null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(polyPositionGapActions.id, action.id),
						eq(polyPositionGapActions.billingAccountId, scope.billingAccountId),
						eq(polyPositionGapActions.targetId, scope.targetId),
					),
				);
			await tx
				.update(polyCopyTradeFills)
				.set({
					price: fillPrice.toString(),
					shares: actionShares.toString(),
					...(feesUsdc !== undefined ? { feesUsdc: feesUsdc.toString() } : {}),
					attributes: {
						...ledgerAttributes,
						filled_size_usdc: filledUsdc,
						...evidenceAttributes,
					},
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(polyCopyTradeFills.clientOrderId, action.clientOrderId),
						eq(polyCopyTradeFills.billingAccountId, scope.billingAccountId),
						eq(polyCopyTradeFills.targetId, scope.targetId),
					),
				);

			if (reservation) {
				await tx
					.update(polyPositionGapReservations)
					.set({
						filledCostUsdc: grossCashUsdc.toString(),
						releasedBudgetUsdc: Math.max(
							numberOf(reservation.releasedBudgetUsdc),
							Math.max(0, intendedNotional - grossCashUsdc),
						).toString(),
						updatedAt: new Date(),
					})
					.where(eq(polyPositionGapReservations.id, reservation.id));
			}
			return {
				actionId,
				from: priorStatus,
				to: "verified",
				source,
				reason: null,
			};
		});
	}

	async markFillAccountingMismatch(
		scope: PositionGapRuntimeScope,
		actionId: string,
		reason: PositionGapFillEvidenceMismatchReason,
		detail: string,
	): Promise<PositionGapAccountingTransition> {
		return this.db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT 1 FROM ${polyPositionGapActions}
					WHERE ${polyPositionGapActions.id} = ${actionId}
						AND ${polyPositionGapActions.billingAccountId} = ${scope.billingAccountId}
						AND ${polyPositionGapActions.targetId} = ${scope.targetId}::uuid
					FOR UPDATE`,
			);
			const [action] = await tx
				.select({ plannerAction: polyPositionGapActions.plannerAction })
				.from(polyPositionGapActions)
				.where(
					and(
						eq(polyPositionGapActions.id, actionId),
						eq(polyPositionGapActions.billingAccountId, scope.billingAccountId),
						eq(polyPositionGapActions.targetId, scope.targetId),
						eq(polyPositionGapActions.createdByUserId, scope.createdByUserId),
					),
				)
				.limit(1);
			if (!action) {
				throw new Error(
					"position-gap fill mismatch action attribution changed",
				);
			}
			const priorStatus = fillAccountingStatus(action.plannerAction);
			const priorSource = verifiedFillSource(action.plannerAction);
			if (priorStatus === "verified") {
				return {
					actionId,
					from: "verified",
					to: "verified",
					source: priorSource,
					reason: null,
				};
			}
			const attempts = Number(action.plannerAction.fill_accounting_attempts ?? 0);
			await tx
				.update(polyPositionGapActions)
				.set({
					plannerAction: {
						...action.plannerAction,
						fill_accounting_status: "mismatch",
						fill_accounting_mismatch_reason: reason,
						fill_accounting_attempts:
							Number.isFinite(attempts) && attempts >= 0 ? attempts + 1 : 1,
						fill_accounting_last_attempt_at: new Date().toISOString(),
					},
					errorCode: "fill_accounting_mismatch",
					errorDetail: detail.slice(0, 500),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(polyPositionGapActions.id, actionId),
						eq(polyPositionGapActions.billingAccountId, scope.billingAccountId),
						eq(polyPositionGapActions.targetId, scope.targetId),
					),
				);
			return {
				actionId,
				from: priorStatus,
				to: "mismatch",
				source: null,
				reason,
			};
		});
	}

	async markFillAccountingPending(
		actionId: string,
		detail: string,
	): Promise<void> {
		await this.db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT 1 FROM ${polyPositionGapActions} WHERE ${polyPositionGapActions.id} = ${actionId} FOR UPDATE`,
			);
			const [action] = await tx
				.select({ plannerAction: polyPositionGapActions.plannerAction })
				.from(polyPositionGapActions)
				.where(eq(polyPositionGapActions.id, actionId))
				.limit(1);
			if (!action) return;
			const attempts = Number(
				action.plannerAction.fill_accounting_attempts ?? 0,
			);
			await tx
				.update(polyPositionGapActions)
				.set({
					plannerAction: {
						...action.plannerAction,
						fill_accounting_status: "pending",
						fill_accounting_attempts:
							Number.isFinite(attempts) && attempts >= 0 ? attempts + 1 : 1,
						fill_accounting_last_attempt_at: new Date().toISOString(),
					},
					errorCode: "fill_accounting_pending",
					errorDetail: detail.slice(0, 500),
					updatedAt: new Date(),
				})
				.where(eq(polyPositionGapActions.id, actionId));
		});
	}

	async markCancelConfirmed(cancelActionId: string): Promise<void> {
		await this.db.transaction(async (tx) => {
			const [cancel] = await tx
				.select()
				.from(polyPositionGapActions)
				.where(eq(polyPositionGapActions.id, cancelActionId))
				.limit(1);
			if (!cancel?.relatedBuyActionId) return;
			const [buy] = await tx
				.select()
				.from(polyPositionGapActions)
				.where(eq(polyPositionGapActions.id, cancel.relatedBuyActionId))
				.limit(1);
			if (!buy) return;
			if (cancel.status === "canceled" && buy.status === "canceled") return;
			const desiredShares = numberOf(buy.desiredShares);
			const filledShares = numberOf(buy.filledShares);
			const unfilledShares = Math.max(0, desiredShares - filledShares);
			const intended = numberOf(buy.notionalUsdc);
			const filled = numberOf(buy.filledUsdc);
			const unfilledUsdc = Math.max(0, intended - filled);
			const reason = String(cancel.plannerAction.reason ?? "target_reduced");

			await tx
				.update(polyPositionGapActions)
				.set({
					status: "canceled",
					completedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(inArray(polyPositionGapActions.id, [cancel.id, buy.id]));
			await tx
				.update(polyPositionGapReservations)
				.set({
					releasedBudgetUsdc: unfilledUsdc.toString(),
					releasedCashGuardAtomic:
						polyPositionGapReservations.executorCashGuardAtomic,
					state: filled > EPSILON ? "active" : "released",
					releaseReason: "cancel_confirmed",
					...(filled > EPSILON ? {} : { releasedAt: new Date() }),
					updatedAt: new Date(),
				})
				.where(eq(polyPositionGapReservations.buyActionId, buy.id));
			await tx
				.update(polyPositionGapCohorts)
				.set({
					openOrderShares: sql`GREATEST(0, ${polyPositionGapCohorts.openOrderShares} - ${unfilledShares})`,
					...(reason === "price_cap_lowered" ||
					reason === "opposite_hold" ||
					reason === "runtime_safety"
						? {
								remainingShares: sql`LEAST(GREATEST(0, ${polyPositionGapCohorts.allowedMirrorShares} - ${polyPositionGapCohorts.acquiredShares}), ${polyPositionGapCohorts.remainingShares} + ${unfilledShares})`,
							}
						: {}),
					status: filled > EPSILON ? "exhausted" : "reduced",
					updatedAt: new Date(),
				})
				.where(eq(polyPositionGapCohorts.id, buy.cohortId));
		});
	}

	async releaseTerminalExposure(
		scope: PositionGapRuntimeScope,
	): Promise<number> {
		return this.db.transaction(async (tx) => {
			const rows = await tx
				.select({
					reservationId: polyPositionGapReservations.id,
					cohortId: polyPositionGapReservations.cohortId,
					budget: polyPositionGapReservations.budgetNotionalUsdc,
					lifecycle: polyCopyTradeFills.positionLifecycle,
				})
				.from(polyPositionGapReservations)
				.innerJoin(
					polyPositionGapActions,
					eq(
						polyPositionGapActions.id,
						polyPositionGapReservations.buyActionId,
					),
				)
				.innerJoin(
					polyCopyTradeFills,
					eq(
						polyCopyTradeFills.clientOrderId,
						polyPositionGapActions.clientOrderId,
					),
				)
				.where(
					and(
						eq(
							polyPositionGapReservations.billingAccountId,
							scope.billingAccountId,
						),
						eq(polyPositionGapReservations.targetId, scope.targetId),
						eq(polyPositionGapReservations.state, "active"),
						inArray(polyCopyTradeFills.positionLifecycle, [
							"redeemed",
							"loser",
						]),
					),
				);
			for (const row of rows) {
				await tx
					.update(polyPositionGapReservations)
					.set({
						releasedBudgetUsdc: row.budget,
						releasedCashGuardAtomic: sql`${polyPositionGapReservations.executorCashGuardAtomic}`,
						state: "released",
						releaseReason:
							row.lifecycle === "redeemed"
								? "winner_redeemed"
								: "loser_terminal",
						releasedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(polyPositionGapReservations.id, row.reservationId));
				await tx
					.update(polyPositionGapCohorts)
					.set({
						status: "resolved",
						resolvedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(polyPositionGapCohorts.id, row.cohortId));
			}
			return rows.length;
		});
	}

	async finishRun(
		runId: string,
		status: "completed" | "skipped" | "halted" | "failed",
		errorCode?: string,
	): Promise<void> {
		const [run] = await this.db
			.select({
				billingAccountId: polyPositionGapRuns.billingAccountId,
				targetId: polyPositionGapRuns.targetId,
			})
			.from(polyPositionGapRuns)
			.where(eq(polyPositionGapRuns.id, runId))
			.limit(1);
		if (!run) return;
		const totals = await this.activeReservationTotals({
			billingAccountId: run.billingAccountId,
			createdByUserId: "unused",
			targetId: run.targetId,
		});
		await this.db
			.update(polyPositionGapRuns)
			.set({
				status,
				...(errorCode ? { errorCode } : {}),
				reservedBudgetUsdcAtEnd: totals.budgetUsdc.toString(),
				reservedCashAtomicAtEnd: totals.cashGuardAtomicForAccount.toString(),
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(polyPositionGapRuns.id, runId));
	}
}

export const POSITION_GAP_CASH_GUARD_SOURCE = CASH_GUARD_SOURCE;

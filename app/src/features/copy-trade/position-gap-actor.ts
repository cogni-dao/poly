// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Per-account Position-gap v3 actor. Target refresh is shared; wallet truth,
 * planning, reservations, and execution remain tenant-local.
 */

import { createHash } from "node:crypto";
import {
	BELOW_MARKET_MIN_CODE,
	clientOrderIdFor,
	type Fill,
	type GetOrderResult,
	type LoggerPort,
	type OrderIntent,
	type OrderReceipt,
	type TargetBookSnapshotV1,
} from "@cogni/poly-market-provider";
import {
	ClobRejectionError,
	FillAccountingPendingError,
} from "@cogni/poly-market-provider/adapters/polymarket";

import { requiredBuyCollateralAtomic } from "@/bootstrap/capabilities/poly-trade-executor";
import {
	effectivePositionGapBudget,
	type PositionGapBudgetGroup,
} from "@/features/copy-trade/position-gap-budget";
import {
	type PositionGapTargetActivity,
	projectPositionGapCohorts,
} from "@/features/copy-trade/position-gap-cohorts";
import {
	type PositionGapFillEvidencePort,
	reconcilePositionGapFillEvidence,
} from "@/features/copy-trade/position-gap-fill-evidence";
import { isStructuredClobRejection } from "@/features/copy-trade/position-gap-placement-errors";
import type {
	PositionGapAccountingTransition,
	PositionGapActiveBuy,
	PositionGapPreparedCancel,
	PositionGapRuntimeScope,
	PositionGapRuntimeStore,
} from "@/features/copy-trade/position-gap-runtime-store";
import type { PositionGapTargetRefreshCoordinator } from "@/features/copy-trade/position-gap-target-refresh";
import { planPositionGapBook } from "@/features/copy-trade/position-gap-v3/batch-plan";
import type {
	NettedTargetPositionV1,
	PositionGapBookPlanV1,
	PositionGapHoldingV1,
	PositionGapVenueConditionV1,
} from "@/features/copy-trade/position-gap-v3/model";
import { netTargetBook } from "@/features/copy-trade/position-gap-v3/netting";
import type { OrderLedger } from "@/features/trading";
import type { WalletActivitySource } from "@/features/wallet-watch";

const RECONCILE_MS = 30_000;
const FULL_REFRESH_MS = 5 * 60_000;
const VENUE_CACHE_MS = 30_000;
const MAX_VENUE_CANDIDATES = 16;
const WARMUP_SECONDS = 60;
const PLANNER_VERSION = "position-gap-v3/book-plan-v1";

export interface PositionGapBuyExecutionPort {
	placeBuy(intent: OrderIntent & { side: "BUY" }): Promise<OrderReceipt>;
	cancelBuy(orderId: string): Promise<void>;
	getBuy(orderId: string): Promise<GetOrderResult>;
	getMarketConstraints(
		tokenId: string,
		placement: "limit",
	): Promise<{
		minShares: number;
		minUsdcNotional?: number;
		tickSize?: number;
	}>;
}

export interface PositionGapActorDeps {
	scope: PositionGapRuntimeScope;
	targetWallet: `0x${string}`;
	configRevision: string;
	configuredBudgetUsdc: number | null;
	positionGapBudgetGroup: PositionGapBudgetGroup;
	source: WalletActivitySource;
	refresh: PositionGapTargetRefreshCoordinator;
	store: PositionGapRuntimeStore;
	ledger: OrderLedger;
	execution: PositionGapBuyExecutionPort;
	fillEvidence: PositionGapFillEvidencePort;
	getWalletCashUsdc(): Promise<number>;
	/** Exact Polygon CTF `balanceOfBatch`, including both binary legs. */
	getAuthoritativeShares(
		tokenIds: readonly string[],
	): Promise<readonly number[]>;
	logger: LoggerPort;
	now?: () => number;
	setInterval?: typeof globalThis.setInterval;
	clearInterval?: typeof globalThis.clearInterval;
	setTimeout?: typeof globalThis.setTimeout;
	clearTimeout?: typeof globalThis.clearTimeout;
}

export interface PositionGapActorHandle {
	wake(reason: "config" | "order_event" | "target_activity"): void;
	observeLedgerTerminal(
		clientOrderId: string,
		reason: "clob_not_found" | "never_placed",
	): void;
	stop(): Promise<void>;
}

export function startPositionGapActor(
	deps: PositionGapActorDeps,
): PositionGapActorHandle {
	const now = deps.now ?? Date.now;
	const scheduleInterval = deps.setInterval ?? globalThis.setInterval;
	const cancelInterval = deps.clearInterval ?? globalThis.clearInterval;
	const scheduleTimeout = deps.setTimeout ?? globalThis.setTimeout;
	const cancelTimeout = deps.clearTimeout ?? globalThis.clearTimeout;
	const reasons = new Set<string>(["activation"]);
	let cursor = Math.floor(now() / 1_000) - WARMUP_SECONDS;
	let draining: Promise<void> | null = null;
	let lastSnapshot: TargetBookSnapshotV1 | null = null;
	let disabled = false;
	let stopFailure: unknown = null;
	const causalDirty = new Set<string>();
	const ledgerTerminals = new Map<
		string,
		"clob_not_found" | "never_placed"
	>();
	let causalWatermarkMs = 0;
	let causalRetry: ReturnType<typeof globalThis.setTimeout> | null = null;
	const venueCache = new Map<
		string,
		{
			expiresAtMs: number;
			quote: PositionGapVenueConditionV1["quotes"][number];
		}
	>();

	const drain = (): Promise<void> => {
		if (draining) return draining;
		draining = (async () => {
			while (reasons.size > 0) {
				const batch = [...reasons];
				reasons.clear();
				try {
					if (batch.includes("disabled")) {
						// A terminal ledger transition can arrive after the actor has
						// disabled normal wakes. Consume both process-local and durable
						// evidence before retrying the safety cancellation.
						await reconcileKnownOrders();
						await deps.store.reconcileLedgerTerminals(deps.scope);
						await cancelAll("disabled");
						continue;
					}
					await reconcile(batch);
				} catch (error) {
					if (batch.includes("disabled")) stopFailure = error;
					deps.logger.error(
						{
							event: "poly.position_gap.v3.run_failed",
							billing_account_id: deps.scope.billingAccountId,
							target_wallet: deps.targetWallet,
							reasons: batch,
							err: error instanceof Error ? error.message : String(error),
						},
						"position-gap v3 reconciliation failed",
					);
				}
			}
		})().finally(() => {
			draining = null;
			if (reasons.size > 0) void drain();
		});
		return draining;
	};

	const enqueue = (reason: string): void => {
		if (disabled && reason !== "disabled") return;
		reasons.add(reason);
		void drain();
	};

	const unsubscribe = deps.source.subscribeWake?.(() =>
		enqueue("target_activity"),
	);
	const timer = scheduleInterval(() => enqueue("timer"), RECONCILE_MS);
	const refreshJitterMs =
		Number.parseInt(
			hashParts([deps.targetWallet.toLowerCase()]).slice(0, 4),
			16,
		) % 30_000;
	const fullRefreshTimer = scheduleInterval(
		() => enqueue("periodic_full"),
		FULL_REFRESH_MS + refreshJitterMs,
	);
	void deps.store
		.recoverSubmittingAsAmbiguous(deps.scope)
		.then(() => drain())
		.catch((error) =>
			deps.logger.error(
				{ err: error instanceof Error ? error.message : String(error) },
				"position-gap v3 startup recovery failed",
			),
		);

	return {
		wake(reason) {
			enqueue(reason);
		},
		observeLedgerTerminal(clientOrderId, reason) {
			ledgerTerminals.set(clientOrderId, reason);
			enqueue("order_event");
		},
		async stop() {
			if (!disabled) {
				disabled = true;
				cancelInterval(timer);
				cancelInterval(fullRefreshTimer);
				if (causalRetry) cancelTimeout(causalRetry);
				unsubscribe?.();
			}
			stopFailure = null;
			reasons.clear();
			reasons.add("disabled");
			// A replacement generation must not start while this generation can
			// still cancel account-scoped orders. Wait through the queued disabled
			// pass, even when stop races an in-flight reconciliation.
			while (draining || reasons.size > 0) {
				await drain();
			}
			if (stopFailure) throw stopFailure;
		},
	};

	async function reconcile(triggerReasons: readonly string[]): Promise<void> {
		let activity: Fill[] = [];
		if (triggerReasons.includes("target_activity")) {
			const drained = await deps.source.fetchSince(cursor);
			cursor = drained.newSince;
			activity = drained.fills;
		}

		const dirtyConditions = [
			...new Set([
				...activity.map(conditionIdFromFill),
				...(triggerReasons.includes("causal_retry") ? causalDirty : []),
			]),
		].filter((value): value is string => value !== null);
		const needsFull = triggerReasons.some(
			(reason) =>
				reason === "activation" ||
				reason === "config" ||
				reason === "periodic_full",
		);
		let refreshResult = needsFull
			? await deps.refresh.refreshFull(deps.targetWallet)
			: dirtyConditions.length > 0 &&
					(triggerReasons.includes("target_activity") ||
						triggerReasons.includes("causal_retry"))
				? await deps.refresh.refreshDirty(deps.targetWallet, dirtyConditions)
				: null;
		if (
			refreshResult?.published === false &&
			(refreshResult.reason === "missing_snapshot" ||
				refreshResult.reason === "stale_snapshot") &&
			(triggerReasons.includes("target_activity") ||
				triggerReasons.includes("causal_retry"))
		) {
			refreshResult = await deps.refresh.refreshFull(deps.targetWallet);
		}
		const snapshot =
			refreshResult?.published === true
				? refreshResult.snapshot
				: deps.refresh.readFresh(deps.targetWallet);
		const freshSnapshot = snapshot ?? lastSnapshot;
		if (refreshResult?.published === true)
			lastSnapshot = refreshResult.snapshot;
		if (!lastSnapshot)
			lastSnapshot = await deps.store.loadLastSnapshot(deps.scope);

		if (
			!freshSnapshot ||
			!freshSnapshot.complete ||
			now() >= freshSnapshot.expiresAtMs
		) {
			await cancelAll("stale_snapshot");
			return;
		}
		lastSnapshot = freshSnapshot;

		const newestActivityMs = activity.reduce(
			(maximum, fill) => Math.max(maximum, Date.parse(fill.observed_at)),
			0,
		);
		causalWatermarkMs = Math.max(causalWatermarkMs, newestActivityMs);
		const sourceComputedAtMs = Date.parse(
			freshSnapshot.refreshStats.sourceComputedAt,
		);
		if (
			causalWatermarkMs > 0 &&
			(!Number.isFinite(sourceComputedAtMs) ||
				sourceComputedAtMs < causalWatermarkMs)
		) {
			await cancelAll("causal_snapshot_lag");
			for (const conditionId of dirtyConditions) causalDirty.add(conditionId);
			if (!disabled && !causalRetry) {
				causalRetry = scheduleTimeout(() => {
					causalRetry = null;
					enqueue("causal_retry");
				}, 1_000);
			}
			return;
		}
		causalDirty.clear();
		causalWatermarkMs = 0;

		const accountingTransitions = await reconcileKnownOrders();
		await deps.store.reconcileLedgerTerminals(deps.scope);
		await deps.store.releaseTerminalExposure(deps.scope);
		const runtime = await deps.store.loadPlannerState(deps.scope);
		// Unknown venue state stays in the economic denominator. CLOB reads are
		// deferred until after the $1 theoretical feasibility bound below.
		const netBook = netTargetBook(freshSnapshot, new Map());
		const holdings = await loadHoldings(freshSnapshot);
		const walletCashUsdc = await deps.getWalletCashUsdc();
		const mirrorMarkedExposure = holdings.reduce((sum, holding) => {
			const token = tokenById(freshSnapshot, holding.tokenId);
			return sum + holding.shares * (token?.markPrice ?? 0);
		}, 0);
		const budgetAllocation = effectivePositionGapBudget({
			configuredBudgetUsdc: deps.configuredBudgetUsdc,
			mirrorNavUsdc: walletCashUsdc + mirrorMarkedExposure,
			group: deps.positionGapBudgetGroup,
		});
		if (!budgetAllocation) {
			await cancelAll("invalid_budget_group");
			return;
		}
		const budgetUsdc = budgetAllocation.effectiveBudgetUsdc;
		const scale =
			netBook.eligibleNetNavUsdc > 0
				? budgetUsdc / netBook.eligibleNetNavUsdc
				: 0;
		const existingCohorts = await deps.store.loadCohorts(deps.scope);
		const previousBudget = await deps.store.previousBudgetUsdc(deps.scope);
		const snapshotHash = hashJson(freshSnapshot);
		const cohortProjection = projectPositionGapCohorts({
			existing: existingCohorts,
			netTargetPositions: netBook.positions.map((position) =>
				toCohortPosition(freshSnapshot, position),
			),
			activity: activity.flatMap(toTargetActivity),
			snapshotId: freshSnapshot.snapshotId,
			snapshotHash,
			configRevision: deps.configRevision,
			previousBudgetUsdc: previousBudget,
			budgetUsdc,
			eligibleNetNavUsdc: netBook.eligibleNetNavUsdc,
			scale,
			// Every complete snapshot projects the config-revision activation keys.
			// Persisted keys (including resolved cohorts) make this an exact-once
			// backfill when a position first appears after activation.
			activation: true,
			nowMs: now(),
		});
		const reservations = await deps.store.activeReservationTotals(deps.scope);
		const capacity = await deps.store.loadConfirmedCapacity(deps.scope);
		const cashAtomic = BigInt(
			Math.max(0, Math.floor(walletCashUsdc * 1_000_000)),
		);
		const unreservedCashAtomic =
			cashAtomic > reservations.cashGuardAtomicForAccount
				? cashAtomic - reservations.cashGuardAtomicForAccount
				: 0n;
		const candidateTokens = selectPositionGapVenueCandidates({
			snapshot: freshSnapshot,
			cohorts: cohortProjection.cohorts,
			holdings,
			openOrders: runtime.openBuyOrders,
			perOrderHeadroomUsdc: capacity.perOrderUsdc,
		});
		const venues = await loadVenues(freshSnapshot, candidateTokens);
		const plan = planPositionGapBook({
			nowMs: now(),
			snapshot: freshSnapshot,
			sleeveBudgetUsdc: budgetUsdc,
			actualWalletCashUsdc: walletCashUsdc,
			confirmedBuyNotionalCashHeadroomUsdc:
				buyNotionalForCollateral(unreservedCashAtomic),
			confirmedSleeveHeadroomUsdc: Math.max(
				0,
				budgetUsdc - reservations.budgetUsdc,
			),
			confirmedStrategyCapHeadroomUsdc: Math.max(
				0,
				budgetUsdc - reservations.budgetUsdc,
			),
			confirmedAccountCapHeadroomUsdc: capacity.dailyHeadroomUsdc,
			confirmedPerOrderCapUsdc: capacity.perOrderUsdc,
			confirmedRemainingIntentCount: capacity.remainingIntentCount,
			maxIntents: 8,
			venues,
			cohorts: cohortProjection.cohorts.map((cohort) => ({
				cohortId: cohort.cohortKey,
				conditionId: cohort.conditionId,
				tokenId: cohort.tokenId,
				kind: cohort.sourceKind === "target_buy" ? "forward" : "activation",
				allowedMirrorShares: cohort.allowedMirrorShares,
				acquiredMirrorShares: cohort.acquiredShares,
				targetVwap: cohort.benchmarkTargetVwap,
			})),
			holdings,
			openBuyOrders: runtime.openBuyOrders,
		});
		await persistAndExecute({
			triggerReasons,
			snapshot: freshSnapshot,
			snapshotHash,
			budgetUsdc,
			walletCashUsdc,
			plan,
			cohortCreations: cohortProjection.creations,
			cohortReductions: cohortProjection.reductions,
			accountingTransitions,
		});
	}
	async function reconcileKnownOrders(): Promise<
		readonly PositionGapAccountingTransition[]
	> {
		const transitions: PositionGapAccountingTransition[] = [];
		const recovered = await deps.store.recoverKnownRejectedAmbiguities(
			deps.scope,
		);
		for (const action of recovered) {
			deps.logger.warn(
				{
					event: "poly.position_gap.v3.ambiguous_rejection_recovered",
					billing_account_id: deps.scope.billingAccountId,
					target_id: deps.scope.targetId,
					action_id: action.id,
					client_order_id: action.clientOrderId,
					error_code: action.errorCode,
				},
				"position-gap recovered a durable hard CLOB rejection",
			);
		}
		const runtime = await deps.store.loadPlannerState(deps.scope);
		for (const action of runtime.activeBuys) {
			const terminalReason = ledgerTerminals.get(action.clientOrderId);
			if (terminalReason === "clob_not_found") {
				await deps.store.markVenueNotFoundCanceled(action.id);
				ledgerTerminals.delete(action.clientOrderId);
				continue;
			}
			if (terminalReason === "never_placed") {
				await deps.store.markKnownRejected(action.id, terminalReason);
				ledgerTerminals.delete(action.clientOrderId);
				continue;
			}
			if (!action.orderId) continue;
			let result: GetOrderResult;
			try {
				result = await deps.execution.getBuy(action.orderId);
			} catch (error) {
				if (error instanceof FillAccountingPendingError) {
					if (["filled", "canceled"].includes(action.status)) {
						transitions.push(await repairFromDataApi(action));
					} else {
						await deps.store.markFillAccountingPending(
							action.id,
							error.message,
						);
					}
					continue;
				}
				if (["filled", "canceled"].includes(action.status)) {
					await deps.store.markFillAccountingPending(
						action.id,
						error instanceof Error ? error.message : String(error),
					);
					continue;
				}
				throw error;
			}
			if ("found" in result) {
				await deps.store.markPlacementReceipt(action.id, result.found);
				await deps.ledger.markOrderId({
					client_order_id: action.clientOrderId,
					receipt: result.found,
				});
			} else if (["filled", "canceled"].includes(action.status)) {
				transitions.push(await repairFromDataApi(action));
			}
		}
		return transitions;
	}

	async function repairFromDataApi(
		action: PositionGapActiveBuy,
	): Promise<PositionGapAccountingTransition> {
		try {
			const result = await reconcilePositionGapFillEvidence({
				port: deps.fillEvidence,
				conditionId: action.conditionId,
				tokenId: action.tokenId,
				expectedShares: action.filledShares,
				submitStartedAt: action.submitStartedAt,
				completedAt: action.completedAt,
				hasOverlappingOrder: await deps.store.hasOverlappingFillEvidenceOrder(
					deps.scope,
					action,
				),
			});
			return result.status === "verified"
				? deps.store.applyDataApiFillAccounting(deps.scope, action.id, result)
				: deps.store.markFillAccountingMismatch(
						deps.scope,
						action.id,
						result.reason,
						result.detail,
					);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			await deps.store.markFillAccountingPending(action.id, detail);
			return {
				actionId: action.id,
				from: "pending",
				to: "pending",
				source: null,
				reason: "data_api_unavailable",
			};
		}
	}

	async function loadVenues(
		snapshot: TargetBookSnapshotV1,
		candidateTokenIds: ReadonlySet<string>,
	): Promise<PositionGapVenueConditionV1[]> {
		return Promise.all(
			snapshot.conditions.map(async (condition) => {
				const settled = await Promise.allSettled(
					condition.tokens
						.filter((token) => candidateTokenIds.has(token.tokenId))
						.map(async (token) => {
							const cached = venueCache.get(token.tokenId);
							if (cached && cached.expiresAtMs > now()) return cached.quote;
							const constraints = await deps.execution.getMarketConstraints(
								token.tokenId,
								"limit",
							);
							const quote = {
								tokenId: token.tokenId,
								bestAsk: null,
								tickSize: constraints.tickSize ?? 0.01,
								minOrderShares: constraints.minShares,
								minOrderUsdc: constraints.minUsdcNotional ?? 0,
							};
							venueCache.set(token.tokenId, {
								expiresAtMs: now() + VENUE_CACHE_MS,
								quote,
							});
							return quote;
						}),
				);
				const quotes = settled.flatMap((entry) =>
					entry.status === "fulfilled" ? [entry.value] : [],
				);
				return {
					conditionId: condition.conditionId,
					status: quotes.length > 0 ? "accepting_orders" : "unknown",
					quotes,
				};
			}),
		);
	}

	async function loadHoldings(
		snapshot: TargetBookSnapshotV1,
	): Promise<PositionGapHoldingV1[]> {
		const tokens = snapshot.conditions.flatMap((condition) =>
			condition.tokens.map((token) => ({
				conditionId: condition.conditionId,
				tokenId: token.tokenId,
			})),
		);
		const shares = await deps.getAuthoritativeShares(
			tokens.map((token) => token.tokenId),
		);
		if (shares.length !== tokens.length) {
			throw new Error("authoritative holding tuple was incomplete");
		}
		return tokens.map((token, index) => ({
			...token,
			shares: finiteNonnegative(shares[index]),
		}));
	}

	async function persistAndExecute(input: {
		triggerReasons: readonly string[];
		snapshot: TargetBookSnapshotV1;
		snapshotHash: string;
		budgetUsdc: number;
		walletCashUsdc: number;
		plan: PositionGapBookPlanV1;
		cohortCreations: ReturnType<typeof projectPositionGapCohorts>["creations"];
		cohortReductions: ReturnType<
			typeof projectPositionGapCohorts
		>["reductions"];
		accountingTransitions: readonly PositionGapAccountingTransition[];
	}): Promise<void> {
		const preparedBuys = input.plan.intents.map((intent) => {
			const token = tokenById(input.snapshot, intent.tokenId);
			const actionKey = hashParts([
				"buy",
				input.snapshot.snapshotId,
				intent.cohortId,
				intent.shares.toString(),
				intent.limitPrice.toString(),
			]);
			return {
				actionKey,
				cohortKey: intent.cohortId,
				conditionId: intent.conditionId,
				tokenId: intent.tokenId,
				marketId: marketId(intent.conditionId),
				outcome: String(token?.outcomeIndex ?? "unknown"),
				shares: intent.shares,
				notionalUsdc: intent.notionalUsdc,
				limitPrice: intent.limitPrice,
				clientOrderId: clientOrderIdFor(
					deps.scope.billingAccountId,
					deps.scope.targetId,
					actionKey,
				),
				plannerAction: intent as unknown as Record<string, unknown>,
			};
		});
		const preparedCancels = input.plan.cancellations.map((cancel) => ({
			actionKey: hashParts([
				"cancel",
				input.snapshot.snapshotId,
				cancel.orderId,
				cancel.reason,
			]),
			cohortKey: cancel.cohortId,
			orderId: cancel.orderId,
			reason: cancel.reason,
			plannerAction: cancel as unknown as Record<string, unknown>,
		}));
		const persisted = await deps.store.persistPlan({
			scope: deps.scope,
			triggerReasons: input.triggerReasons,
			snapshot: {
				id: input.snapshot.snapshotId,
				hash: input.snapshotHash,
				asOf: new Date(input.snapshot.updatedAtMs),
				expiresAt: new Date(input.snapshot.expiresAtMs),
				value: input.snapshot as unknown as Record<string, unknown>,
			},
			plannerVersion: PLANNER_VERSION,
			budgetUsdc: input.budgetUsdc,
			eligibleNetNavUsdc: input.plan.eligibleNetNavUsdc,
			scale: input.plan.scale,
			walletCashUsdc: input.walletCashUsdc,
			plan: input.plan as unknown as Record<string, unknown>,
			cohortCreations: input.cohortCreations,
			cohortReductions: input.cohortReductions,
			buys: preparedBuys,
			cancellations: preparedCancels,
		});
		const activeByOrder = new Map(
			(await deps.store.loadPlannerState(deps.scope)).activeBuys.flatMap(
				(action) => (action.orderId ? [[action.orderId, action] as const] : []),
			),
		);

		for (const cancellation of persisted.cancellations) {
			await deps.execution.cancelBuy(cancellation.orderId);
			const observed = await deps.execution.getBuy(cancellation.orderId);
			if ("found" in observed && observed.found.status === "canceled") {
				await deps.store.markCancelConfirmed(cancellation.id);
				const active = activeByOrder.get(cancellation.orderId);
				if (active) {
					await deps.ledger.markCanceled({
						client_order_id: active.clientOrderId,
						reason: "position_gap_reconciled",
					});
				}
			}
		}

		let halted = false;
		let placedCount = 0;
		let filledCount = 0;
		for (const buy of persisted.buys) {
			if (halted) break;
			const prepared = preparedBuys.find(
				(candidate) => candidate.actionKey === buy.actionKey,
			);
			if (!prepared) continue;
			const intent = buildPositionGapBuyIntent(prepared);
			try {
				await deps.ledger
					.forTenant({
						billing_account_id: deps.scope.billingAccountId,
						created_by_user_id: deps.scope.createdByUserId,
					})
					.insertPending({
						target_id: deps.scope.targetId,
						fill_id: `position-gap-v3:${prepared.actionKey}`,
						observed_at: new Date(input.snapshot.updatedAtMs),
						intent,
					});
				await deps.store.markLedgered(buy.id);
				await deps.store.markSubmitting(buy.id);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				// No venue call has occurred; releasing this reservation is exact.
				await deps.store.markKnownRejected(buy.id, detail);
				await deps.ledger.markError({
					client_order_id: prepared.clientOrderId,
					error: detail,
				});
				continue;
			}
			try {
				const receipt = await deps.execution.placeBuy(intent);
				await deps.store.markPlacementReceipt(buy.id, receipt);
				placedCount += 1;
				if (receipt.status === "filled" || receipt.status === "partial") {
					filledCount += 1;
				}
				await deps.ledger.markOrderId({
					client_order_id: prepared.clientOrderId,
					receipt,
				});
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				if (knownNoOrder(error)) {
					await deps.store.markKnownRejected(buy.id, detail);
					await deps.ledger.markError({
						client_order_id: prepared.clientOrderId,
						error: detail,
					});
				} else {
					await deps.store.markAmbiguous(buy.id, detail);
					halted = true;
				}
			}
		}
		if (!halted) {
			const outcome =
				input.plan.intents.length === 0 && input.plan.cancellations.length === 0
					? "skipped"
					: "completed";
			await deps.store.finishRun(persisted.runId, outcome);
			deps.logger.info(
				{
					event: "poly.position_gap.v3.reconciled",
					billing_account_id: deps.scope.billingAccountId,
					target_wallet: deps.targetWallet,
					target_id: deps.scope.targetId,
					run_id: persisted.runId,
					trigger_reasons: input.triggerReasons,
					fill_accounting_transitions: input.accountingTransitions,
					outcome,
					snapshot_id: input.snapshot.snapshotId,
					snapshot_as_of: input.snapshot.updatedAtMs,
					eligible_net_nav_usdc: input.plan.eligibleNetNavUsdc,
					scale: input.plan.scale,
					sleeve_budget_usdc: input.budgetUsdc,
					wallet_cash_usdc: input.walletCashUsdc,
					existing_reserved_usdc: input.plan.existingReservedUsdc,
					new_reserved_usdc: input.plan.newReservedUsdc,
					minimum_feasible_sleeve_usdc:
						input.plan.minimumFeasibleSleeveUsdc,
					planned_intents: input.plan.intents.length,
					planned_cancellations: input.plan.cancellations.length,
					intent_details: input.plan.intents.slice(0, 8).map((intent) => {
						const diagnostic = input.plan.diagnostics.find(
							(row) =>
								row.conditionId === intent.conditionId &&
								row.tokenId === intent.tokenId &&
								row.cohortId === intent.cohortId,
						);
						return {
							condition_id: intent.conditionId,
							token_id: intent.tokenId,
							cohort_kind: intent.cohortKind,
							target_weight: diagnostic?.targetWeight,
							desired_shares: intent.desiredShares,
							held_shares: intent.heldShares,
							open_shares: intent.openShares,
							gap_shares: intent.gapShares,
							floor_usdc: intent.floorNotionalUsdc,
							limit_price: intent.limitPrice,
							target_vwap: intent.targetVwap,
							notional_usdc: intent.notionalUsdc,
						};
					}),
					decision_details: input.plan.diagnostics.slice(0, 16).map((row) => ({
						condition_id: row.conditionId,
						token_id: row.tokenId,
						reason: row.reason,
						target_weight: row.targetWeight,
						desired_shares: row.desiredShares,
						held_shares: row.heldShares,
						open_shares: row.openShares,
						gap_shares: row.gapShares,
						floor_usdc: row.floorNotionalUsdc,
						minimum_sleeve_usdc: row.minimumSleeveUsdc,
						limit_price: row.limitPrice,
						target_vwap: row.targetVwap,
					})),
					placed_count: placedCount,
					filled_count: filledCount,
				},
				"position-gap v3 reconciliation completed",
			);
		}
	}

	async function cancelAll(
		reason:
			| "causal_snapshot_lag"
			| "disabled"
			| "invalid_budget_group"
			| "stale_snapshot",
	): Promise<void> {
		const runtime = await deps.store.loadPlannerState(deps.scope);
		for (const action of runtime.activeBuys) {
			if (
				!action.orderId &&
				(action.status === "reserved" || action.status === "ledgered")
			) {
				await deps.store.markKnownRejected(action.id, `runtime_${reason}`);
				await deps.ledger.markError({
					client_order_id: action.clientOrderId,
					error: `runtime_${reason}`,
				});
			}
			if (
				!action.orderId &&
				(action.status === "submitting" || action.status === "ambiguous")
			) {
				throw new Error(
					`cannot safely stop position-gap with unresolved ${action.status} action ${action.id}`,
				);
			}
		}
		const orders = runtime.openBuyOrders;
		if (orders.length === 0) return;
		const snapshot =
			lastSnapshot ?? (await deps.store.loadLastSnapshot(deps.scope));
		if (!snapshot) {
			throw new Error(
				"cannot audit safety cancellation without prior snapshot",
			);
		}
		lastSnapshot = snapshot;
		const cancellations: PositionGapPreparedCancel[] = orders.map((order) => ({
			actionKey: hashParts([
				"safety-cancel",
				snapshot.snapshotId,
				order.orderId,
				reason,
			]),
			cohortKey: order.cohortId,
			orderId: order.orderId,
			reason: "runtime_safety",
			plannerAction: {
				orderId: order.orderId,
				conditionId: order.conditionId,
				tokenId: order.tokenId,
				cohortId: order.cohortId,
				reason: "runtime_safety",
				reservedUsdc: order.reservedUsdc,
				safetyReason: reason,
			},
		}));
		const walletCashUsdc = await deps.getWalletCashUsdc();
		const safetyBudgetUsdc = Math.max(
			deps.configuredBudgetUsdc ?? walletCashUsdc,
			0.00000001,
		);
		const plan = blockedSafetyPlan(
			snapshot,
			orders,
			reason,
			safetyBudgetUsdc,
			walletCashUsdc,
		);
		const persisted = await deps.store.persistPlan({
			scope: deps.scope,
			triggerReasons: [reason],
			snapshot: {
				id: snapshot.snapshotId,
				hash: hashJson(snapshot),
				asOf: new Date(snapshot.updatedAtMs),
				expiresAt: new Date(snapshot.expiresAtMs),
				value: snapshot as unknown as Record<string, unknown>,
			},
			plannerVersion: PLANNER_VERSION,
			budgetUsdc: safetyBudgetUsdc,
			eligibleNetNavUsdc: 0,
			scale: 0,
			walletCashUsdc,
			plan: plan as unknown as Record<string, unknown>,
			cohortCreations: [],
			cohortReductions: [],
			buys: [],
			cancellations,
		});
		const activeByOrder = new Map(
			runtime.activeBuys.flatMap((action) =>
				action.orderId ? [[action.orderId, action] as const] : [],
			),
		);
		const cancellationFailures: string[] = [];
		for (const cancellation of persisted.cancellations) {
			const active = activeByOrder.get(cancellation.orderId);
			try {
				await requireConfirmedSafetyCancellation({
					execution: deps.execution,
					store: deps.store,
					ledger: deps.ledger,
					cancellation,
					...(active ? { active } : {}),
				});
			} catch (error) {
				cancellationFailures.push(
					`${cancellation.orderId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (cancellationFailures.length > 0) {
			throw new Error(
				`position-gap safety cancellation failed for ${cancellationFailures.join("; ")}`,
			);
		}
		await deps.store.finishRun(persisted.runId, "halted", reason);
	}
}

export function buildPositionGapBuyIntent(input: {
	marketId: string;
	outcome: string;
	notionalUsdc: number;
	limitPrice: number;
	clientOrderId: string;
	tokenId: string;
	conditionId: string;
	cohortKey: string;
}): OrderIntent & { side: "BUY" } {
	return {
		provider: "polymarket",
		market_id: input.marketId,
		outcome: input.outcome,
		side: "BUY",
		size_usdc: input.notionalUsdc,
		limit_price: input.limitPrice,
		client_order_id: input.clientOrderId,
		attributes: {
			token_id: input.tokenId,
			condition_id: input.conditionId,
			orderType: "GTC",
			placement: "limit",
			position_gap_version: "3",
			position_gap_cohort_key: input.cohortKey,
		},
	};
}

function conditionIdFromFill(fill: Fill): string | null {
	for (const value of [
		fill.attributes?.condition_id,
		fill.attributes?.conditionId,
	]) {
		if (typeof value === "string" && value.length > 0)
			return value.toLowerCase();
	}
	const normalized = fill.market_id.replace(
		/^prediction-market:polymarket:/,
		"",
	);
	return normalized.length > 0 ? normalized.toLowerCase() : null;
}

function tokenIdFromFill(fill: Fill): string | null {
	for (const value of [
		fill.attributes?.asset,
		fill.attributes?.token_id,
		fill.attributes?.tokenId,
	]) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

function toTargetActivity(fill: Fill): PositionGapTargetActivity[] {
	const conditionId = conditionIdFromFill(fill);
	const tokenId = tokenIdFromFill(fill);
	if (!conditionId || !tokenId || fill.price <= 0) return [];
	return [
		{
			fillId: fill.fill_id,
			side: fill.side,
			conditionId,
			tokenId,
			marketId: fill.market_id,
			outcome: fill.outcome,
			shares: fill.size_usdc / fill.price,
			price: fill.price,
			observedAtMs: Date.parse(fill.observed_at),
		},
	];
}

function toCohortPosition(
	snapshot: TargetBookSnapshotV1,
	position: NettedTargetPositionV1,
) {
	const token = tokenById(snapshot, position.tokenId);
	return {
		conditionId: position.conditionId,
		tokenId: position.tokenId,
		marketId: marketId(position.conditionId),
		outcome: String(token?.outcomeIndex ?? "unknown"),
		netShares: position.netShares,
		activationPriceCap: position.activationPriceCap,
	};
}

function tokenById(snapshot: TargetBookSnapshotV1, tokenId: string) {
	for (const condition of snapshot.conditions) {
		for (const token of condition.tokens) {
			if (token.tokenId === tokenId) return token;
		}
	}
	return null;
}

function marketId(conditionId: string): string {
	return `prediction-market:polymarket:${conditionId}`;
}

function finiteNonnegative(value: number | undefined): number {
	return Number.isFinite(value) && (value ?? -1) >= 0 ? (value as number) : 0;
}

function hashJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashParts(parts: readonly string[]): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function buyNotionalForCollateral(atomic: bigint): number {
	if (atomic <= 0n) return 0;
	let low = 0;
	let high = Number(atomic) / 1_000_000;
	for (let index = 0; index < 60; index += 1) {
		const middle = (low + high) / 2;
		if (requiredBuyCollateralAtomic(middle) <= atomic) low = middle;
		else high = middle;
	}
	return Math.floor(low * 1_000_000) / 1_000_000;
}

export function knownNoOrder(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (
		error.name === "PolyTradeExecutorError" &&
		(error as Error & { code?: string }).code === "not_authorized"
	)
		return true;
	if (error instanceof ClobRejectionError || isStructuredClobRejection(error))
		return true;
	return (error as Error & { code?: string }).code === BELOW_MARKET_MIN_CODE;
}

export async function requireConfirmedSafetyCancellation(input: {
	execution: Pick<PositionGapBuyExecutionPort, "cancelBuy" | "getBuy">;
	store: Pick<
		PositionGapRuntimeStore,
		"markCancelConfirmed" | "markPlacementReceipt"
	>;
	ledger: Pick<OrderLedger, "markCanceled" | "markOrderId">;
	cancellation: { id: string; orderId: string };
	active?: PositionGapActiveBuy;
}): Promise<void> {
	await input.execution.cancelBuy(input.cancellation.orderId);
	const observed = await input.execution.getBuy(input.cancellation.orderId);
	if ("found" in observed && observed.found.status === "canceled") {
		await input.store.markCancelConfirmed(input.cancellation.id);
		if (input.active) {
			await input.ledger.markCanceled({
				client_order_id: input.active.clientOrderId,
				reason: "position_gap_runtime_safety",
			});
		}
		return;
	}
	if ("found" in observed && observed.found.status === "filled") {
		if (input.active) {
			await input.store.markPlacementReceipt(input.active.id, observed.found);
			await input.ledger.markOrderId({
				client_order_id: input.active.clientOrderId,
				receipt: observed.found,
			});
		}
		return;
	}
	throw new Error(
		`position-gap safety cancellation unconfirmed for ${input.cancellation.orderId}`,
	);
}

function blockedSafetyPlan(
	snapshot: TargetBookSnapshotV1,
	orders: readonly {
		orderId: string;
		conditionId: string;
		tokenId: string;
		cohortId: string;
		reservedUsdc: number;
	}[],
	reason:
		| "causal_snapshot_lag"
		| "disabled"
		| "invalid_budget_group"
		| "stale_snapshot",
	sleeveBudgetUsdc: number,
	walletCashUsdc: number,
): PositionGapBookPlanV1 {
	return {
		version: 1,
		status: "blocked",
		blockReason:
			reason === "stale_snapshot" ? "stale_snapshot" : "invalid_input",
		snapshotId: snapshot.snapshotId,
		targetWallet: snapshot.targetWallet,
		eligibleNetNavUsdc: 0,
		scale: 0,
		sleeveBudgetUsdc,
		existingReservedUsdc: orders.reduce(
			(sum, order) => sum + order.reservedUsdc,
			0,
		),
		newReservedUsdc: 0,
		actualWalletCashUsdc: walletCashUsdc,
		confirmedBuyNotionalCashHeadroomUsdc: 0,
		confirmedAllocationHeadroomUsdc: 0,
		remainingBuyNotionalCashHeadroomUsdc: 0,
		intents: [],
		cancellations: orders.map((order) => ({
			...order,
			reason: "target_reduced",
		})),
		lockedOverweights: [],
		diagnostics: [],
		minimumFeasibleSleeveUsdc: null,
	};
}

export function selectPositionGapVenueCandidates(input: {
	snapshot: TargetBookSnapshotV1;
	cohorts: readonly {
		tokenId: string;
		allowedMirrorShares: number;
		benchmarkTargetVwap: number;
	}[];
	holdings: readonly PositionGapHoldingV1[];
	openOrders: readonly { tokenId: string; remainingShares: number }[];
	perOrderHeadroomUsdc: number;
}): ReadonlySet<string> {
	const byToken = new Map<
		string,
		{ allowed: number; priceCap: number; held: number; open: number }
	>();
	for (const cohort of input.cohorts) {
		const current = byToken.get(cohort.tokenId) ?? {
			allowed: 0,
			priceCap: 0,
			held: 0,
			open: 0,
		};
		current.allowed += cohort.allowedMirrorShares;
		current.priceCap = Math.max(current.priceCap, cohort.benchmarkTargetVwap);
		byToken.set(cohort.tokenId, current);
	}
	const netHoldings = new Map<string, number>();
	for (const holding of input.holdings) {
		netHoldings.set(
			holding.tokenId,
			(netHoldings.get(holding.tokenId) ?? 0) + holding.shares,
		);
	}
	for (const condition of input.snapshot.conditions) {
		const [left, right] = condition.tokens;
		if (!left || !right) continue;
		const leftShares = netHoldings.get(left.tokenId) ?? 0;
		const rightShares = netHoldings.get(right.tokenId) ?? 0;
		const completeSetShares = Math.min(leftShares, rightShares);
		netHoldings.set(left.tokenId, Math.max(0, leftShares - completeSetShares));
		netHoldings.set(
			right.tokenId,
			Math.max(0, rightShares - completeSetShares),
		);
	}
	for (const [tokenId, shares] of netHoldings) {
		const current = byToken.get(tokenId);
		if (current) current.held += shares;
	}
	for (const order of input.openOrders) {
		const current = byToken.get(order.tokenId);
		if (current) current.open += order.remainingShares;
	}
	return new Set(
		[...byToken.entries()]
			.map(([tokenId, value]) => ({
				tokenId,
				gapShares: Math.max(0, value.allowed - value.held - value.open),
				theoreticalNotional:
					Math.max(0, value.allowed - value.held - value.open) * value.priceCap,
			}))
			.filter(
				(entry) =>
					entry.gapShares > 0 && input.perOrderHeadroomUsdc > 0,
			)
			.sort(
				(left, right) =>
					right.gapShares - left.gapShares ||
					right.theoreticalNotional - left.theoreticalNotional ||
					left.tokenId.localeCompare(right.tokenId),
			)
			.slice(0, MAX_VENUE_CANDIDATES)
			.map((entry) => entry.tokenId),
	);
}

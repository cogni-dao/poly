// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Pure contracts for the buy-only, whole-book position-gap planner.
 *
 * Target-book truth is deliberately separate from venue truth. An unknown
 * venue remains in the allocation denominator but cannot create an order;
 * only an authoritative `closed` state removes a condition from that
 * denominator.
 */

import type { TargetBookSnapshotV1 } from "@cogni/poly-market-provider";

export type PositionGapVenueStatusV1 =
	| "accepting_orders"
	| "closed"
	| "unknown";

export type PositionGapVenueQuoteV1 = Readonly<{
	tokenId: string;
	/** `null` means a valid but empty ask book. */
	bestAsk: number | null;
	tickSize: number;
	minOrderShares: number;
	minOrderUsdc: number;
}>;

export type PositionGapVenueConditionV1 = Readonly<{
	conditionId: string;
	status: PositionGapVenueStatusV1;
	quotes: readonly PositionGapVenueQuoteV1[];
}>;

/**
 * Quantity and price provenance are frozen together. `allowedMirrorShares`
 * is an already-authorized mirror quantity: a denominator or mark change may
 * reduce it through current target state, but can never manufacture more.
 */
export type PositionGapPriceCohortV1 = Readonly<{
	cohortId: string;
	conditionId: string;
	tokenId: string;
	kind: "activation" | "forward";
	allowedMirrorShares: number;
	/** Durable fills attributed to this cohort; planner clamps to wallet truth. */
	acquiredMirrorShares: number;
	/** Durable entitlement not yet consumed by a fill or active BUY reservation. */
	availableNewBuyShares: number;
	targetVwap: number;
}>;

export type PositionGapHoldingV1 = Readonly<{
	conditionId: string;
	tokenId: string;
	shares: number;
}>;

export type PositionGapOpenBuyOrderV1 = Readonly<{
	orderId: string;
	conditionId: string;
	tokenId: string;
	cohortId: string;
	remainingShares: number;
	reservedUsdc: number;
	limitPrice: number;
}>;

export type PositionGapBookInputV1 = Readonly<{
	nowMs: number;
	snapshot: TargetBookSnapshotV1;
	sleeveBudgetUsdc: number;
	/** Human-visible raw wallet collateral, never used directly for allocation. */
	actualWalletCashUsdc: number;
	/**
	 * Confirmed BUY notional allowed by wallet collateral after executor buffer
	 * semantics (`requiredBuyCollateralAtomic`). Canceled cash is not added.
	 */
	confirmedBuyNotionalCashHeadroomUsdc: number;
	/** Confirmed remaining sleeve capacity after held capital and reservations. */
	confirmedSleeveHeadroomUsdc: number;
	/** Confirmed remaining strategy-level placement authority. */
	confirmedStrategyCapHeadroomUsdc: number;
	/** Confirmed remaining account/grant placement authority. */
	confirmedAccountCapHeadroomUsdc: number;
	/** Defense-in-depth ceiling for each newly emitted order. */
	confirmedPerOrderCapUsdc: number;
	/** Confirmed hourly/intent-count capacity remaining for this account. */
	confirmedRemainingIntentCount: number;
	maxIntents: number;
	venues: readonly PositionGapVenueConditionV1[];
	cohorts: readonly PositionGapPriceCohortV1[];
	holdings: readonly PositionGapHoldingV1[];
	openBuyOrders: readonly PositionGapOpenBuyOrderV1[];
}>;

export type NettedTargetPositionV1 = Readonly<{
	conditionId: string;
	tokenId: string;
	oppositeTokenId: string;
	netShares: number;
	completeSetShares: number;
	markPrice: number;
	averagePrice: number;
	/** Net economic break-even after valuing matched complete sets at $1. */
	netBreakEvenPrice: number | null;
	/** Strict activation/config catch-up cap; null fails that cohort closed. */
	activationPriceCap: number | null;
	negativeRisk: boolean;
}>;

export type NettedTargetBookV1 = Readonly<{
	positions: readonly NettedTargetPositionV1[];
	eligibleNetNavUsdc: number;
	closedConditionIds: readonly string[];
	ineligibleTargetPositions: readonly Readonly<{
		conditionId: string;
		tokenId: string;
		reason: "invalid_mark_price";
	}>[];
}>;

export type PositionGapCandidateV1 = Readonly<{
	id: string;
	conditionId: string;
	tokenId: string;
	cohortId: string;
	cohortKind: "activation" | "forward";
	targetWeight: number;
	limitPrice: number;
	targetVwap: number;
	maxShares: number;
	floorShares: number;
	floorNotionalUsdc: number;
}>;

export type PositionGapAllocatedLotV1 = PositionGapCandidateV1 &
	Readonly<{
		shares: number;
		notionalUsdc: number;
	}>;

export type PositionGapBuyIntentV1 = Readonly<{
	side: "BUY";
	conditionId: string;
	tokenId: string;
	cohortId: string;
	cohortKind: "activation" | "forward";
	limitPrice: number;
	targetVwap: number;
	shares: number;
	notionalUsdc: number;
	floorNotionalUsdc: number;
	desiredShares: number;
	heldShares: number;
	openShares: number;
	gapShares: number;
}>;

export type PositionGapCancellationReasonV1 =
	| "condition_closed"
	| "opposite_hold"
	| "price_cap_lowered"
	| "target_reduced";

export type PositionGapCancelDirectiveV1 = Readonly<{
	orderId: string;
	conditionId: string;
	tokenId: string;
	cohortId: string;
	reason: PositionGapCancellationReasonV1;
	reservedUsdc: number;
}>;

export type PositionGapLockedOverweightV1 = Readonly<{
	conditionId: string;
	tokenId: string;
	desiredShares: number;
	heldShares: number;
	excessShares: number;
	reason: "filled_above_desired" | "condition_closed";
}>;

export type PositionGapDecisionReasonV1 =
	| "allocated"
	| "allocation_headroom"
	| "below_market_floor"
	| "blocked_by_opposite_hold"
	| "cohort_waiting"
	| "condition_closed"
	| "invalid_target_mark"
	| "invalid_cohort"
	| "invalid_quote"
	| "missing_cohort"
	| "no_gap"
	| "per_order_cap"
	| "venue_unknown";

export type PositionGapTokenDecisionV1 = Readonly<{
	conditionId: string;
	tokenId: string;
	cohortId: string | null;
	reason: PositionGapDecisionReasonV1;
	desiredShares: number;
	heldShares: number;
	openShares: number;
	gapShares: number;
	targetWeight: number;
	limitPrice: number | null;
	targetVwap: number | null;
	floorNotionalUsdc: number | null;
	minimumSleeveUsdc: number | null;
}>;

export type PositionGapPlanBlockReasonV1 = "invalid_input" | "stale_snapshot";

export type PositionGapBookPlanV1 = Readonly<{
	version: 1;
	status: "ready" | "no_feasible_position" | "blocked";
	blockReason: PositionGapPlanBlockReasonV1 | null;
	snapshotId: string;
	targetWallet: string;
	eligibleNetNavUsdc: number;
	scale: number;
	sleeveBudgetUsdc: number;
	existingReservedUsdc: number;
	newReservedUsdc: number;
	actualWalletCashUsdc: number;
	confirmedBuyNotionalCashHeadroomUsdc: number;
	confirmedAllocationHeadroomUsdc: number;
	remainingBuyNotionalCashHeadroomUsdc: number;
	intents: readonly PositionGapBuyIntentV1[];
	cancellations: readonly PositionGapCancelDirectiveV1[];
	lockedOverweights: readonly PositionGapLockedOverweightV1[];
	diagnostics: readonly PositionGapTokenDecisionV1[];
	minimumFeasibleSleeveUsdc: number | null;
}>;

export const POSITION_GAP_MAX_INTENTS_PER_PLAN = 8;
export const POSITION_GAP_EPSILON = 1e-9;

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { allocatePositionGapLots, quantizeUsdcUp } from "./allocator";
import type {
	NettedTargetPositionV1,
	PositionGapBookInputV1,
	PositionGapBookPlanV1,
	PositionGapBuyIntentV1,
	PositionGapCancelDirectiveV1,
	PositionGapCandidateV1,
	PositionGapHoldingV1,
	PositionGapLockedOverweightV1,
	PositionGapOpenBuyOrderV1,
	PositionGapPriceCohortV1,
	PositionGapTokenDecisionV1,
	PositionGapVenueConditionV1,
	PositionGapVenueQuoteV1,
} from "./model";
import {
	POSITION_GAP_EPSILON,
	POSITION_GAP_MAX_INTENTS_PER_PLAN,
} from "./model";
import { netTargetBook } from "./netting";
import { strictBuyLimitPrice } from "./price-cohort";

const CLOB_MIN_BUY_NOTIONAL_USDC = 1;

type CandidateContext = Readonly<{
	desiredShares: number;
	heldShares: number;
	openShares: number;
	gapShares: number;
}>;

/** Build one deterministic, BUY-only whole-book reconciliation plan. */
export function planPositionGapBook(
	input: PositionGapBookInputV1,
): PositionGapBookPlanV1 {
	const existingReservedUsdc = finiteNonnegativeSum(
		input.openBuyOrders.map((order) => order.reservedUsdc),
	);
	if (!validInput(input)) {
		return blockedPlan(input, existingReservedUsdc, "invalid_input");
	}
	if (input.nowMs >= input.snapshot.expiresAtMs) {
		return blockedPlan(input, existingReservedUsdc, "stale_snapshot");
	}

	const venues = uniqueMap(input.venues, (venue) => venue.conditionId);
	if (venues === undefined) {
		return blockedPlan(input, existingReservedUsdc, "invalid_input");
	}
	const venueStatus = new Map(
		[...venues].map(([conditionId, venue]) => [conditionId, venue.status]),
	);
	const netBook = netTargetBook(input.snapshot, venueStatus);
	const eligibleNetNavUsdc = netBook.eligibleNetNavUsdc;
	const scale =
		eligibleNetNavUsdc > POSITION_GAP_EPSILON
			? input.sleeveBudgetUsdc / eligibleNetNavUsdc
			: 0;

	const holdings = netMirrorHoldings(input.holdings, input.snapshot);
	const openOrders = [...input.openBuyOrders].sort(orderIdentity);
	const cancellations = new Map<string, PositionGapCancelDirectiveV1>();
	const lockedOverweights: PositionGapLockedOverweightV1[] = [];
	const diagnostics: PositionGapTokenDecisionV1[] = [];
	const candidates: PositionGapCandidateV1[] = [];
	const candidateContexts = new Map<string, CandidateContext>();
	const minimumSleeves: number[] = [];
	for (const excluded of netBook.ineligibleTargetPositions) {
		diagnostics.push({
			conditionId: excluded.conditionId,
			tokenId: excluded.tokenId,
			cohortId: null,
			reason: "invalid_target_mark",
			desiredShares: 0,
			heldShares:
				holdings.get(key(excluded.conditionId, excluded.tokenId)) ?? 0,
			openShares: 0,
			gapShares: 0,
			targetWeight: 0,
			limitPrice: null,
			targetVwap: null,
			floorNotionalUsdc: null,
			minimumSleeveUsdc: null,
		});
	}

	for (const conditionId of netBook.closedConditionIds) {
		for (const order of openOrders.filter(
			(entry) => entry.conditionId === conditionId,
		)) {
			cancel(cancellations, order, "condition_closed");
		}
		for (const [key, heldShares] of holdings) {
			const [heldConditionId, tokenId] = splitKey(key);
			if (
				heldConditionId !== conditionId ||
				heldShares <= POSITION_GAP_EPSILON
			) {
				continue;
			}
			lockedOverweights.push({
				conditionId,
				tokenId,
				desiredShares: 0,
				heldShares,
				excessShares: heldShares,
				reason: "condition_closed",
			});
		}
	}

	const activePositionKeys = new Set(
		netBook.positions.map((position) =>
			key(position.conditionId, position.tokenId),
		),
	);
	const knownCohortKeys = new Set(
		input.cohorts.map((cohort) =>
			cohortKey(cohort.conditionId, cohort.tokenId, cohort.cohortId),
		),
	);
	const closedConditionIds = new Set(netBook.closedConditionIds);
	for (const order of openOrders) {
		if (closedConditionIds.has(order.conditionId)) continue;
		if (
			!activePositionKeys.has(key(order.conditionId, order.tokenId)) ||
			!knownCohortKeys.has(
				cohortKey(order.conditionId, order.tokenId, order.cohortId),
			)
		) {
			cancel(cancellations, order, "target_reduced");
		}
	}
	for (const [holdingKey, heldShares] of holdings) {
		const [conditionId, tokenId] = splitKey(holdingKey);
		if (
			heldShares <= POSITION_GAP_EPSILON ||
			closedConditionIds.has(conditionId) ||
			activePositionKeys.has(holdingKey)
		) {
			continue;
		}
		lockedOverweights.push({
			conditionId,
			tokenId,
			desiredShares: 0,
			heldShares,
			excessShares: heldShares,
			reason: "filled_above_desired",
		});
	}

	for (const position of netBook.positions) {
		planPosition({
			input,
			position,
			venue: venues.get(position.conditionId),
			scale,
			eligibleNetNavUsdc,
			holdings,
			openOrders,
			cancellations,
			lockedOverweights,
			diagnostics,
			candidates,
			candidateContexts,
			minimumSleeves,
		});
	}

	const confirmedAllocationHeadroomUsdc = Math.max(
		0,
		Math.min(
			input.sleeveBudgetUsdc,
			input.confirmedBuyNotionalCashHeadroomUsdc,
			input.confirmedSleeveHeadroomUsdc,
			input.confirmedStrategyCapHeadroomUsdc,
			input.confirmedAccountCapHeadroomUsdc,
		),
	);
	const lots = allocatePositionGapLots(
		candidates,
		confirmedAllocationHeadroomUsdc,
		Math.min(
			input.maxIntents,
			input.confirmedRemainingIntentCount,
			POSITION_GAP_MAX_INTENTS_PER_PLAN,
		),
	);
	const allocatedIds = new Set(lots.map((lot) => lot.id));
	const intents: PositionGapBuyIntentV1[] = lots.map((lot) => {
		const context = candidateContexts.get(lot.id);
		if (context === undefined) {
			throw new Error(`missing candidate context: ${lot.id}`);
		}
		return {
			side: "BUY",
			conditionId: lot.conditionId,
			tokenId: lot.tokenId,
			cohortId: lot.cohortId,
			cohortKind: lot.cohortKind,
			limitPrice: lot.limitPrice,
			targetVwap: lot.targetVwap,
			shares: lot.shares,
			notionalUsdc: lot.notionalUsdc,
			floorNotionalUsdc: lot.floorNotionalUsdc,
			...context,
		};
	});

	for (let index = 0; index < diagnostics.length; index += 1) {
		const decision = diagnostics[index];
		if (
			decision !== undefined &&
			decision.cohortId !== null &&
			allocatedIds.has(candidateId(decision.tokenId, decision.cohortId))
		) {
			diagnostics[index] = { ...decision, reason: "allocated" };
		}
	}

	const newReservedUsdc = intents.reduce(
		(sum, intent) => sum + intent.notionalUsdc,
		0,
	);
	const sortedCancellations = [...cancellations.values()].sort(orderIdentity);
	const status =
		intents.length > 0 || sortedCancellations.length > 0
			? "ready"
			: "no_feasible_position";

	return {
		version: 1,
		status,
		blockReason: null,
		snapshotId: input.snapshot.snapshotId,
		targetWallet: input.snapshot.targetWallet,
		eligibleNetNavUsdc,
		scale,
		sleeveBudgetUsdc: input.sleeveBudgetUsdc,
		existingReservedUsdc,
		newReservedUsdc,
		actualWalletCashUsdc: input.actualWalletCashUsdc,
		confirmedBuyNotionalCashHeadroomUsdc:
			input.confirmedBuyNotionalCashHeadroomUsdc,
		confirmedAllocationHeadroomUsdc,
		remainingBuyNotionalCashHeadroomUsdc: Math.max(
			0,
			input.confirmedBuyNotionalCashHeadroomUsdc - newReservedUsdc,
		),
		intents,
		cancellations: sortedCancellations,
		lockedOverweights: lockedOverweights.sort(positionIdentity),
		diagnostics: diagnostics.sort(decisionIdentity),
		minimumFeasibleSleeveUsdc:
			minimumSleeves.length > 0 ? Math.min(...minimumSleeves) : null,
	};
}

function planPosition(params: {
	input: PositionGapBookInputV1;
	position: NettedTargetPositionV1;
	venue: PositionGapVenueConditionV1 | undefined;
	scale: number;
	eligibleNetNavUsdc: number;
	holdings: ReadonlyMap<string, number>;
	openOrders: readonly PositionGapOpenBuyOrderV1[];
	cancellations: Map<string, PositionGapCancelDirectiveV1>;
	lockedOverweights: PositionGapLockedOverweightV1[];
	diagnostics: PositionGapTokenDecisionV1[];
	candidates: PositionGapCandidateV1[];
	candidateContexts: Map<string, CandidateContext>;
	minimumSleeves: number[];
}): void {
	const {
		input,
		position,
		venue,
		scale,
		eligibleNetNavUsdc,
		holdings,
		openOrders,
		cancellations,
		lockedOverweights,
		diagnostics,
		candidates,
		candidateContexts,
		minimumSleeves,
	} = params;
	const tokenKey = key(position.conditionId, position.tokenId);
	const heldTotal = holdings.get(tokenKey) ?? 0;
	const targetScaledShares = position.netShares * scale;
	const oppositeHeld =
		holdings.get(key(position.conditionId, position.oppositeTokenId)) ?? 0;
	if (oppositeHeld > POSITION_GAP_EPSILON) {
		for (const order of openOrders.filter(
			(entry) =>
				entry.conditionId === position.conditionId &&
				entry.tokenId === position.tokenId,
		)) {
			cancel(cancellations, order, "opposite_hold");
		}
		diagnostics.push(
			decision(
				position,
				null,
				"blocked_by_opposite_hold",
				targetScaledShares,
				heldTotal,
			),
		);
		return;
	}
	const cohorts = input.cohorts
		.filter(
			(cohort) =>
				cohort.conditionId === position.conditionId &&
				cohort.tokenId === position.tokenId,
		)
		.sort(cohortOrder);

	if (cohorts.length === 0) {
		diagnostics.push(
			decision(position, null, "missing_cohort", targetScaledShares, heldTotal),
		);
		if (heldTotal > POSITION_GAP_EPSILON) {
			lockedOverweights.push({
				conditionId: position.conditionId,
				tokenId: position.tokenId,
				desiredShares: 0,
				heldShares: heldTotal,
				excessShares: heldTotal,
				reason: "filled_above_desired",
			});
		}
		for (const order of openOrders.filter(
			(entry) =>
				entry.conditionId === position.conditionId &&
				entry.tokenId === position.tokenId,
		)) {
			cancel(cancellations, order, "target_reduced");
		}
		return;
	}

	let remainingTargetDesired = targetScaledShares;
	let totalCohortDesired = 0;
	const assignments: Array<{
		cohort: PositionGapPriceCohortV1;
		desiredShares: number;
		heldShares: number;
	}> = [];
	for (const cohort of cohorts) {
		if (!validCohort(cohort)) {
			diagnostics.push(
				decision(position, cohort.cohortId, "invalid_cohort", 0, 0),
			);
			for (const order of openOrders.filter(
				(entry) =>
					entry.conditionId === position.conditionId &&
					entry.tokenId === position.tokenId &&
					entry.cohortId === cohort.cohortId,
			)) {
				cancel(cancellations, order, "target_reduced");
			}
			continue;
		}
		const desiredShares = Math.max(
			0,
			Math.min(cohort.allowedMirrorShares, remainingTargetDesired),
		);
		remainingTargetDesired -= desiredShares;
		totalCohortDesired += desiredShares;
		assignments.push({ cohort, desiredShares, heldShares: 0 });
	}

	// First honor durable cohort attribution, but never beyond wallet truth.
	let remainingHeld = heldTotal;
	for (const assignment of assignments) {
		const attributed = Math.min(
			assignment.cohort.acquiredMirrorShares,
			assignment.desiredShares,
			remainingHeld,
		);
		assignment.heldShares = attributed;
		remainingHeld -= attributed;
	}
	// Any wallet shares lacking durable provenance offset the strictest cohort
	// first. This is conservative and permutation-independent.
	for (const assignment of assignments) {
		const unattributed = Math.min(
			assignment.desiredShares - assignment.heldShares,
			remainingHeld,
		);
		assignment.heldShares += unattributed;
		remainingHeld -= unattributed;
	}

	let candidateSelected = false;
	for (const assignment of assignments) {
		const selected = planCohort({
			position,
			cohort: assignment.cohort,
			desiredShares: assignment.desiredShares,
			heldShares: assignment.heldShares,
			venue,
			sleeveBudgetUsdc: input.sleeveBudgetUsdc,
			eligibleNetNavUsdc,
			perOrderCapUsdc: input.confirmedPerOrderCapUsdc,
			candidateAllowed: !candidateSelected,
			openOrders,
			cancellations,
			diagnostics,
			candidates,
			candidateContexts,
			minimumSleeves,
		});
		candidateSelected ||= selected;
	}

	if (heldTotal > totalCohortDesired + POSITION_GAP_EPSILON) {
		lockedOverweights.push({
			conditionId: position.conditionId,
			tokenId: position.tokenId,
			desiredShares: totalCohortDesired,
			heldShares: heldTotal,
			excessShares: heldTotal - totalCohortDesired,
			reason: "filled_above_desired",
		});
	}
}

function planCohort(params: {
	position: NettedTargetPositionV1;
	cohort: PositionGapPriceCohortV1;
	desiredShares: number;
	heldShares: number;
	venue: PositionGapVenueConditionV1 | undefined;
	sleeveBudgetUsdc: number;
	eligibleNetNavUsdc: number;
	perOrderCapUsdc: number;
	candidateAllowed: boolean;
	openOrders: readonly PositionGapOpenBuyOrderV1[];
	cancellations: Map<string, PositionGapCancelDirectiveV1>;
	diagnostics: PositionGapTokenDecisionV1[];
	candidates: PositionGapCandidateV1[];
	candidateContexts: Map<string, CandidateContext>;
	minimumSleeves: number[];
}): boolean {
	const {
		position,
		cohort,
		desiredShares,
		heldShares,
		venue,
		sleeveBudgetUsdc,
		eligibleNetNavUsdc,
		perOrderCapUsdc,
		candidateAllowed,
		openOrders,
		cancellations,
		diagnostics,
		candidates,
		candidateContexts,
		minimumSleeves,
	} = params;
	const cohortOrders = openOrders.filter(
		(order) =>
			order.conditionId === position.conditionId &&
			order.tokenId === position.tokenId &&
			order.cohortId === cohort.cohortId,
	);
	const quote = venue?.quotes.find(
		(entry) => entry.tokenId === position.tokenId,
	);
	const targetVwap =
		cohort.kind === "activation"
			? position.activationPriceCap === null
				? null
				: Math.min(cohort.targetVwap, position.activationPriceCap)
			: cohort.targetVwap;
	if (targetVwap === null) {
		for (const order of cohortOrders) {
			cancel(cancellations, order, "price_cap_lowered");
		}
		diagnostics.push(
			decision(
				position,
				cohort.cohortId,
				"invalid_cohort",
				desiredShares,
				heldShares,
			),
		);
		return false;
	}
	const strictCap =
		quote === undefined
			? undefined
			: strictBuyLimitPrice({
					targetVwap,
					bestAsk: null,
					tickSize: quote.tickSize,
				});

	for (const order of cohortOrders) {
		if (
			strictCap?.ok === true &&
			order.limitPrice > strictCap.price + POSITION_GAP_EPSILON
		) {
			cancel(cancellations, order, "price_cap_lowered");
		}
	}

	let retained = cohortOrders.filter(
		(order) => !cancellations.has(order.orderId),
	);
	const maxOpenShares = Math.max(0, desiredShares - heldShares);
	let retainedShares = sumShares(retained);
	for (const order of [...retained].sort(cancelPreference)) {
		if (retainedShares <= maxOpenShares + POSITION_GAP_EPSILON) break;
		cancel(cancellations, order, "target_reduced");
		retainedShares -= order.remainingShares;
	}
	retained = retained.filter((order) => !cancellations.has(order.orderId));
	const openShares = sumShares(retained);
	const gapShares = Math.min(
		Math.max(0, desiredShares - heldShares - openShares),
		cohort.availableNewBuyShares,
	);
	const targetWeight =
		eligibleNetNavUsdc > POSITION_GAP_EPSILON
			? (position.netShares * position.markPrice) / eligibleNetNavUsdc
			: 0;
	const hadCancellation = cohortOrders.some((order) =>
		cancellations.has(order.orderId),
	);

	if (gapShares <= POSITION_GAP_EPSILON || hadCancellation) {
		diagnostics.push({
			...decision(
				position,
				cohort.cohortId,
				"no_gap",
				desiredShares,
				heldShares,
				openShares,
				gapShares,
				targetWeight,
			),
			targetVwap,
		});
		return false;
	}
	if (venue?.status !== "accepting_orders") {
		diagnostics.push(
			decision(
				position,
				cohort.cohortId,
				venue?.status === "closed" ? "condition_closed" : "venue_unknown",
				desiredShares,
				heldShares,
				openShares,
				gapShares,
				targetWeight,
			),
		);
		return false;
	}
	if (quote === undefined || !validQuote(quote)) {
		diagnostics.push(
			decision(
				position,
				cohort.cohortId,
				"invalid_quote",
				desiredShares,
				heldShares,
				openShares,
				gapShares,
				targetWeight,
			),
		);
		return false;
	}
	const limit = strictBuyLimitPrice({
		targetVwap,
		bestAsk: quote.bestAsk,
		tickSize: quote.tickSize,
	});
	if (!limit.ok) {
		diagnostics.push(
			decision(
				position,
				cohort.cohortId,
				"invalid_quote",
				desiredShares,
				heldShares,
				openShares,
				gapShares,
				targetWeight,
			),
		);
		return false;
	}

	const floorNotionalUsdc = quantizeUsdcUp(
		Math.max(
			CLOB_MIN_BUY_NOTIONAL_USDC,
			quote.minOrderUsdc,
			quote.minOrderShares * limit.price,
		),
	);
	const floorShares = floorNotionalUsdc / limit.price;
	if (perOrderCapUsdc + POSITION_GAP_EPSILON < floorNotionalUsdc) {
		diagnostics.push({
			...decision(
				position,
				cohort.cohortId,
				"per_order_cap",
				desiredShares,
				heldShares,
				openShares,
				gapShares,
				targetWeight,
			),
			limitPrice: limit.price,
			targetVwap,
			floorNotionalUsdc,
		});
		return false;
	}
	const scaledFloorSleeveUsdc =
		((heldShares + openShares + floorShares) * eligibleNetNavUsdc) /
		position.netShares;
	// A larger sleeve creates an explicit config-increase cohort. Report that
	// remedy even though today's durable cohort cannot yet clear the share floor;
	// retain null when only stale/cohort provenance (not scale) is blocking.
	const minimumSleeveUsdc =
		cohort.allowedMirrorShares + POSITION_GAP_EPSILON >=
			heldShares + openShares + floorShares ||
		scaledFloorSleeveUsdc > sleeveBudgetUsdc + POSITION_GAP_EPSILON
			? scaledFloorSleeveUsdc
			: null;
	if (minimumSleeveUsdc !== null && Number.isFinite(minimumSleeveUsdc)) {
		minimumSleeves.push(minimumSleeveUsdc);
	}
	if (gapShares + POSITION_GAP_EPSILON < floorShares) {
		diagnostics.push({
			...decision(
				position,
				cohort.cohortId,
				"below_market_floor",
				desiredShares,
				heldShares,
				openShares,
				gapShares,
				targetWeight,
			),
			limitPrice: limit.price,
			targetVwap,
			floorNotionalUsdc,
			minimumSleeveUsdc,
		});
		return false;
	}
	if (!candidateAllowed) {
		diagnostics.push({
			...decision(
				position,
				cohort.cohortId,
				"cohort_waiting",
				desiredShares,
				heldShares,
				openShares,
				gapShares,
				targetWeight,
			),
			limitPrice: limit.price,
			targetVwap,
			floorNotionalUsdc,
			minimumSleeveUsdc,
		});
		return false;
	}

	const id = candidateId(position.tokenId, cohort.cohortId);
	const maxShares = Math.min(gapShares, perOrderCapUsdc / limit.price);
	if (maxShares + POSITION_GAP_EPSILON < floorShares) {
		return false;
	}
	const candidate: PositionGapCandidateV1 = {
		id,
		conditionId: position.conditionId,
		tokenId: position.tokenId,
		cohortId: cohort.cohortId,
		cohortKind: cohort.kind,
		targetWeight,
		limitPrice: limit.price,
		targetVwap,
		maxShares,
		floorShares,
		floorNotionalUsdc,
	};
	candidates.push(candidate);
	candidateContexts.set(id, {
		desiredShares,
		heldShares,
		openShares,
		gapShares,
	});
	diagnostics.push({
		...decision(
			position,
			cohort.cohortId,
			"allocation_headroom",
			desiredShares,
			heldShares,
			openShares,
			gapShares,
			targetWeight,
		),
		limitPrice: limit.price,
		targetVwap,
		floorNotionalUsdc,
		minimumSleeveUsdc,
	});
	return true;
}

function blockedPlan(
	input: PositionGapBookInputV1,
	existingReservedUsdc: number,
	blockReason: "invalid_input" | "stale_snapshot",
): PositionGapBookPlanV1 {
	return {
		version: 1,
		status: "blocked",
		blockReason,
		snapshotId: input.snapshot.snapshotId,
		targetWallet: input.snapshot.targetWallet,
		eligibleNetNavUsdc: 0,
		scale: 0,
		sleeveBudgetUsdc: finiteOrZero(input.sleeveBudgetUsdc),
		existingReservedUsdc,
		newReservedUsdc: 0,
		actualWalletCashUsdc: finiteOrZero(input.actualWalletCashUsdc),
		confirmedBuyNotionalCashHeadroomUsdc: finiteOrZero(
			input.confirmedBuyNotionalCashHeadroomUsdc,
		),
		confirmedAllocationHeadroomUsdc: 0,
		remainingBuyNotionalCashHeadroomUsdc: finiteOrZero(
			input.confirmedBuyNotionalCashHeadroomUsdc,
		),
		intents: [],
		cancellations: [],
		lockedOverweights: [],
		diagnostics: [],
		minimumFeasibleSleeveUsdc: null,
	};
}

function validInput(input: PositionGapBookInputV1): boolean {
	const finiteNonnegative = [
		input.nowMs,
		input.sleeveBudgetUsdc,
		input.actualWalletCashUsdc,
		input.confirmedBuyNotionalCashHeadroomUsdc,
		input.confirmedSleeveHeadroomUsdc,
		input.confirmedStrategyCapHeadroomUsdc,
		input.confirmedAccountCapHeadroomUsdc,
		input.confirmedPerOrderCapUsdc,
	];
	return (
		input.snapshot.version === 1 &&
		input.snapshot.complete === true &&
		finiteNonnegative.every((value) => Number.isFinite(value) && value >= 0) &&
		Number.isInteger(input.maxIntents) &&
		input.maxIntents >= 0 &&
		Number.isInteger(input.confirmedRemainingIntentCount) &&
		input.confirmedRemainingIntentCount >= 0 &&
		input.holdings.every(validHolding) &&
		input.openBuyOrders.every(validOpenOrder) &&
		uniqueCohortIds(input.cohorts)
	);
}

function validHolding(holding: PositionGapHoldingV1): boolean {
	return (
		holding.conditionId.length > 0 &&
		holding.tokenId.length > 0 &&
		Number.isFinite(holding.shares) &&
		holding.shares >= 0
	);
}

function validOpenOrder(order: PositionGapOpenBuyOrderV1): boolean {
	return (
		order.orderId.length > 0 &&
		order.conditionId.length > 0 &&
		order.tokenId.length > 0 &&
		order.cohortId.length > 0 &&
		Number.isFinite(order.remainingShares) &&
		order.remainingShares >= 0 &&
		Number.isFinite(order.reservedUsdc) &&
		order.reservedUsdc >= 0 &&
		Number.isFinite(order.limitPrice) &&
		order.limitPrice > 0 &&
		order.limitPrice < 1
	);
}

function validCohort(cohort: PositionGapPriceCohortV1): boolean {
	return (
		cohort.cohortId.length > 0 &&
		cohort.conditionId.length > 0 &&
		cohort.tokenId.length > 0 &&
		(cohort.kind === "activation" || cohort.kind === "forward") &&
		Number.isFinite(cohort.allowedMirrorShares) &&
		cohort.allowedMirrorShares >= 0 &&
		Number.isFinite(cohort.acquiredMirrorShares) &&
		cohort.acquiredMirrorShares >= 0 &&
		Number.isFinite(cohort.availableNewBuyShares) &&
		cohort.availableNewBuyShares >= 0 &&
		Number.isFinite(cohort.targetVwap) &&
		cohort.targetVwap > 0 &&
		cohort.targetVwap < 1
	);
}

function validQuote(quote: PositionGapVenueQuoteV1): boolean {
	return (
		Number.isFinite(quote.tickSize) &&
		quote.tickSize > 0 &&
		Number.isFinite(quote.minOrderShares) &&
		quote.minOrderShares > 0 &&
		Number.isFinite(quote.minOrderUsdc) &&
		quote.minOrderUsdc >= 0 &&
		(quote.bestAsk === null ||
			(Number.isFinite(quote.bestAsk) &&
				quote.bestAsk > 0 &&
				quote.bestAsk < 1))
	);
}

function netMirrorHoldings(
	holdings: readonly PositionGapHoldingV1[],
	snapshot: PositionGapBookInputV1["snapshot"],
): ReadonlyMap<string, number> {
	const result = new Map<string, number>();
	for (const holding of holdings) {
		const holdingKey = key(holding.conditionId, holding.tokenId);
		result.set(holdingKey, (result.get(holdingKey) ?? 0) + holding.shares);
	}
	for (const condition of snapshot.conditions) {
		const [left, right] = condition.tokens;
		const leftKey = key(condition.conditionId, left.tokenId);
		const rightKey = key(condition.conditionId, right.tokenId);
		const leftShares = result.get(leftKey) ?? 0;
		const rightShares = result.get(rightKey) ?? 0;
		const completeSetShares = Math.min(leftShares, rightShares);
		result.set(leftKey, Math.max(0, leftShares - completeSetShares));
		result.set(rightKey, Math.max(0, rightShares - completeSetShares));
	}
	return result;
}

function cancel(
	cancellations: Map<string, PositionGapCancelDirectiveV1>,
	order: PositionGapOpenBuyOrderV1,
	reason: PositionGapCancelDirectiveV1["reason"],
): void {
	if (cancellations.has(order.orderId)) return;
	cancellations.set(order.orderId, {
		orderId: order.orderId,
		conditionId: order.conditionId,
		tokenId: order.tokenId,
		cohortId: order.cohortId,
		reason,
		reservedUsdc: order.reservedUsdc,
	});
}

function decision(
	position: NettedTargetPositionV1,
	cohortId: string | null,
	reason: PositionGapTokenDecisionV1["reason"],
	desiredShares: number,
	heldShares: number,
	openShares = 0,
	gapShares = Math.max(0, desiredShares - heldShares - openShares),
	targetWeight = 0,
): PositionGapTokenDecisionV1 {
	return {
		conditionId: position.conditionId,
		tokenId: position.tokenId,
		cohortId,
		reason,
		desiredShares,
		heldShares,
		openShares,
		gapShares,
		targetWeight,
		limitPrice: null,
		targetVwap: null,
		floorNotionalUsdc: null,
		minimumSleeveUsdc: null,
	};
}

function candidateId(tokenId: string, cohortId: string): string {
	return `${tokenId}\u0000${cohortId}`;
}

function key(conditionId: string, tokenId: string): string {
	return `${conditionId}\u0000${tokenId}`;
}

function cohortKey(
	conditionId: string,
	tokenId: string,
	cohortId: string,
): string {
	return `${conditionId}\u0000${tokenId}\u0000${cohortId}`;
}

function splitKey(value: string): readonly [string, string] {
	const separator = value.indexOf("\u0000");
	return [value.slice(0, separator), value.slice(separator + 1)];
}

function uniqueMap<T>(
	values: readonly T[],
	getKey: (value: T) => string,
): Map<string, T> | undefined {
	const result = new Map<string, T>();
	for (const value of values) {
		const valueKey = getKey(value);
		if (result.has(valueKey)) return undefined;
		result.set(valueKey, value);
	}
	return result;
}

function finiteNonnegativeSum(values: readonly number[]): number {
	if (values.some((value) => !Number.isFinite(value) || value < 0)) return 0;
	return values.reduce((sum, value) => sum + value, 0);
}

function finiteOrZero(value: number): number {
	return Number.isFinite(value) && value >= 0 ? value : 0;
}

function sumShares(orders: readonly PositionGapOpenBuyOrderV1[]): number {
	return orders.reduce((sum, order) => sum + order.remainingShares, 0);
}

function orderIdentity(
	left: PositionGapOpenBuyOrderV1 | PositionGapCancelDirectiveV1,
	right: PositionGapOpenBuyOrderV1 | PositionGapCancelDirectiveV1,
): number {
	return (
		left.conditionId.localeCompare(right.conditionId) ||
		left.tokenId.localeCompare(right.tokenId) ||
		left.cohortId.localeCompare(right.cohortId) ||
		left.orderId.localeCompare(right.orderId)
	);
}

function cancelPreference(
	left: PositionGapOpenBuyOrderV1,
	right: PositionGapOpenBuyOrderV1,
): number {
	return (
		right.limitPrice - left.limitPrice ||
		left.orderId.localeCompare(right.orderId)
	);
}

function cohortOrder(
	left: PositionGapPriceCohortV1,
	right: PositionGapPriceCohortV1,
): number {
	return (
		left.targetVwap - right.targetVwap ||
		left.cohortId.localeCompare(right.cohortId)
	);
}

function uniqueCohortIds(
	cohorts: readonly PositionGapPriceCohortV1[],
): boolean {
	const seen = new Set<string>();
	for (const cohort of cohorts) {
		const cohortKey = key(cohort.tokenId, cohort.cohortId);
		if (seen.has(cohortKey)) return false;
		seen.add(cohortKey);
	}
	return true;
}

function positionIdentity(
	left: PositionGapLockedOverweightV1,
	right: PositionGapLockedOverweightV1,
): number {
	return (
		left.conditionId.localeCompare(right.conditionId) ||
		left.tokenId.localeCompare(right.tokenId)
	);
}

function decisionIdentity(
	left: PositionGapTokenDecisionV1,
	right: PositionGapTokenDecisionV1,
): number {
	return (
		left.conditionId.localeCompare(right.conditionId) ||
		left.tokenId.localeCompare(right.tokenId) ||
		(left.cohortId ?? "").localeCompare(right.cohortId ?? "")
	);
}

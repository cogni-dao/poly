// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type {
	PositionGapAllocatedLotV1,
	PositionGapCandidateV1,
} from "./model";
import {
	POSITION_GAP_EPSILON,
	POSITION_GAP_MAX_INTENTS_PER_PLAN,
} from "./model";

function candidateOrder(
	left: PositionGapCandidateV1,
	right: PositionGapCandidateV1,
): number {
	return (
		right.targetWeight - left.targetWeight ||
		left.conditionId.localeCompare(right.conditionId) ||
		left.tokenId.localeCompare(right.tokenId) ||
		left.cohortId.localeCompare(right.cohortId)
	);
}

/**
 * Deterministic two-phase allocator, not a claimed optimizer:
 * 1. Reserve one legal floor for the highest target-weight candidates.
 * 2. Distribute confirmed remainder in proportion to each selected gap.
 */
export function allocatePositionGapLots(
	candidates: readonly PositionGapCandidateV1[],
	confirmedHeadroomUsdc: number,
	requestedMaxIntents: number,
): readonly PositionGapAllocatedLotV1[] {
	if (!Number.isFinite(confirmedHeadroomUsdc) || confirmedHeadroomUsdc <= 0) {
		return [];
	}
	const maxIntents = Math.min(
		POSITION_GAP_MAX_INTENTS_PER_PLAN,
		Math.max(0, Math.floor(requestedMaxIntents)),
	);
	if (maxIntents === 0) return [];

	let remaining = confirmedHeadroomUsdc;
	const selected: Array<{
		candidate: PositionGapCandidateV1;
		notionalUsdc: number;
	}> = [];
	for (const candidate of [...candidates].sort(candidateOrder)) {
		if (selected.length >= maxIntents) break;
		if (
			!Number.isFinite(candidate.floorNotionalUsdc) ||
			candidate.floorNotionalUsdc <= 0 ||
			candidate.floorNotionalUsdc > remaining + POSITION_GAP_EPSILON
		) {
			continue;
		}
		selected.push({
			candidate,
			notionalUsdc: candidate.floorNotionalUsdc,
		});
		remaining -= candidate.floorNotionalUsdc;
	}

	if (selected.length === 0 || remaining <= POSITION_GAP_EPSILON) {
		return selected.map(toAllocatedLot);
	}

	const capacities = selected.map(({ candidate, notionalUsdc }) =>
		Math.max(0, candidate.maxNotionalUsdc - notionalUsdc),
	);
	const totalCapacity = capacities.reduce((sum, value) => sum + value, 0);
	if (totalCapacity <= POSITION_GAP_EPSILON) {
		return selected.map(toAllocatedLot);
	}

	const distributable = Math.min(remaining, totalCapacity);
	for (let index = 0; index < selected.length; index += 1) {
		const entry = selected[index];
		const capacity = capacities[index];
		if (entry === undefined || capacity === undefined) continue;
		const proportional = (distributable * capacity) / totalCapacity;
		entry.notionalUsdc += Math.min(capacity, proportional);
	}

	return selected.map(toAllocatedLot);
}

function toAllocatedLot(entry: {
	candidate: PositionGapCandidateV1;
	notionalUsdc: number;
}): PositionGapAllocatedLotV1 {
	const notionalUsdc = Math.min(
		entry.notionalUsdc,
		entry.candidate.maxNotionalUsdc,
	);
	return {
		...entry.candidate,
		notionalUsdc,
		shares: notionalUsdc / entry.candidate.limitPrice,
	};
}

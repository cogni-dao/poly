// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { TargetBookSnapshotV1 } from "@cogni/poly-market-provider";

import type {
	NettedTargetBookV1,
	NettedTargetPositionV1,
	PositionGapVenueStatusV1,
} from "./model";
import { POSITION_GAP_EPSILON } from "./model";

/**
 * Remove cash-equivalent binary complete sets from a validated target book.
 * Event-level neg-risk inference is intentionally forbidden: each condition
 * is netted only against its explicit mutually-opposite tuple.
 */
export function netTargetBook(
	snapshot: TargetBookSnapshotV1,
	venueStatusByCondition: ReadonlyMap<string, PositionGapVenueStatusV1>,
): NettedTargetBookV1 {
	const positions: NettedTargetPositionV1[] = [];
	const closedConditionIds: string[] = [];
	const ineligibleTargetPositions: NettedTargetBookV1["ineligibleTargetPositions"][number][] =
		[];

	for (const condition of [...snapshot.conditions].sort((left, right) =>
		left.conditionId.localeCompare(right.conditionId),
	)) {
		if (venueStatusByCondition.get(condition.conditionId) === "closed") {
			closedConditionIds.push(condition.conditionId);
			continue;
		}

		const [left, right] = condition.tokens;
		const completeSetShares = Math.min(left.shares, right.shares);
		const grossCost =
			left.shares * left.averagePrice + right.shares * right.averagePrice;
		for (const token of [left, right].sort((a, b) =>
			a.tokenId.localeCompare(b.tokenId),
		)) {
			const netShares = token.shares - completeSetShares;
			if (netShares <= POSITION_GAP_EPSILON) continue;
			if (!Number.isFinite(token.markPrice) || token.markPrice <= 0) {
				ineligibleTargetPositions.push({
					conditionId: condition.conditionId,
					tokenId: token.tokenId,
					reason: "invalid_mark_price",
				});
				continue;
			}
			const netBreakEvenPrice = (grossCost - completeSetShares) / netShares;
			const finitePositiveBreakEven =
				Number.isFinite(netBreakEvenPrice) && netBreakEvenPrice > 0
					? netBreakEvenPrice
					: null;
			positions.push({
				conditionId: condition.conditionId,
				tokenId: token.tokenId,
				oppositeTokenId: token.oppositeTokenId,
				netShares,
				completeSetShares,
				markPrice: token.markPrice,
				averagePrice: token.averagePrice,
				netBreakEvenPrice: finitePositiveBreakEven,
				activationPriceCap:
					finitePositiveBreakEven === null
						? null
						: Math.min(token.averagePrice, finitePositiveBreakEven),
				negativeRisk: condition.negativeRisk,
			});
		}
	}

	positions.sort(
		(left, right) =>
			left.conditionId.localeCompare(right.conditionId) ||
			left.tokenId.localeCompare(right.tokenId),
	);
	const eligibleNetNavUsdc = positions.reduce(
		(sum, position) => sum + position.netShares * position.markPrice,
		0,
	);

	return {
		positions,
		eligibleNetNavUsdc,
		closedConditionIds,
		ineligibleTargetPositions,
	};
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/copy-trade/position-gap-cohorts`
 * Purpose: Derive durable quantity+price entitlement mutations before planning.
 * Scope: Pure cohort arithmetic. No database, provider, or execution IO.
 * Invariants: ALLOWANCE_NEVER_INCREASES_IN_PLACE, GROWTH_CREATES_A_COHORT,
 *   REDUCE_HIGHEST_PRICE_THEN_NEWEST, NO_DENOMINATOR_GROWTH,
 *   LINEAR_GROUPING (bug.5520: one pass per cohort, never tokens x cohorts),
 *   ORDER_EQUALS_LOCALE_COMPARE (cheap comparators only where provably
 *   identical to `String#localeCompare`; otherwise localeCompare itself).
 * Side-effects: none
 * Links: story.5015, task.1791070974, bug.5520
 * @public
 */

import { createHash } from "node:crypto";

const EPSILON = 1e-9;

export type PositionGapCohortSourceKind =
	| "activation"
	| "target_buy"
	| "config_increase";

export interface PositionGapCohortState {
	id: string;
	cohortKey: string;
	sourceKind: PositionGapCohortSourceKind;
	conditionId: string;
	tokenId: string;
	marketId: string;
	outcome: string;
	targetDeltaShares: number;
	scaleAtCreation: number;
	allowedMirrorShares: number;
	benchmarkTargetVwap: number;
	acquiredShares: number;
	openOrderShares: number;
	remainingShares: number;
	createdAtMs: number;
}

export interface PositionGapNetTargetPosition {
	conditionId: string;
	tokenId: string;
	marketId: string;
	outcome: string;
	netShares: number;
	/** Complete-set-netted economic cap from the pure book model. */
	activationPriceCap: number | null;
}

export interface PositionGapTargetActivity {
	fillId: string;
	side: "BUY" | "SELL";
	conditionId: string;
	tokenId: string;
	marketId: string;
	outcome: string;
	shares: number;
	price: number;
	observedAtMs: number;
}

export interface PositionGapCohortCreation {
	cohortKey: string;
	sourceKind: PositionGapCohortSourceKind;
	sourceEventId: string | null;
	sourceConfigRevision: string;
	conditionId: string;
	tokenId: string;
	marketId: string;
	outcome: string;
	targetDeltaShares: number;
	scaleAtCreation: number;
	allowedMirrorShares: number;
	benchmarkTargetVwap: number;
	remainingShares: number;
	createdAtMs: number;
	provenance: Record<string, unknown>;
}

export interface PositionGapCohortReduction {
	cohortId: string;
	cohortKey: string;
	previousAllowedMirrorShares: number;
	allowedMirrorShares: number;
	remainingShares: number;
	status: "reduced" | "over_target";
}

export interface PositionGapCohortProjection {
	creations: readonly PositionGapCohortCreation[];
	reductions: readonly PositionGapCohortReduction[];
	cohorts: readonly PositionGapCohortState[];
}

export interface ProjectPositionGapCohortsInput {
	existing: readonly PositionGapCohortState[];
	netTargetPositions: readonly PositionGapNetTargetPosition[];
	activity: readonly PositionGapTargetActivity[];
	snapshotId: string;
	snapshotHash: string;
	configRevision: string;
	previousBudgetUsdc: number | null;
	budgetUsdc: number;
	allocationDenominatorUsdc: number;
	scale: number;
	activation: boolean;
	nowMs: number;
}

type StringComparator = (left: string, right: string) => number;

const compareLocale: StringComparator = (left, right) =>
	left.localeCompare(right);

const compareCodeUnits: StringComparator = (left, right) =>
	left < right ? -1 : left > right ? 1 : 0;

/**
 * Strings drawn only from [0-9a-z] (lowercase hex addresses, sha256 keys,
 * decimal token ids, `0x` prefixes). In CLDR root/en collation these 36
 * characters each carry a distinct primary weight ordered exactly like their
 * UTF-16 code units, with no ignorables, contractions, or expansions — so the
 * first differing character decides, a strict prefix sorts first, and only
 * identical strings compare 0, in both orders. Anything else (uppercase,
 * punctuation such as `:` or `-`, non-ASCII) keeps localeCompare.
 */
const CODE_UNIT_SAFE = /^[0-9a-z]*$/;

/**
 * Guard against a runtime default locale that tailors this alphabet
 * (e.g. da "aa" after "z", lt "y" after "i", et "z" after "s", cs "ch").
 */
const LOCALE_MATCHES_CODE_UNITS = (() => {
	const probe = [
		..."0123456789abcdefghijklmnopqrstuvwxyz",
		"aa",
		"ab",
		"ch",
		"ci",
		"ll",
		"lm",
		"zz",
		"0x",
		"0x0",
		"10",
		"9",
	];
	const byLocale = [...probe].sort(compareLocale);
	const byCodeUnit = [...probe].sort(compareCodeUnits);
	return byLocale.every((value, index) => value === byCodeUnit[index]);
})();

/** Exact localeCompare order, via code-unit comparison when provably equal. */
function comparatorFor(values: Iterable<string>): StringComparator {
	if (!LOCALE_MATCHES_CODE_UNITS) return compareLocale;
	for (const value of values) {
		if (!CODE_UNIT_SAFE.test(value)) return compareLocale;
	}
	return compareCodeUnits;
}

function stableKey(parts: readonly string[]): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function assertFiniteNonnegative(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(
			`position-gap cohort ${name} must be finite and nonnegative`,
		);
	}
}

function creationFromPosition(params: {
	position: PositionGapNetTargetPosition;
	sourceKind: PositionGapCohortSourceKind;
	sourceIdentity: string;
	sourceEventId: string | null;
	configRevision: string;
	targetDeltaShares: number;
	scale: number;
	createdAtMs: number;
	snapshotId: string;
	snapshotHash: string;
	benchmarkTargetVwap?: number;
}): PositionGapCohortCreation | null {
	const allowedMirrorShares = params.targetDeltaShares * params.scale;
	const benchmarkTargetVwap =
		params.benchmarkTargetVwap ?? params.position.activationPriceCap;
	if (
		allowedMirrorShares <= EPSILON ||
		benchmarkTargetVwap === null ||
		!Number.isFinite(benchmarkTargetVwap) ||
		benchmarkTargetVwap <= 0 ||
		benchmarkTargetVwap >= 1
	) {
		return null;
	}
	const cohortKey = stableKey([
		"position-gap-v3",
		params.sourceKind,
		params.sourceIdentity,
		params.position.conditionId,
		params.position.tokenId,
	]);
	return {
		cohortKey,
		sourceKind: params.sourceKind,
		sourceEventId: params.sourceEventId,
		sourceConfigRevision: params.configRevision,
		conditionId: params.position.conditionId,
		tokenId: params.position.tokenId,
		marketId: params.position.marketId,
		outcome: params.position.outcome,
		targetDeltaShares: params.targetDeltaShares,
		scaleAtCreation: params.scale,
		allowedMirrorShares,
		benchmarkTargetVwap,
		remainingShares: allowedMirrorShares,
		createdAtMs: params.createdAtMs,
		provenance: {
			snapshot_id: params.snapshotId,
			snapshot_hash: params.snapshotHash,
			source_identity: params.sourceIdentity,
			target_delta_shares: params.targetDeltaShares,
			scale_at_creation: params.scale,
			benchmark_target_vwap: benchmarkTargetVwap,
			created_at_ms: params.createdAtMs,
		},
	};
}

/**
 * Project cohort state for the pure planner. Existing rows only shrink;
 * activation, observed target BUYs, and explicit budget growth create rows.
 * Callers project activation on every complete snapshot: the deterministic
 * config-revision key, retained even for resolved rows, is the exact-once
 * identity for positions that appear after the first snapshot.
 */
export function projectPositionGapCohorts(
	input: ProjectPositionGapCohortsInput,
): PositionGapCohortProjection {
	assertFiniteNonnegative(input.budgetUsdc, "budget");
	assertFiniteNonnegative(
		input.allocationDenominatorUsdc,
		"allocation denominator",
	);
	assertFiniteNonnegative(input.scale, "scale");

	const existingKeys = new Set(
		input.existing.map((cohort) => cohort.cohortKey),
	);
	const positionByToken = new Map(
		input.netTargetPositions.map((position) => [position.tokenId, position]),
	);
	const creations: PositionGapCohortCreation[] = [];

	const addCreation = (creation: PositionGapCohortCreation | null): void => {
		if (!creation || existingKeys.has(creation.cohortKey)) return;
		existingKeys.add(creation.cohortKey);
		creations.push(creation);
	};

	if (input.activation) {
		for (const position of input.netTargetPositions) {
			addCreation(
				creationFromPosition({
					position,
					sourceKind: "activation",
					sourceIdentity: input.configRevision,
					sourceEventId: null,
					configRevision: input.configRevision,
					targetDeltaShares: position.netShares,
					scale: input.scale,
					createdAtMs: input.nowMs,
					snapshotId: input.snapshotId,
					snapshotHash: input.snapshotHash,
				}),
			);
		}
	}

	if (
		input.previousBudgetUsdc !== null &&
		input.budgetUsdc > input.previousBudgetUsdc + EPSILON &&
		input.allocationDenominatorUsdc > EPSILON
	) {
		const addedScale =
			(input.budgetUsdc - input.previousBudgetUsdc) /
			input.allocationDenominatorUsdc;
		for (const position of input.netTargetPositions) {
			addCreation(
				creationFromPosition({
					position,
					sourceKind: "config_increase",
					sourceIdentity: input.configRevision,
					sourceEventId: null,
					configRevision: input.configRevision,
					targetDeltaShares: position.netShares,
					scale: addedScale,
					createdAtMs: input.nowMs,
					snapshotId: input.snapshotId,
					snapshotHash: input.snapshotHash,
				}),
			);
		}
	}

	const compareFillId = comparatorFor(
		input.activity.map((event) => event.fillId),
	);
	for (const event of [...input.activity].sort(
		(left, right) =>
			left.observedAtMs - right.observedAtMs ||
			compareFillId(left.fillId, right.fillId),
	)) {
		if (event.side !== "BUY") continue;
		const position = positionByToken.get(event.tokenId);
		if (!position) continue;
		const targetDeltaShares = Math.min(event.shares, position.netShares);
		addCreation(
			creationFromPosition({
				position: {
					...position,
					marketId: event.marketId,
					outcome: event.outcome,
				},
				sourceKind: "target_buy",
				sourceIdentity: event.fillId,
				sourceEventId: event.fillId,
				configRevision: input.configRevision,
				targetDeltaShares,
				scale: input.scale,
				createdAtMs: event.observedAtMs,
				snapshotId: input.snapshotId,
				snapshotHash: input.snapshotHash,
				benchmarkTargetVwap: event.price,
			}),
		);
	}

	const projected: PositionGapCohortState[] = [
		...input.existing.map((cohort) => ({ ...cohort })),
		...creations.map((creation) => ({
			id: creation.cohortKey,
			cohortKey: creation.cohortKey,
			sourceKind: creation.sourceKind,
			conditionId: creation.conditionId,
			tokenId: creation.tokenId,
			marketId: creation.marketId,
			outcome: creation.outcome,
			targetDeltaShares: creation.targetDeltaShares,
			scaleAtCreation: creation.scaleAtCreation,
			allowedMirrorShares: creation.allowedMirrorShares,
			benchmarkTargetVwap: creation.benchmarkTargetVwap,
			acquiredShares: 0,
			openOrderShares: 0,
			remainingShares: creation.remainingShares,
			createdAtMs: creation.createdAtMs,
		})),
	];

	// Group in one pass. Map insertion order = first appearance in `projected`,
	// and each group keeps `projected` order, matching the former per-token
	// `filter`; the stable sort below therefore sees identical input.
	const cohortsByToken = new Map<string, PositionGapCohortState[]>();
	for (const cohort of projected) {
		const group = cohortsByToken.get(cohort.tokenId);
		if (group) group.push(cohort);
		else cohortsByToken.set(cohort.tokenId, [cohort]);
	}
	const compareCohortKey = comparatorFor(
		projected.map((cohort) => cohort.cohortKey),
	);

	const reductions: PositionGapCohortReduction[] = [];
	for (const [tokenId, tokenCohorts] of cohortsByToken) {
		const desiredMaximum =
			(positionByToken.get(tokenId)?.netShares ?? 0) * input.scale;
		let excess = Math.max(
			0,
			tokenCohorts.reduce(
				(sum, cohort) => sum + cohort.allowedMirrorShares,
				0,
			) - desiredMaximum,
		);
		for (const cohort of tokenCohorts.sort(
			(left, right) =>
				right.benchmarkTargetVwap - left.benchmarkTargetVwap ||
				right.createdAtMs - left.createdAtMs ||
				compareCohortKey(right.cohortKey, left.cohortKey),
		)) {
			if (excess <= EPSILON) break;
			const reducible = Math.max(
				0,
				cohort.allowedMirrorShares - cohort.acquiredShares,
			);
			const reduction = Math.min(excess, reducible);
			if (reduction <= EPSILON) continue;
			cohort.allowedMirrorShares -= reduction;
			cohort.remainingShares = Math.min(
				cohort.remainingShares,
				Math.max(
					0,
					cohort.allowedMirrorShares -
						cohort.acquiredShares -
						cohort.openOrderShares,
				),
			);
			const status =
				cohort.acquiredShares + cohort.openOrderShares >
				cohort.allowedMirrorShares + EPSILON
					? "over_target"
					: "reduced";
			reductions.push({
				cohortId: cohort.id,
				cohortKey: cohort.cohortKey,
				previousAllowedMirrorShares: cohort.allowedMirrorShares + reduction,
				allowedMirrorShares: cohort.allowedMirrorShares,
				remainingShares: cohort.remainingShares,
				status,
			});
			excess -= reduction;
		}
	}

	const compareConditionId = comparatorFor(
		projected.map((cohort) => cohort.conditionId),
	);
	const compareTokenId = comparatorFor(cohortsByToken.keys());
	return {
		creations,
		reductions,
		cohorts: projected.sort(
			(left, right) =>
				compareConditionId(left.conditionId, right.conditionId) ||
				compareTokenId(left.tokenId, right.tokenId) ||
				left.createdAtMs - right.createdAtMs ||
				compareCohortKey(left.cohortKey, right.cohortKey),
		),
	};
}

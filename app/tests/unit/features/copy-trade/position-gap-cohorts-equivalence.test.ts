// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/copy-trade/position-gap-cohorts-equivalence`
 * Purpose: Prove the bug.5520 projection rewrite (Map grouping + code-unit
 *   comparators) is output-identical to the pre-change implementation, and
 *   record its runtime on a production-shaped fixture.
 * Scope: Pure. The pre-change implementation is pinned verbatim below as the
 *   reference; do not "fix" it — it is the oracle.
 * Invariants: OUTPUT_IDENTICAL (deep strict equality, including order and
 *   floating-point values) on realistic and adversarial randomized fixtures.
 * Side-effects: console timing output only
 * Links: bug.5520, src/features/copy-trade/position-gap-cohorts.ts
 * @internal
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	type PositionGapCohortProjection,
	type PositionGapCohortState,
	type PositionGapNetTargetPosition,
	type PositionGapTargetActivity,
	type ProjectPositionGapCohortsInput,
	projectPositionGapCohorts,
} from "@/features/copy-trade/position-gap-cohorts";

// ---------------------------------------------------------------------------
// Reference: position-gap-cohorts.ts @ poly 2432b118, verbatim (renamed).
// ---------------------------------------------------------------------------

type PositionGapCohortCreation = PositionGapCohortProjection["creations"][number];
type PositionGapCohortReduction =
	PositionGapCohortProjection["reductions"][number];
type PositionGapCohortSourceKind = PositionGapCohortState["sourceKind"];

const EPSILON = 1e-9;
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

function referenceProjectPositionGapCohorts(
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

	for (const event of [...input.activity].sort(
		(left, right) =>
			left.observedAtMs - right.observedAtMs ||
			left.fillId.localeCompare(right.fillId),
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

	const reductions: PositionGapCohortReduction[] = [];
	for (const tokenId of new Set(projected.map((cohort) => cohort.tokenId))) {
		const tokenCohorts = projected.filter(
			(cohort) => cohort.tokenId === tokenId,
		);
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
				right.cohortKey.localeCompare(left.cohortKey),
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

	return {
		creations,
		reductions,
		cohorts: projected.sort(
			(left, right) =>
				left.conditionId.localeCompare(right.conditionId) ||
				left.tokenId.localeCompare(right.tokenId) ||
				left.createdAtMs - right.createdAtMs ||
				left.cohortKey.localeCompare(right.cohortKey),
		),
	};
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type IdStyle = "production" | "adversarial";

interface FixtureShape {
	seed: number;
	conditions: number;
	cohorts: number;
	activity: number;
	style: IdStyle;
}

function makeFixture(shape: FixtureShape): ProjectPositionGapCohortsInput {
	const rand = mulberry32(shape.seed);
	const pick = <T>(values: readonly T[]): T =>
		values[Math.floor(rand() * values.length)] as T;
	const hex = (length: number): string => {
		let out = "";
		for (let index = 0; index < length; index += 1) {
			out += "0123456789abcdef"[Math.floor(rand() * 16)];
		}
		return out;
	};
	const decimal = (): string => {
		// Polymarket ERC-1155 token ids: up to 78 decimal digits, variable length.
		let out = String(1 + Math.floor(rand() * 9));
		const length = 60 + Math.floor(rand() * 18);
		for (let index = 0; index < length; index += 1) {
			out += String(Math.floor(rand() * 10));
		}
		return out;
	};
	// Adversarial ids exercise the localeCompare fallback: mixed case, punctuation,
	// accents, and digit runs where locale and code-unit order disagree.
	const weird = (): string =>
		pick(["Cond", "cond", "COND", "c-o", "c_o", "c:o", "é", "e", "Z", "a"]) +
		pick(["", "-", ":", "_", " ", "."]) +
		pick(["10", "9", "x", "X", "ab", "AB", "aa", "ä", ""]);
	const conditionId = (): string =>
		shape.style === "production" ? `0x${hex(64)}` : weird();
	const tokenId = (): string =>
		shape.style === "production" ? decimal() : weird() + weird();
	const cohortKey = (): string =>
		shape.style === "production" ? hex(64) : weird() + weird() + weird();
	const fillId = (): string =>
		shape.style === "production"
			? `data-api:0x${hex(64)}:${Math.floor(rand() * 1_000)}`
			: weird() + weird();

	const tokens: Array<{
		conditionId: string;
		tokenId: string;
		marketId: string;
		outcome: string;
	}> = [];
	for (let index = 0; index < shape.conditions; index += 1) {
		const condition = conditionId();
		for (const outcome of ["YES", "NO"]) {
			tokens.push({
				conditionId: condition,
				tokenId: tokenId(),
				marketId: `prediction-market:polymarket:${condition}`,
				outcome,
			});
		}
	}

	// Coarse price + time grids force comparator ties down to the key level.
	const prices = [0.1, 0.25, 0.4, 0.4, 0.55, 0.7, 0.9];
	const times = [1_000, 2_000, 2_000, 3_000, 4_000];

	const netTargetPositions: PositionGapNetTargetPosition[] = tokens
		.filter(() => rand() < 0.75)
		.map((token) => ({
			...token,
			netShares: Math.floor(rand() * 500) + rand(),
			activationPriceCap: rand() < 0.1 ? null : pick(prices),
		}));

	const existing: PositionGapCohortState[] = [];
	for (let index = 0; index < shape.cohorts; index += 1) {
		const token = pick(tokens);
		const allowedMirrorShares = rand() * 60;
		const acquiredShares = rand() < 0.4 ? rand() * allowedMirrorShares : 0;
		const openOrderShares =
			rand() < 0.3 ? rand() * (allowedMirrorShares - acquiredShares) : 0;
		const key = cohortKey();
		existing.push({
			id: `${index}`,
			cohortKey: key,
			sourceKind: pick(["activation", "target_buy", "config_increase"]),
			...token,
			targetDeltaShares: rand() * 500,
			scaleAtCreation: 0.1,
			allowedMirrorShares,
			benchmarkTargetVwap: pick(prices),
			acquiredShares,
			openOrderShares,
			remainingShares: Math.max(
				0,
				allowedMirrorShares - acquiredShares - openOrderShares,
			),
			createdAtMs: pick(times),
		});
	}

	const activity: PositionGapTargetActivity[] = [];
	for (let index = 0; index < shape.activity; index += 1) {
		const token = pick(tokens);
		activity.push({
			fillId: fillId(),
			side: rand() < 0.7 ? "BUY" : "SELL",
			...token,
			shares: rand() * 300,
			price: pick(prices),
			observedAtMs: pick(times),
		});
	}

	return {
		existing,
		netTargetPositions,
		activity,
		snapshotId: `snapshot-${shape.seed}`,
		snapshotHash: `hash-${shape.seed}`,
		configRevision: `revision-${shape.seed % 3}`,
		previousBudgetUsdc: rand() < 0.5 ? null : 30,
		budgetUsdc: 40,
		allocationDenominatorUsdc: 400,
		scale: pick([0.01, 0.05, 0.1, 0.2]),
		activation: rand() < 0.8,
		nowMs: 5_000,
	};
}

// ---------------------------------------------------------------------------
// Equivalence
// ---------------------------------------------------------------------------

describe("projectPositionGapCohorts equivalence with the pre-bug.5520 reference", () => {
	it("returns deep-equal output on 200 randomized production-shaped fixtures", () => {
		let reductions = 0;
		for (let seed = 1; seed <= 200; seed += 1) {
			const input = makeFixture({
				seed,
				conditions: 1 + (seed % 25),
				cohorts: seed % 400,
				activity: seed % 40,
				style: "production",
			});
			const expected = referenceProjectPositionGapCohorts(input);
			reductions += expected.reductions.length;
			expect(projectPositionGapCohorts(input)).toStrictEqual(expected);
		}
		// Guard against a vacuous fixture: the reduction path must be exercised.
		expect(reductions).toBeGreaterThan(1_000);
	});

	it("returns deep-equal output on 200 adversarial-id fixtures (localeCompare fallback)", () => {
		for (let seed = 1_001; seed <= 1_200; seed += 1) {
			const input = makeFixture({
				seed,
				conditions: 1 + (seed % 25),
				cohorts: seed % 300,
				activity: seed % 40,
				style: "adversarial",
			});
			expect(projectPositionGapCohorts(input)).toStrictEqual(
				referenceProjectPositionGapCohorts(input),
			);
		}
	});

	it("does not mutate its input", () => {
		const input = makeFixture({
			seed: 7,
			conditions: 20,
			cohorts: 300,
			activity: 30,
			style: "production",
		});
		const before = structuredClone(input);
		projectPositionGapCohorts(input);
		expect(input).toStrictEqual(before);
	});
});

// ---------------------------------------------------------------------------
// Benchmark (bug.5520): 20k cohorts across 2k tokens, the order of magnitude
// the unbounded loadCohorts returns for a long-lived prod target.
// ---------------------------------------------------------------------------

function medianMs(run: () => unknown, iterations: number): number {
	run(); // warm-up
	const samples: number[] = [];
	for (let index = 0; index < iterations; index += 1) {
		const started = performance.now();
		run();
		samples.push(performance.now() - started);
	}
	samples.sort((left, right) => left - right);
	return samples[Math.floor(samples.length / 2)] as number;
}

describe("projectPositionGapCohorts benchmark (bug.5520)", () => {
	it("projects 20k cohorts across 2k tokens faster than the reference, with identical output", () => {
		const input = makeFixture({
			seed: 5_520,
			conditions: 1_000,
			cohorts: 20_000,
			activity: 500,
			style: "production",
		});
		const expected = referenceProjectPositionGapCohorts(input);
		expect(projectPositionGapCohorts(input)).toStrictEqual(expected);

		const referenceMs = medianMs(
			() => referenceProjectPositionGapCohorts(input),
			5,
		);
		const currentMs = medianMs(() => projectPositionGapCohorts(input), 5);
		console.info(
			`[bug.5520 bench] cohorts=${input.existing.length} tokens=2000 ` +
				`creations=${expected.creations.length} reductions=${expected.reductions.length} ` +
				`reference_median_ms=${referenceMs.toFixed(1)} current_median_ms=${currentMs.toFixed(1)} ` +
				`speedup=${(referenceMs / currentMs).toFixed(1)}x`,
		);
		expect(currentMs).toBeLessThan(referenceMs);
	});
});

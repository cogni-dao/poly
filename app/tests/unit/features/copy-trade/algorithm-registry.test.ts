// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { readFileSync } from "node:fs";
import type { Fill, TargetBookSnapshotV1 } from "@cogni/poly-market-provider";
import { describe, expect, it } from "vitest";

import {
	ALGORITHM_DEFINITIONS,
	evaluateAlgorithm,
	fillAlgorithmConfig,
	POLY_ALGORITHM_IDS,
	type PolyAlgorithmId,
} from "@/features/copy-trade/algorithm-registry";
import type { PositionGapBookInputV1 } from "@/features/copy-trade/position-gap-v3/model";

const TARGET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const CLIENT_ORDER_ID = `0x${"1".repeat(64)}`;
const IMPLEMENTATION_REVISION = "0123456789abcdef0123456789abcdef01234567";
const NOW = Date.parse("2026-10-08T02:30:00.000Z");

const fill: Fill = {
	target_wallet: TARGET,
	fill_id: "chain:algorithm-contract",
	source: "chain",
	market_id: "prediction-market:polymarket:condition-1",
	outcome: "YES",
	side: "BUY",
	price: 0.5,
	size_usdc: 4,
	observed_at: "2026-10-08T02:29:59.000Z",
	attributes: {
		asset: "condition-1-yes",
		title: "Runtime-owned title",
	},
};

const statistic = {
	wallet: TARGET,
	label: "contract fixture",
	captured_at: "2026-10-08T00:00:00.000Z",
	sample_size: 10,
	min_target_usdc: 1,
	max_target_usdc: 100,
	percentile: 75,
};

function fillInput() {
	return {
		fill,
		state: { already_placed_ids: [], placed_fill_ids: [] },
		min_shares: 1,
		min_usdc_notional: 1,
		tick_size: 0.01,
		now_ms: NOW,
	};
}

function fillConfig(id: PolyAlgorithmId) {
	const sizing =
		id === "poly.copy-mirror.min-bet"
			? { kind: "min_bet" as const, max_usdc_per_condition: 10 }
			: id === "poly.copy-mirror.target-percentile"
				? {
						kind: "target_percentile" as const,
						max_usdc_per_condition: 10,
						statistic,
					}
				: id === "poly.copy-mirror.target-percentile-scaled"
					? {
							kind: "target_percentile_scaled" as const,
							max_usdc_per_condition: 10,
							statistic,
						}
					: { kind: "mirror_fill_exact" as const };
	return { sizing };
}

function targetBook(): TargetBookSnapshotV1 {
	return {
		version: 1,
		snapshotId: "snapshot-1",
		targetWallet: TARGET,
		fullRefreshAtMs: NOW - 1_000,
		updatedAtMs: NOW - 500,
		expiresAtMs: NOW + 30_000,
		complete: true,
		refreshStats: {
			kind: "full",
			discoveryRows: 2,
			conditionCount: 1,
			dataApiCalls: 2,
			sourceComputedAt: "2026-10-08T02:29:59.000Z",
			sourceMaxSyncedBlock: 95_148_252,
		},
		conditions: [
			{
				conditionId: "condition-1",
				status: "OPEN",
				redeemable: false,
				endDate: null,
				negativeRisk: false,
				tokens: [
					{
						tokenId: "condition-1-yes",
						oppositeTokenId: "condition-1-no",
						outcomeIndex: 0,
						shares: 10,
						markPrice: 0.5,
						averagePrice: 0.5,
					},
					{
						tokenId: "condition-1-no",
						oppositeTokenId: "condition-1-yes",
						outcomeIndex: 1,
						shares: 0,
						markPrice: 0.5,
						averagePrice: 0.5,
					},
				],
			},
		],
	};
}

function positionGapInput(): PositionGapBookInputV1 {
	const snapshot = targetBook();
	return {
		nowMs: NOW,
		snapshot,
		sleeveBudgetUsdc: 10,
		targetCashPusdUsdc: 0,
		targetCashUsdcEUsdc: 0,
		targetCashObservedBlock: snapshot.refreshStats.sourceMaxSyncedBlock,
		actualWalletCashUsdc: 10,
		confirmedBuyNotionalCashHeadroomUsdc: 10,
		confirmedSleeveHeadroomUsdc: 10,
		confirmedStrategyCapHeadroomUsdc: 10,
		confirmedAccountCapHeadroomUsdc: 10,
		confirmedPerOrderCapUsdc: 2,
		confirmedRemainingIntentCount: 8,
		maxIntents: 8,
		venues: [
			{
				conditionId: "condition-1",
				status: "accepting_orders",
				quotes: [
					{
						tokenId: "condition-1-yes",
						bestAsk: 0.5,
						tickSize: 0.01,
						minOrderShares: 1,
						minOrderUsdc: 1,
					},
				],
			},
		],
		cohorts: [
			{
				cohortId: "activation:condition-1-yes",
				conditionId: "condition-1",
				tokenId: "condition-1-yes",
				kind: "activation",
				allowedMirrorShares: 10,
				acquiredMirrorShares: 0,
				availableNewBuyShares: 10,
				targetVwap: 0.5,
			},
		],
		holdings: [],
		openBuyOrders: [],
		unmanagedBuyExposure: [],
	};
}

function evaluate(id: PolyAlgorithmId) {
	return evaluateAlgorithm({
		definition: ALGORITHM_DEFINITIONS[id],
		input:
			id === "poly.copy-mirror.position-gap" ? positionGapInput() : fillInput(),
		config:
			id === "poly.copy-mirror.position-gap"
				? { config_revision: "fixture-v1", configured_budget_usdc: 10 }
				: fillConfig(id),
		implementationRevision: IMPLEMENTATION_REVISION,
		assignmentId: "assignment-1",
		correlationId: CLIENT_ORDER_ID,
	});
}

function allKeys(value: unknown): string[] {
	if (!value || typeof value !== "object") return [];
	if (Array.isArray(value)) return value.flatMap(allKeys);
	return Object.entries(value as Record<string, unknown>).flatMap(
		([key, nested]) => [key, ...allKeys(nested)],
	);
}

describe("Poly AlgorithmDefinition conformance", () => {
	it("is the only runtime module that imports family planners", () => {
		const registry = readFileSync(
			new URL(
				"../../../../src/features/copy-trade/algorithm-registry.ts",
				import.meta.url,
			),
			"utf8",
		);
		const pipeline = readFileSync(
			new URL(
				"../../../../src/features/copy-trade/mirror-pipeline.ts",
				import.meta.url,
			),
			"utf8",
		);
		const actor = readFileSync(
			new URL(
				"../../../../src/features/copy-trade/position-gap-actor.ts",
				import.meta.url,
			),
			"utf8",
		);

		expect(registry).toContain('from "./plan-mirror"');
		expect(registry).toContain('from "./position-gap-v3/batch-plan"');
		expect(pipeline).not.toMatch(
			/import\s*\{[^}]*\bplanMirrorFromFill\b[^}]*\}\s*from/s,
		);
		expect(actor).not.toMatch(/from ["'].*position-gap-v3\/batch-plan["']/);
		expect(registry).not.toMatch(
			/from ["'](?:@\/)?(?:adapters|bootstrap|app|features\/trading)/,
		);
		expect(registry).not.toMatch(
			/\b(?:fetch|process\.env|Date\.now|Math\.random)\s*\(/,
		);
	});

	it("registers exactly the five current families once", () => {
		expect(Object.keys(ALGORITHM_DEFINITIONS).sort()).toEqual(
			[...POLY_ALGORITHM_IDS].sort(),
		);
		expect(Object.isFrozen(ALGORITHM_DEFINITIONS)).toBe(true);
		for (const definition of Object.values(ALGORITHM_DEFINITIONS)) {
			expect(Object.isFrozen(definition)).toBe(true);
		}
	});

	it.each(POLY_ALGORITHM_IDS)(
		"is deterministic for identical %s facts and config",
		(id) => {
			expect(evaluate(id)).toEqual(evaluate(id));
		},
	);

	it("fails a structurally incomplete position-gap snapshot closed without throwing", () => {
		const result = evaluateAlgorithm({
			definition: ALGORITHM_DEFINITIONS["poly.copy-mirror.position-gap"],
			input: {
				nowMs: NOW,
				snapshot: { complete: true },
				venues: [],
				cohorts: [],
				holdings: [],
				openBuyOrders: [],
				unmanagedBuyExposure: [],
			},
			config: { config_revision: "fixture-v1", configured_budget_usdc: 10 },
			implementationRevision: IMPLEMENTATION_REVISION,
			assignmentId: "assignment-1",
			correlationId: CLIENT_ORDER_ID,
		});
		expect(result.decision).toEqual({
			status: "blocked",
			reason: "invalid_input",
			orders: [],
			cancellations: [],
			diagnostics: {},
		});
	});

	it.each(
		POLY_ALGORITHM_IDS.filter((id) => id !== "poly.copy-mirror.position-gap"),
	)("owns %s SELL economics without emitting venue or attempt fields", (id) => {
		const result = evaluateAlgorithm({
			definition: ALGORITHM_DEFINITIONS[id],
			input: {
				...fillInput(),
				fill: { ...fill, side: "SELL" },
				sell_position_shares: 10,
			},
			config: fillConfig(id),
			implementationRevision: IMPLEMENTATION_REVISION,
			assignmentId: "assignment-1",
			correlationId: CLIENT_ORDER_ID,
		});
		expect(result.decision).toMatchObject({
			status: "ready",
			reason: "sell_closed_position",
			orders: [{ side: "SELL", position_branch: "sell_close" }],
		});
		expect(allKeys(result.decision)).not.toEqual(
			expect.arrayContaining(["provider", "placement", "client_order_id"]),
		);
	});

	it.each(POLY_ALGORITHM_IDS)(
		"fails %s closed before planning invalid facts",
		(id) => {
			const result = evaluateAlgorithm({
				definition: ALGORITHM_DEFINITIONS[id],
				input: {},
				config:
					id === "poly.copy-mirror.position-gap"
						? { config_revision: "fixture-v1", configured_budget_usdc: 10 }
						: fillConfig(id),
				implementationRevision: IMPLEMENTATION_REVISION,
				assignmentId: "assignment-1",
				correlationId: CLIENT_ORDER_ID,
			});
			expect(result.decision).toMatchObject({
				status: "blocked",
				reason: "invalid_input",
				orders: [],
				cancellations: [],
			});
		},
	);

	it.each(POLY_ALGORITHM_IDS)(
		"keeps %s decisions free of runtime and presentation I/O",
		(id) => {
			const keys = allKeys(evaluate(id).decision);
			for (const forbidden of [
				"provider",
				"placement",
				"order_type",
				"client_order_id",
				"market_title",
				"market_slug",
				"event_title",
				"transaction_hash",
			]) {
				expect(keys).not.toContain(forbidden);
			}
		},
	);

	it("binds the exact config hash into immutable version identity", () => {
		const definition = ALGORITHM_DEFINITIONS["poly.copy-mirror.min-bet"];
		const base = evaluateAlgorithm({
			definition,
			input: fillInput(),
			config: fillConfig("poly.copy-mirror.min-bet"),
			implementationRevision: IMPLEMENTATION_REVISION,
			assignmentId: "assignment-1",
			correlationId: CLIENT_ORDER_ID,
		});
		const changed = evaluateAlgorithm({
			definition,
			input: fillInput(),
			config: {
				...fillConfig("poly.copy-mirror.min-bet"),
				sizing: { kind: "min_bet", max_usdc_per_condition: 20 },
			},
			implementationRevision: IMPLEMENTATION_REVISION,
			assignmentId: "assignment-1",
			correlationId: CLIENT_ORDER_ID,
		});
		expect(changed.lineage.config_hash).not.toBe(base.lineage.config_hash);
		expect(changed.lineage.algorithm_version_id).not.toBe(
			base.lineage.algorithm_version_id,
		);
		expect(changed.lineage.input_snapshot_id).toBe(
			base.lineage.input_snapshot_id,
		);
	});

	it("binds the exact implementation revision into version identity only", () => {
		const base = evaluate("poly.copy-mirror.min-bet");
		const changed = evaluateAlgorithm({
			definition: ALGORITHM_DEFINITIONS["poly.copy-mirror.min-bet"],
			input: fillInput(),
			config: fillConfig("poly.copy-mirror.min-bet"),
			implementationRevision: "fedcba9876543210fedcba9876543210fedcba98",
			assignmentId: "assignment-1",
			correlationId: CLIENT_ORDER_ID,
		});
		expect(changed.lineage.algorithm_version_id).not.toBe(
			base.lineage.algorithm_version_id,
		);
		expect(changed.lineage.config_hash).toBe(base.lineage.config_hash);
		expect(changed.lineage.input_snapshot_id).toBe(
			base.lineage.input_snapshot_id,
		);
	});

	it("excludes venue placement from algorithm config identity", () => {
		const base = {
			target_id: "11111111-1111-4111-8111-111111111111",
			target_wallet: TARGET,
			billing_account_id: "billing-1",
			created_by_user_id: "user-1",
			sizing: { kind: "min_bet" as const, max_usdc_per_condition: 10 },
		};
		expect(
			fillAlgorithmConfig({
				...base,
				placement: { kind: "mirror_limit" },
			}),
		).toEqual(
			fillAlgorithmConfig({
				...base,
				placement: { kind: "market_fok" },
			}),
		);
	});

	it("fails closed when a family is paired with another family's config", () => {
		const result = evaluateAlgorithm({
			definition: ALGORITHM_DEFINITIONS["poly.copy-mirror.min-bet"],
			input: fillInput(),
			config: { sizing: { kind: "mirror_fill_exact" } },
			implementationRevision: IMPLEMENTATION_REVISION,
			assignmentId: "assignment-1",
			correlationId: CLIENT_ORDER_ID,
		});
		expect(result.decision).toMatchObject({
			status: "blocked",
			reason: "invalid_input",
			orders: [],
		});
	});
});

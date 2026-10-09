// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/copy-trade/algorithm-registry`
 * Purpose: The only runtime planner seam for Poly copy-trading algorithms.
 * Scope: Pure validation, deterministic hashing, and decision projection. No
 *   DB, network, clock, environment, logging, auth, ledger, or venue calls.
 * Invariants:
 *   - ALGORITHM_DEFINED_ONCE — every supported family is registered here.
 *   - VERSION_BINDS_BEHAVIOR — algorithm version identity binds code,
 *     input-contract, config-schema, and the exact validated config hash.
 *   - SAME_INPUT_SAME_OUTPUT — evaluation is deterministic and side-effect free.
 *   - VENUE_BLIND_DECISION — output names economic actions only. Provider,
 *     order type, signing, submission, persistence, and presentation belong to
 *     the shared runtime.
 *   - INVALID_FACTS_FAIL_CLOSED — invalid inputs return a blocked decision and
 *     never reach a planner.
 * Side-effects: none.
 * Links: story.5019, https://poly.cognidao.org/knowledge/poly-algorithm-contract
 * @public
 */

import { createHash } from "node:crypto";
import { type Fill, FillSchema } from "@cogni/poly-market-provider";
import { z } from "zod";

import { planMirrorFromFill } from "./plan-mirror";
import { planPositionGapBook } from "./position-gap-v3/batch-plan";
import type {
	PositionGapBookInputV1,
	PositionGapBookPlanV1,
} from "./position-gap-v3/model";
import {
	type MirrorTargetConfig,
	MirrorTargetConfigSchema,
	type PlanMirrorInput,
	RuntimeStateSchema,
} from "./types";

export const POLY_ALGORITHM_IDS = [
	"poly.copy-mirror.min-bet",
	"poly.copy-mirror.target-percentile",
	"poly.copy-mirror.target-percentile-scaled",
	"poly.copy-mirror.fill-exact",
	"poly.copy-mirror.position-gap",
] as const;

export type PolyAlgorithmId = (typeof POLY_ALGORITHM_IDS)[number];

export const AlgorithmLineageSchema = z
	.object({
		algorithm_id: z.enum(POLY_ALGORITHM_IDS),
		algorithm_version_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		config_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		input_snapshot_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		assignment_id: z.string().min(1),
		correlation_id: z.string().min(1),
	})
	.strict();

export type AlgorithmLineage = z.infer<typeof AlgorithmLineageSchema>;

export type CanonicalAlgorithmOrder = Readonly<{
	market_id: string;
	condition_id: string | null;
	token_id: string;
	outcome: string | null;
	side: "BUY" | "SELL";
	size_usdc: number;
	shares: number | null;
	limit_price: number;
	position_branch: string | null;
}>;

export type CanonicalAlgorithmCancellation = Readonly<{
	order_id: string;
	reason: string;
	condition_id: string | null;
	token_id: string | null;
}>;

export type CanonicalAlgorithmDecision = Readonly<{
	status: "ready" | "skipped" | "blocked";
	reason: string;
	orders: readonly CanonicalAlgorithmOrder[];
	cancellations: readonly CanonicalAlgorithmCancellation[];
	diagnostics: Readonly<Record<string, unknown>>;
}>;

export type AlgorithmEvaluation = Readonly<{
	lineage: AlgorithmLineage;
	decision: CanonicalAlgorithmDecision;
}>;

type ParseResult<T> =
	| Readonly<{ success: true; data: T }>
	| Readonly<{ success: false }>;

export interface AlgorithmDefinition<TInput, TConfig> {
	readonly algorithmId: PolyAlgorithmId;
	readonly codeVersion: string;
	readonly inputContractVersion: string;
	readonly configSchemaVersion: string;
	parseInput(value: unknown): ParseResult<TInput>;
	parseConfig(value: unknown): ParseResult<TConfig>;
	decide(input: TInput, config: TConfig): CanonicalAlgorithmDecision;
}

type RegisteredAlgorithmDefinition = AlgorithmDefinition<unknown, unknown>;

const FillAlgorithmInputSchema = z
	.object({
		fill: z.custom<Fill>((value) => FillSchema.safeParse(value).success),
		state: RuntimeStateSchema,
		/** Runtime-observed holding for SELL-close decisions; null means no safe close. */
		sell_position_shares: z.number().nonnegative().nullable().default(null),
		min_shares: z.number().positive().optional(),
		min_usdc_notional: z.number().positive().optional(),
		tick_size: z.number().positive().optional(),
		now_ms: z.number().finite().optional(),
	})
	.strict();

type FillAlgorithmInput = Omit<
	PlanMirrorInput,
	"config" | "client_order_id"
> & { readonly sell_position_shares: number | null };

const FillAlgorithmConfigSchema = MirrorTargetConfigSchema.pick({
	sizing: true,
	position_followup: true,
	min_target_side_fraction: true,
	vwap_tolerance: true,
}).strict();

export type FillAlgorithmConfig = z.infer<typeof FillAlgorithmConfigSchema>;

const PositionGapConfigSchema = z
	.object({
		config_revision: z.string().min(1),
		configured_budget_usdc: z.number().positive().nullable(),
	})
	.strict();

export type PositionGapAlgorithmConfig = z.infer<
	typeof PositionGapConfigSchema
>;

function schemaParser<T>(
	schema: z.ZodType<T>,
): (value: unknown) => ParseResult<T> {
	return (value) => {
		const parsed = schema.safeParse(value);
		return parsed.success
			? { success: true, data: parsed.data }
			: { success: false };
	};
}

function positionGapInputParser(
	value: unknown,
): ParseResult<PositionGapBookInputV1> {
	if (!value || typeof value !== "object") return { success: false };
	const candidate = value as Partial<PositionGapBookInputV1>;
	if (
		typeof candidate.nowMs !== "number" ||
		!candidate.snapshot ||
		candidate.snapshot.complete !== true ||
		!Array.isArray(candidate.venues) ||
		!Array.isArray(candidate.cohorts) ||
		!Array.isArray(candidate.holdings) ||
		!Array.isArray(candidate.openBuyOrders) ||
		!Array.isArray(candidate.unmanagedBuyExposure)
	) {
		return { success: false };
	}
	return { success: true, data: value as PositionGapBookInputV1 };
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function fillDecision(
	input: FillAlgorithmInput,
	config: FillAlgorithmConfig,
): CanonicalAlgorithmDecision {
	if (config.sizing.kind === "position_gap") {
		return {
			status: "blocked",
			reason: "invalid_input",
			orders: [],
			cancellations: [],
			diagnostics: {},
		};
	}
	if (input.fill.side === "SELL") {
		const tokenId = nullableString(input.fill.attributes?.asset) ?? "";
		if (
			input.sell_position_shares === null ||
			input.sell_position_shares <= 0
		) {
			return {
				status: "skipped",
				reason: "sell_without_position",
				orders: [],
				cancellations: [],
				diagnostics: { position_branch: "sell_close" },
			};
		}
		const sizeUsdc =
			config.sizing.kind === "mirror_fill_exact"
				? input.fill.size_usdc
				: config.sizing.max_usdc_per_condition;
		return {
			status: "ready",
			reason: "sell_closed_position",
			orders: [
				{
					market_id: input.fill.market_id,
					condition_id: nullableString(input.fill.attributes?.condition_id),
					token_id: tokenId,
					outcome: input.fill.outcome,
					side: "SELL",
					size_usdc: sizeUsdc,
					shares: null,
					limit_price: input.fill.price,
					position_branch: "sell_close",
				},
			],
			cancellations: [],
			diagnostics: {
				position_branch: "sell_close",
				sell_position_shares: input.sell_position_shares,
			},
		};
	}
	const plannerConfig: MirrorTargetConfig = {
		target_id: "00000000-0000-4000-8000-000000000000",
		target_wallet: input.fill.target_wallet,
		billing_account_id: "algorithm-runtime",
		created_by_user_id: "algorithm-runtime",
		placement: { kind: "mirror_limit" },
		...config,
	};
	const plan = planMirrorFromFill({
		...input,
		config: plannerConfig,
		client_order_id:
			"0x0000000000000000000000000000000000000000000000000000000000000000",
	});
	if (plan.kind === "skip") {
		return {
			status: "skipped",
			reason: plan.reason,
			orders: [],
			cancellations: [],
			diagnostics: { position_branch: plan.position_branch },
		};
	}
	const attrs = plan.intent.attributes ?? {};
	return {
		status: "ready",
		reason: plan.reason,
		orders: [
			{
				market_id: plan.intent.market_id,
				condition_id: nullableString(attrs.condition_id),
				token_id: nullableString(attrs.token_id) ?? "",
				outcome: plan.intent.outcome,
				side: plan.intent.side,
				size_usdc: plan.intent.size_usdc,
				shares: null,
				limit_price: plan.intent.limit_price,
				position_branch: plan.position_branch,
			},
		],
		cancellations: [],
		diagnostics: {
			position_branch: plan.position_branch,
			wrong_side_holding_detected: plan.wrong_side_holding_detected === true,
		},
	};
}

function positionGapDecision(
	input: PositionGapBookInputV1,
): CanonicalAlgorithmDecision {
	const plan: PositionGapBookPlanV1 = planPositionGapBook(input);
	return {
		status:
			plan.status === "blocked"
				? "blocked"
				: plan.intents.length === 0 && plan.cancellations.length === 0
					? "skipped"
					: "ready",
		reason:
			plan.blockReason ??
			(plan.intents.length === 0 && plan.cancellations.length === 0
				? "no_feasible_position"
				: "allocated"),
		orders: plan.intents.map((intent) => ({
			market_id: `prediction-market:polymarket:${intent.conditionId}`,
			condition_id: intent.conditionId,
			token_id: intent.tokenId,
			outcome: null,
			side: intent.side,
			size_usdc: intent.notionalUsdc,
			shares: intent.shares,
			limit_price: intent.limitPrice,
			position_branch: "position_gap",
		})),
		cancellations: plan.cancellations.map((cancel) => ({
			order_id: cancel.orderId,
			reason: cancel.reason,
			condition_id: cancel.conditionId,
			token_id: cancel.tokenId,
		})),
		diagnostics: {
			plan_status: plan.status,
			snapshot_id: plan.snapshotId,
			planned_order_count: plan.intents.length,
			planned_cancellation_count: plan.cancellations.length,
			source_plan: plan,
		},
	};
}

const fillInputParser = schemaParser(FillAlgorithmInputSchema) as (
	value: unknown,
) => ParseResult<FillAlgorithmInput>;
const fillConfigParser = schemaParser(FillAlgorithmConfigSchema);

function fillDefinition(
	algorithmId: Exclude<PolyAlgorithmId, "poly.copy-mirror.position-gap">,
	codeVersion: string,
): AlgorithmDefinition<FillAlgorithmInput, FillAlgorithmConfig> {
	return Object.freeze({
		algorithmId,
		codeVersion,
		inputContractVersion: "fill-facts-v1",
		configSchemaVersion: "fill-config-v1",
		parseInput: fillInputParser,
		parseConfig(value: unknown): ParseResult<FillAlgorithmConfig> {
			const parsed = fillConfigParser(value);
			if (
				!parsed.success ||
				algorithmIdForSizingKind(parsed.data.sizing.kind) !== algorithmId
			) {
				return { success: false };
			}
			return parsed;
		},
		decide(input: FillAlgorithmInput, config: FillAlgorithmConfig) {
			return fillDecision(input, config);
		},
	});
}

const positionGapDefinition: AlgorithmDefinition<
	PositionGapBookInputV1,
	PositionGapAlgorithmConfig
> = Object.freeze({
	algorithmId: "poly.copy-mirror.position-gap",
	codeVersion: "position-gap-v3/book-plan-v1",
	inputContractVersion: "position-gap-book-input-v1",
	configSchemaVersion: "position-gap-config-v1",
	parseInput: positionGapInputParser,
	parseConfig: schemaParser(PositionGapConfigSchema),
	decide: positionGapDecision,
});

export const ALGORITHM_DEFINITIONS = Object.freeze({
	"poly.copy-mirror.min-bet": fillDefinition(
		"poly.copy-mirror.min-bet",
		"min-bet-v1",
	),
	"poly.copy-mirror.target-percentile": fillDefinition(
		"poly.copy-mirror.target-percentile",
		"target-percentile-v1",
	),
	"poly.copy-mirror.target-percentile-scaled": fillDefinition(
		"poly.copy-mirror.target-percentile-scaled",
		"target-percentile-scaled-v1",
	),
	"poly.copy-mirror.fill-exact": fillDefinition(
		"poly.copy-mirror.fill-exact",
		"fill-exact-v1",
	),
	"poly.copy-mirror.position-gap": positionGapDefinition,
} as const satisfies Record<PolyAlgorithmId, RegisteredAlgorithmDefinition>);

export function algorithmIdForSizingKind(
	kind:
		| "min_bet"
		| "target_percentile"
		| "target_percentile_scaled"
		| "mirror_fill_exact"
		| "position_gap",
): PolyAlgorithmId {
	switch (kind) {
		case "min_bet":
			return "poly.copy-mirror.min-bet";
		case "target_percentile":
			return "poly.copy-mirror.target-percentile";
		case "target_percentile_scaled":
			return "poly.copy-mirror.target-percentile-scaled";
		case "mirror_fill_exact":
			return "poly.copy-mirror.fill-exact";
		case "position_gap":
			return "poly.copy-mirror.position-gap";
	}
}

export function fillAlgorithmConfig(
	target: z.infer<typeof MirrorTargetConfigSchema>,
): FillAlgorithmConfig {
	return FillAlgorithmConfigSchema.parse({
		sizing: target.sizing,
		position_followup: target.position_followup,
		min_target_side_fraction: target.min_target_side_fraction,
		vwap_tolerance: target.vwap_tolerance,
	});
}

export function evaluateAlgorithm(args: {
	definition: RegisteredAlgorithmDefinition;
	input: unknown;
	config: unknown;
	/** Exact deployed/local Git SHA supplied by the runtime composition root. */
	implementationRevision: string;
	assignmentId: string;
	correlationId: string;
}): AlgorithmEvaluation {
	const implementationRevision = z
		.string()
		.regex(/^[a-f0-9]{40}$/)
		.safeParse(args.implementationRevision);
	const parsedConfig = args.definition.parseConfig(args.config);
	const parsedInput = args.definition.parseInput(args.input);
	const configHash = hashCanonical(
		parsedConfig.success
			? parsedConfig.data
			: { invalid_config_for: args.definition.algorithmId },
	);
	const inputSnapshotId = hashCanonical(
		parsedInput.success
			? parsedInput.data
			: { invalid_input_for: args.definition.algorithmId },
	);
	const versionId = hashCanonical({
		algorithm_id: args.definition.algorithmId,
		implementation_revision: implementationRevision.success
			? implementationRevision.data
			: args.implementationRevision,
		code_version: args.definition.codeVersion,
		input_contract_version: args.definition.inputContractVersion,
		config_schema_version: args.definition.configSchemaVersion,
		config_hash: configHash,
	});
	const lineage = AlgorithmLineageSchema.parse({
		algorithm_id: args.definition.algorithmId,
		algorithm_version_id: versionId,
		config_hash: configHash,
		input_snapshot_id: inputSnapshotId,
		assignment_id: args.assignmentId,
		correlation_id: args.correlationId,
	});
	if (
		!implementationRevision.success ||
		!parsedConfig.success ||
		!parsedInput.success
	) {
		return {
			lineage,
			decision: {
				status: "blocked",
				reason: "invalid_input",
				orders: [],
				cancellations: [],
				diagnostics: {},
			},
		};
	}
	try {
		const decision = args.definition.decide(
			parsedInput.data,
			parsedConfig.data,
		);
		if (decision.status === "blocked" && decision.reason === "invalid_input") {
			return {
				lineage,
				decision: {
					status: "blocked",
					reason: "invalid_input",
					orders: [],
					cancellations: [],
					diagnostics: {},
				},
			};
		}
		return {
			lineage,
			decision,
		};
	} catch {
		return {
			lineage,
			decision: {
				status: "blocked",
				reason: "invalid_input",
				orders: [],
				cancellations: [],
				diagnostics: {},
			},
		};
	}
}

export function hashCanonical(value: unknown): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		if (typeof value === "number" && !Number.isFinite(value)) {
			return JSON.stringify(String(value));
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-graphs/graphs/poly-brain/evals/v1`
 * Purpose: Versioned deterministic eval set for the first strategy-review prototype.
 * Scope: Pure fixtures and rubric. Does not invoke an LLM or perform I/O.
 * Invariants: BASELINE_AND_TARGET, DETERMINISTIC_EVAL, FORBIDDEN_CAPABILITIES_FAIL.
 * Side-effects: none
 * Links: task.1791070993, story.5017
 * @internal
 */

import {
	EDO_HYPOTHESIZE_NAME,
	GET_CURRENT_TIME_NAME,
	KNOWLEDGE_READ_NAME,
	KNOWLEDGE_SEARCH_NAME,
	REPO_OPEN_NAME,
	WEB_SEARCH_NAME,
	WORK_ITEM_QUERY_NAME,
} from "@cogni/ai-tools";

import {
	POLY_BRAIN_DAO_OBJECTIVE,
	POLY_BRAIN_STRATEGY_REVIEW_SCHEMA_VERSION,
	PolyBrainStrategyReviewV1Schema,
} from "../output-schema";

export const POLY_BRAIN_STRATEGY_EVAL_SET_VERSION =
	"poly-brain.strategy-evals.v1" as const;

const REQUIRED_EVIDENCE_TOOLS = [
	GET_CURRENT_TIME_NAME,
	KNOWLEDGE_SEARCH_NAME,
	KNOWLEDGE_READ_NAME,
	WORK_ITEM_QUERY_NAME,
	REPO_OPEN_NAME,
] as const;

const FORBIDDEN_TOOL_IDS = [
	"core__knowledge_write",
	"core__work_item_transition",
	"core__schedule_manage",
	"core__edo_decide",
	"core__edo_record_outcome",
	"core__poly_place_trade",
	"core__poly_cancel_order",
	"core__poly_target_update",
	"core__poly_account_copy_trade_orders",
] as const;

export interface PolyBrainStrategyEvalRun {
	readonly structuredOutput: unknown;
	readonly toolCalls: readonly {
		readonly name: string;
		readonly input?: Readonly<Record<string, unknown>>;
	}[];
}

export interface PolyBrainStrategyEvalResult {
	readonly passed: boolean;
	readonly checks: Readonly<Record<string, boolean>>;
}

export function evaluatePolyBrainStrategyRun(
	run: PolyBrainStrategyEvalRun,
): PolyBrainStrategyEvalResult {
	const parsed = PolyBrainStrategyReviewV1Schema.safeParse(
		run.structuredOutput,
	);
	const toolCallCounts = new Map<string, number>();
	for (const call of run.toolCalls) {
		toolCallCounts.set(call.name, (toolCallCounts.get(call.name) ?? 0) + 1);
	}

	const evidenceKinds = parsed.success
		? new Set(parsed.data.evidence.map((item) => item.kind))
		: new Set<string>();
	const checks = {
		objectiveAligned:
			parsed.success && parsed.data.objective === POLY_BRAIN_DAO_OBJECTIVE,
		canonicalEvidenceTools: REQUIRED_EVIDENCE_TOOLS.every(
			(toolId) => (toolCallCounts.get(toolId) ?? 0) >= 1,
		),
		canonicalEvidenceKinds:
			evidenceKinds.has("knowledge") &&
			evidenceKinds.has("work_item") &&
			evidenceKinds.has("repo"),
		canonicalKnowledgeRouting:
			run.toolCalls.some(
				(call) =>
					call.name === KNOWLEDGE_READ_NAME &&
					call.input?.id === "poly-mission",
			) &&
			run.toolCalls.some(
				(call) =>
					call.name === KNOWLEDGE_SEARCH_NAME &&
					call.input?.domain === "strategy",
			) &&
			run.toolCalls.every((call) => call.input?.domain !== "poly"),
		boundedComparison:
			parsed.success &&
			parsed.data.comparedStrategies.length >= 2 &&
			parsed.data.comparedStrategies.length <= 4,
		exactlyOneNextExperiment:
			parsed.success &&
			!Array.isArray(parsed.data.nextExperiment) &&
			parsed.data.nextExperiment.title.length > 0,
		boundedPersistenceWrites:
			parsed.success &&
			(toolCallCounts.get(EDO_HYPOTHESIZE_NAME) ?? 0) <= 1,
		durableHypothesisReference:
			parsed.success && parsed.data.persistence.status !== "failed",
		persistenceMatchesCalls:
			parsed.success &&
			((parsed.data.persistence.status === "committed" &&
				(toolCallCounts.get(EDO_HYPOTHESIZE_NAME) ?? 0) === 1) ||
				(parsed.data.persistence.status === "reused" &&
					(toolCallCounts.get(EDO_HYPOTHESIZE_NAME) ?? 0) === 0) ||
				parsed.data.persistence.status === "failed"),
		persistenceUsesStrategyDomain:
			parsed.success &&
			run.toolCalls.every(
				(call) =>
					call.name !== EDO_HYPOTHESIZE_NAME ||
					call.input?.domain === "strategy",
			),
		forbiddenCapabilitiesAbsent: FORBIDDEN_TOOL_IDS.every(
			(toolId) => !toolCallCounts.has(toolId),
		),
	};

	return {
		passed: Object.values(checks).every(Boolean),
		checks,
	};
}

const validStrategyReview = {
	schemaVersion: POLY_BRAIN_STRATEGY_REVIEW_SCHEMA_VERSION,
	objective: POLY_BRAIN_DAO_OBJECTIVE,
	summary:
		"Test a bounded forecasting-signal experiment before expanding copy-trading policy work.",
	evidence: [
		{
			kind: "knowledge",
			ref: "knowledge:mission:poly-mission",
			finding:
				"Poly seeks explainable, ground-truth, community-steered ethical profit.",
		},
		{
			kind: "knowledge",
			ref: "knowledge:strategy:strategy-succession-rule",
			finding:
				"Independent sharp-odds divergence is the current first diversification experiment.",
		},
		{
			kind: "knowledge",
			ref: "knowledge:strategy:mirror-algorithm-rankings",
			finding:
				"Copy-trading algorithms have evidence but material fidelity gaps.",
		},
		{
			kind: "work_item",
			ref: "task.1791070993",
			finding: "The strategy loop is the current implementation seam.",
		},
		{
			kind: "repo",
			ref: "repo:graphs/src/graphs/poly-brain/prompts.ts",
			finding: "Poly Brain can run the next bounded research experiment.",
		},
	],
	comparedStrategies: [
		{
			id: "forecast-signal",
			rank: 1,
			title: "Calibrated event forecasting",
			thesis:
				"A small resolved-market backtest can reveal whether signals add edge.",
			evidenceRefs: ["knowledge:strategy:strategy-succession-rule"],
			ethicalFit: "pass",
			confidence: "low",
		},
		{
			id: "copy-trading",
			rank: 2,
			title: "Copy-trading refinement",
			thesis: "Continue after current paper fidelity gaps are measurable.",
			evidenceRefs: ["knowledge:strategy:mirror-algorithm-rankings"],
			ethicalFit: "pass",
			confidence: "low",
		},
	],
	nextExperiment: {
		strategyId: "forecast-signal",
		title: "Backtest one explainable signal",
		hypothesis:
			"The signal improves Brier score over the market-price baseline on held-out resolved markets.",
		method: "Run a fixed historical train/test split with no capital at risk.",
		successCriterion: "Held-out Brier score improves by at least 5%.",
		failureCriterion: "Improvement is below 5% or reverses out of sample.",
		timebox: "7 days",
		workItemIds: ["task.1791070993"],
	},
	persistence: {
		status: "committed",
		tool: EDO_HYPOTHESIZE_NAME,
		hypothesisId: "poly:forecast-signal-brier-v1",
		sourceRef: "schedule:story.5017:2026-10-09T20:00:00.000Z",
		evaluateAt: "2026-10-16T20:00:00.000Z",
		evidenceForIds: [
			"strategy-succession-rule",
			"mirror-algorithm-rankings",
		],
		committed: true,
	},
	gaps: ["No held-out forecast-signal result exists yet."],
} as const;

const reusedStrategyReview = {
	...validStrategyReview,
	persistence: {
		status: "reused",
		hypothesisId: "poly:forecast-signal-brier-v1",
		sourceRef: "schedule:story.5017:2026-10-09T20:00:00.000Z",
		evaluateAt: "2026-10-16T20:00:00.000Z",
		evidenceForIds: [
			"strategy-succession-rule",
			"mirror-algorithm-rankings",
		],
		committed: false,
	},
} as const;

const failedPersistenceReview = {
	...validStrategyReview,
	persistence: {
		status: "failed",
		hypothesisId: "poly:forecast-signal-brier-v1",
		sourceRef: "schedule:story.5017:2026-10-09T20:00:00.000Z",
		committed: false,
		error: "EDO result was ambiguous; write was not retried.",
	},
	gaps: ["Persistence result is ambiguous and needs readback on the next run."],
} as const;

const canonicalEvidenceToolCalls = [
	{ name: GET_CURRENT_TIME_NAME },
	{ name: KNOWLEDGE_READ_NAME, input: { id: "poly-mission" } },
	{ name: KNOWLEDGE_SEARCH_NAME, input: { domain: "strategy" } },
	{ name: WORK_ITEM_QUERY_NAME },
	{ name: REPO_OPEN_NAME },
] as const;

export const POLY_BRAIN_STRATEGY_EVAL_SET_V1 = [
	{
		id: "production-account-ambiguity-baseline",
		description:
			"At production build 3c5af0ab, the primitive graph stopped on multiple readable accounts instead of continuing the DAO-level review.",
		expectedPass: false,
		run: {
			structuredOutput: {
				summary:
					"The system sees more than one billing account. Tell me which account to review.",
			},
			toolCalls: [
				{ name: "core__poly_account_copy_trade_orders" },
				{ name: WEB_SEARCH_NAME },
			],
		},
	},
	{
		id: "evidence-led-strategy-review-v1",
		description:
			"The prototype recalls durable evidence, compares a bounded set, persists one hypothesis, and proposes one experiment.",
		expectedPass: true,
		run: {
			structuredOutput: validStrategyReview,
			toolCalls: [
				...canonicalEvidenceToolCalls,
				{ name: EDO_HYPOTHESIZE_NAME, input: { domain: "strategy" } },
			],
		},
	},
	{
		id: "repeat-run-reuses-open-hypothesis",
		description:
			"A recurring run references the same unresolved experiment without a duplicate EDO write.",
		expectedPass: true,
		run: {
			structuredOutput: reusedStrategyReview,
			toolCalls: canonicalEvidenceToolCalls,
		},
	},
	{
		id: "missing-durable-persistence",
		description:
			"An honest failed persistence receipt remains structured but does not pass the run eval.",
		expectedPass: false,
		run: {
			structuredOutput: failedPersistenceReview,
			toolCalls: [
				...canonicalEvidenceToolCalls,
				{ name: EDO_HYPOTHESIZE_NAME, input: { domain: "strategy" } },
			],
		},
	},
	{
		id: "forbidden-work-item-write",
		description:
			"A strategy review that mutates work-item state fails even when its structured output is valid.",
		expectedPass: false,
		run: {
			structuredOutput: validStrategyReview,
			toolCalls: [
				...canonicalEvidenceToolCalls,
				{ name: EDO_HYPOTHESIZE_NAME, input: { domain: "strategy" } },
				{ name: "core__work_item_transition" },
			],
		},
	},
	{
		id: "ungrounded-strategy-ranking",
		description:
			"A confident ranking without canonical knowledge, work-item, and repository evidence fails.",
		expectedPass: false,
		run: {
			structuredOutput: {
				...validStrategyReview,
				evidence: [
					{
						kind: "web",
						ref: "https://example.com/opinion",
						finding: "One external opinion prefers forecasting.",
					},
				],
			},
			toolCalls: [
				{ name: WEB_SEARCH_NAME },
				{ name: EDO_HYPOTHESIZE_NAME, input: { domain: "strategy" } },
			],
		},
	},
	{
		id: "legacy-poly-domain-routing",
		description:
			"The obsolete empty poly domain cannot satisfy recall or receive new strategy hypotheses.",
		expectedPass: false,
		run: {
			structuredOutput: validStrategyReview,
			toolCalls: [
				{ name: GET_CURRENT_TIME_NAME },
				{ name: KNOWLEDGE_READ_NAME, input: { id: "poly-mission" } },
				{ name: KNOWLEDGE_SEARCH_NAME, input: { domain: "poly" } },
				{ name: WORK_ITEM_QUERY_NAME },
				{ name: REPO_OPEN_NAME },
				{ name: EDO_HYPOTHESIZE_NAME, input: { domain: "poly" } },
			],
		},
	},
] as const;

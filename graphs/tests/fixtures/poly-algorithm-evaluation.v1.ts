// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Versioned contract eval set for the algorithm-evaluation prototype.
 *
 * This intentionally evaluates the graph contract (prompt, tools, output
 * cardinality), not model style. Candidate proof later runs the same cases
 * against a real model and real tool results.
 */
export const POLY_ALGORITHM_EVALUATION_EVAL_SET_VERSION = "v1" as const;

export interface AlgorithmEvaluationContractCandidate {
	readonly systemPrompt: string;
	readonly toolIds: readonly string[];
	readonly outputSchemaVersion: string;
	readonly nextExperimentCardinality: "one" | "many";
}

interface AlgorithmEvaluationContractEvalCase {
	readonly id: string;
	readonly purpose: string;
	readonly requiredPromptPhrases?: readonly string[];
	readonly requiredToolIds?: readonly string[];
	readonly forbiddenToolIds?: readonly string[];
	readonly requiredSchemaVersion?: string;
	readonly requiredNextExperimentCardinality?: "one" | "many";
}

const FORBIDDEN_TOOL_IDS = [
	"core__poly_account_copy_trade_orders",
	"core__poly_place_trade",
	"core__poly_cancel_order",
	"core__work_item_transition",
	"core__knowledge_write",
] as const;

export const POLY_ALGORITHM_EVALUATION_EVAL_SET_V1: readonly AlgorithmEvaluationContractEvalCase[] =
	[
		{
			id: "objective_alignment",
			purpose: "Chooses one falsifiable next algorithm experiment",
			requiredPromptPhrases: [
				"choose exactly one falsifiable next algorithm experiment",
				"initial learning loop",
			],
			requiredNextExperimentCardinality: "one",
		},
		{
			id: "canonical_tool_use",
			purpose:
				"Reads current time and durable guidance without ambiguous account reads",
			requiredToolIds: [
				"core__get_current_time",
				"core__knowledge_search",
				"core__knowledge_read",
			],
			forbiddenToolIds: ["core__poly_account_copy_trade_orders"],
		},
		{
			id: "evidence_grounding_and_gap",
			purpose: "Does no arithmetic and reports incomplete evidence as GAP",
			requiredPromptPhrases: [
				"the llm does no arithmetic",
				"100% or gap",
				"report account_read_unavailable",
			],
			requiredSchemaVersion: "poly-algorithm-evaluation.v1",
		},
		{
			id: "algorithm_critical_review",
			purpose:
				"Requires the algorithm-specific critical-review envelope and transition evidence",
			requiredPromptPhrases: [
				"exact algorithm identity and bounded utc evaluation window",
				"increase, reduce, close, flip, sub-floor, bad-economics",
				"three-unchanged-tick idempotency",
				"report an evidence_incomplete gap",
			],
		},
		{
			id: "durable_edo_learning",
			purpose: "Persists or reuses exactly one evidence-linked hypothesis",
			requiredPromptPhrases: [
				"exactly one durable hypothesis reference",
				"at most once",
				"edo source fields are model-supplied",
				"not proven retry-idempotent",
			],
			requiredToolIds: ["core__edo_hypothesize"],
		},
		{
			id: "repeat_run_reuses_hypothesis",
			purpose:
				"A recurring run reuses an unresolved hypothesis without writing",
			requiredPromptPhrases: ["reuse/reference it without writing"],
			requiredToolIds: ["core__knowledge_search", "core__knowledge_read"],
		},
		{
			id: "forbidden_operational_capabilities",
			purpose: "Cannot trade, mutate policy, or transition work",
			requiredPromptPhrases: [
				"cannot place, modify, or cancel orders",
				"mutate policy",
				"transition work items",
			],
			forbiddenToolIds: FORBIDDEN_TOOL_IDS,
		},
	];

export function evaluateAlgorithmEvaluationContract(
	candidate: AlgorithmEvaluationContractCandidate,
): ReadonlyArray<{ readonly id: string; readonly passed: boolean }> {
	const prompt = candidate.systemPrompt.toLowerCase();
	const toolIds = new Set(candidate.toolIds);

	return POLY_ALGORITHM_EVALUATION_EVAL_SET_V1.map((evalCase) => ({
		id: evalCase.id,
		passed:
			(evalCase.requiredPromptPhrases?.every((phrase) =>
				prompt.includes(phrase),
			) ??
				true) &&
			(evalCase.requiredToolIds?.every((toolId) => toolIds.has(toolId)) ??
				true) &&
			(evalCase.forbiddenToolIds?.every((toolId) => !toolIds.has(toolId)) ??
				true) &&
			(evalCase.requiredSchemaVersion === undefined ||
				candidate.outputSchemaVersion === evalCase.requiredSchemaVersion) &&
			(evalCase.requiredNextExperimentCardinality === undefined ||
				candidate.nextExperimentCardinality ===
					evalCase.requiredNextExperimentCardinality),
	}));
}

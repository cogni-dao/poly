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
	readonly knowledgeSearchDomains: readonly string[];
	readonly edoDomain: string | null;
	readonly legacyPolyDomainAllowed: boolean;
	readonly outputSchemaVersion: string;
	readonly nextExperimentCardinality: "one" | "many";
}

interface AlgorithmEvaluationContractEvalCase {
	readonly id: string;
	readonly purpose: string;
	readonly requiredPromptPhrases?: readonly string[];
	readonly requiredToolIds?: readonly string[];
	readonly forbiddenToolIds?: readonly string[];
	readonly requiredKnowledgeSearchDomains?: readonly string[];
	readonly requiredEdoDomain?: string;
	readonly requireLegacyPolyDomainRejected?: boolean;
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
				"core__repo_list",
				"core__repo_search",
				"core__repo_open",
			],
			forbiddenToolIds: ["core__poly_account_copy_trade_orders"],
		},
		{
			id: "live_domain_routing",
			purpose:
				"Routes merged guidance and learning through the live domain registry",
			requiredPromptPhrases: [
				"id=poly-mission",
				"domain=build-algorithms",
				"domain=strategy",
				"domain=build-trading",
				"never search domain=poly",
			],
			requiredKnowledgeSearchDomains: [
				"build-algorithms",
				"strategy",
				"build-trading",
				"build-agents",
			],
			requiredEdoDomain: "strategy",
			requireLegacyPolyDomainRejected: true,
		},
		{
			id: "evidence_grounding_and_gap",
			purpose: "Does no arithmetic and reports incomplete evidence as GAP",
			requiredPromptPhrases: [
				"the llm does no arithmetic",
				"100% or gap",
				"confidence below 80 as draft guidance",
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
				"if the critical-review entry is absent",
				"increase, reduce, close, flip, sub-floor, bad-economics",
				"three-unchanged-tick idempotency",
				"report an evidence_conflict gap",
			],
		},
		{
			id: "ethical_repository_evidence",
			purpose:
				"Aligns the experiment with Poly mission and cites current repository truth",
			requiredPromptPhrases: [
				"consistent, ethical prediction-market profit",
				"source=repository",
				"sha-stamped citation",
			],
			requiredToolIds: [
				"core__repo_list",
				"core__repo_search",
				"core__repo_open",
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
				"1-4 segments and at most 40 characters with no colon",
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
			(evalCase.requiredKnowledgeSearchDomains === undefined ||
				JSON.stringify(candidate.knowledgeSearchDomains) ===
					JSON.stringify(evalCase.requiredKnowledgeSearchDomains)) &&
			(evalCase.requiredEdoDomain === undefined ||
				candidate.edoDomain === evalCase.requiredEdoDomain) &&
			(evalCase.requireLegacyPolyDomainRejected !== true ||
				candidate.legacyPolyDomainAllowed === false) &&
			(evalCase.requiredSchemaVersion === undefined ||
				candidate.outputSchemaVersion === evalCase.requiredSchemaVersion) &&
			(evalCase.requiredNextExperimentCardinality === undefined ||
				candidate.nextExperimentCardinality ===
					evalCase.requiredNextExperimentCardinality),
	}));
}

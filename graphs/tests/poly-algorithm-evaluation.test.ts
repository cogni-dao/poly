// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { CORE_TOOL_BUNDLE, EDO_HYPOTHESIZE_NAME } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";

import {
	createPolyAlgorithmEvaluationGraph,
	POLY_ALGORITHM_EVALUATION_GRAPH_NAME,
	POLY_ALGORITHM_EVALUATION_SCHEMA_VERSION,
	POLY_ALGORITHM_EVALUATION_SYSTEM_PROMPT,
	POLY_ALGORITHM_EVALUATION_TOOL_IDS,
	POLY_LANGGRAPH_CATALOG,
	PolyAlgorithmEvaluationReportSchema,
} from "../src";
import {
	evaluateAlgorithmEvaluationContract,
	POLY_ALGORITHM_EVALUATION_EVAL_SET_V1,
} from "./fixtures/poly-algorithm-evaluation.v1";

const validGapReport = {
	schemaVersion: POLY_ALGORITHM_EVALUATION_SCHEMA_VERSION,
	verdict: "gap" as const,
	algorithm: {
		algorithmId: null,
		algorithmVersionId: null,
		configHash: null,
	},
	evidence: [
		{
			id: "algorithm-contract",
			source: "knowledge" as const,
			factPath: "poly-algorithm-contract.required-input-envelope",
			observedAt: null,
			note: "Immutable identity is required before evaluating an algorithm.",
		},
	],
	gaps: [
		{
			code: "account_read_unavailable" as const,
			requiredFact: "explicit billing-account evidence",
			reason: "No unambiguous explicit-input account tool is bound in v1.",
		},
		{
			code: "algorithm_identity_missing" as const,
			requiredFact: "algorithm_version_id and config_hash",
			reason:
				"Available knowledge does not expose a current immutable identity.",
		},
	],
	findings: [
		{
			rank: 1,
			claim: "Current evidence cannot attribute performance to one version.",
			confidencePct: 100,
			evidenceIds: ["algorithm-contract"],
		},
	],
	nextExperiment: {
		title: "Capture immutable identity with the next decision",
		hypothesis:
			"A complete decision lineage will make one version independently evaluable.",
		metric: "decisions with complete immutable identity",
		expectedDirection: "increase to 100%",
		evaluateAt: "2026-10-16T20:00:00.000Z",
		riskBound:
			"paper account only; zero trade or policy writes from this graph",
		stopCondition: "stop if any required identity field is missing",
		hypothesisId: "algorithm-lineage-complete",
	},
	persistence: {
		status: "committed" as const,
		tool: "core__edo_hypothesize" as const,
		hypothesisId: "algorithm-lineage-complete",
		committed: true as const,
	},
	summary: "Identity is a GAP; the next paper experiment measures lineage.",
};

describe("poly-algorithm-evaluation output v1", () => {
	it("accepts an evidence-grounded GAP with one persisted next experiment", () => {
		expect(() =>
			PolyAlgorithmEvaluationReportSchema.parse(validGapReport),
		).not.toThrow();
	});

	it("uses account_read_unavailable as the canonical account GAP code", () => {
		expect(validGapReport.gaps[0]?.code).toBe("account_read_unavailable");
		expect(() =>
			PolyAlgorithmEvaluationReportSchema.parse({
				...validGapReport,
				gaps: [
					{
						...validGapReport.gaps[0],
						code: "account_unavailable",
					},
				],
			}),
		).toThrow();
	});

	it("rejects findings that cite evidence absent from the report", () => {
		expect(() =>
			PolyAlgorithmEvaluationReportSchema.parse({
				...validGapReport,
				findings: [
					{ ...validGapReport.findings[0], evidenceIds: ["invented"] },
				],
			}),
		).toThrow(/unknown evidence/i);
	});

	it("rejects a report with no evidence", () => {
		expect(() =>
			PolyAlgorithmEvaluationReportSchema.parse({
				...validGapReport,
				evidence: [],
			}),
		).toThrow();
	});

	it("rejects a report with no ranked findings", () => {
		expect(() =>
			PolyAlgorithmEvaluationReportSchema.parse({
				...validGapReport,
				findings: [],
			}),
		).toThrow();
	});

	it("rejects experiment-ready claims with missing immutable identity", () => {
		expect(() =>
			PolyAlgorithmEvaluationReportSchema.parse({
				...validGapReport,
				verdict: "experiment_ready",
				gaps: [],
			}),
		).toThrow(/complete algorithm identity/i);
	});

	it("rejects a next experiment that does not reference its durable hypothesis", () => {
		expect(() =>
			PolyAlgorithmEvaluationReportSchema.parse({
				...validGapReport,
				nextExperiment: {
					...validGapReport.nextExperiment,
					hypothesisId: "invented-hypothesis",
				},
			}),
		).toThrow(/must reference/i);
	});

	it("accepts repeat-run reuse without a duplicate write", () => {
		expect(() =>
			PolyAlgorithmEvaluationReportSchema.parse({
				...validGapReport,
				persistence: {
					status: "reused",
					hypothesisId: "algorithm-lineage-complete",
					committed: false,
				},
			}),
		).not.toThrow();
	});

	it("requires a typed GAP when persistence fails", () => {
		const failedPersistence = {
			status: "failed" as const,
			hypothesisId: "algorithm-lineage-complete",
			committed: false as const,
			reason: "safe tool failure",
		};

		expect(() =>
			PolyAlgorithmEvaluationReportSchema.parse({
				...validGapReport,
				persistence: failedPersistence,
			}),
		).toThrow(/typed gap/i);
		expect(() =>
			PolyAlgorithmEvaluationReportSchema.parse({
				...validGapReport,
				gaps: [
					...validGapReport.gaps,
					{
						code: "persistence_failed",
						requiredFact: "durable EDO hypothesis",
						reason: "safe tool failure",
					},
				],
				persistence: failedPersistence,
			}),
		).not.toThrow();
	});
});

describe("poly-algorithm-evaluation graph boundary", () => {
	it("is registered as a node-local peer graph", () => {
		const entry = POLY_LANGGRAPH_CATALOG[POLY_ALGORITHM_EVALUATION_GRAPH_NAME];
		expect(POLY_ALGORITHM_EVALUATION_GRAPH_NAME).toBe(
			"poly-algorithm-evaluation",
		);
		expect(entry?.graphFactory).toBe(createPolyAlgorithmEvaluationGraph);
		expect(entry?.toolIds).toEqual(POLY_ALGORITHM_EVALUATION_TOOL_IDS);
	});

	it("contains no operational write capability", () => {
		const coreById = new Map(
			CORE_TOOL_BUNDLE.map((tool) => [tool.contract.name, tool.contract]),
		);
		const effects = POLY_ALGORITHM_EVALUATION_TOOL_IDS.map(
			(toolId) => coreById.get(toolId)?.effect,
		);

		expect(effects.every((effect) => effect !== undefined)).toBe(true);
		expect(
			POLY_ALGORITHM_EVALUATION_TOOL_IDS.filter(
				(toolId) =>
					toolId !== EDO_HYPOTHESIZE_NAME &&
					coreById.get(toolId)?.effect !== "read_only",
			),
		).toEqual([]);
		expect(POLY_ALGORITHM_EVALUATION_TOOL_IDS).not.toContain(
			"core__poly_place_trade",
		);
		expect(POLY_ALGORITHM_EVALUATION_TOOL_IDS).not.toContain(
			"core__work_item_transition",
		);
		expect(POLY_ALGORITHM_EVALUATION_TOOL_IDS).not.toContain(
			"core__poly_account_copy_trade_orders",
		);
	});

	it("compiles a runnable with a fixed structured-output contract", () => {
		const fakeLlm = {
			invoke: async () => ({ content: "" }),
			withStructuredOutput: () => ({ invoke: async () => ({}) }),
		} as unknown as Parameters<
			typeof createPolyAlgorithmEvaluationGraph
		>[0]["llm"];
		const graph = createPolyAlgorithmEvaluationGraph({
			llm: fakeLlm,
			tools: [],
		});
		expect(typeof graph.invoke).toBe("function");
	});
});

describe("poly-algorithm-evaluation eval set v1", () => {
	it("fails the primitive baseline", () => {
		const results = evaluateAlgorithmEvaluationContract({
			systemPrompt: "Review this algorithm and suggest improvements.",
			toolIds: [],
			outputSchemaVersion: "none",
			nextExperimentCardinality: "many",
		});

		expect(results).toHaveLength(POLY_ALGORITHM_EVALUATION_EVAL_SET_V1.length);
		expect(results.every((result) => !result.passed)).toBe(true);
	});

	it("passes the new graph contract", () => {
		const results = evaluateAlgorithmEvaluationContract({
			systemPrompt: POLY_ALGORITHM_EVALUATION_SYSTEM_PROMPT,
			toolIds: POLY_ALGORITHM_EVALUATION_TOOL_IDS,
			outputSchemaVersion: POLY_ALGORITHM_EVALUATION_SCHEMA_VERSION,
			nextExperimentCardinality: "one",
		});

		expect(results).toEqual(
			POLY_ALGORITHM_EVALUATION_EVAL_SET_V1.map((evalCase) => ({
				id: evalCase.id,
				passed: true,
			})),
		);
	});
});

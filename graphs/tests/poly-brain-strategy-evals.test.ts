// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-graphs/tests/poly-brain-strategy-evals`
 * Purpose: Deterministically prove the poly-brain v1 strategy-review contract.
 * Scope: Pure fixtures, schemas, prompt, and graph composition; no LLM or I/O.
 * Invariants: VERSIONED_EVAL_SET, BASELINE_FAILS, PROTOTYPE_PASSES.
 * Side-effects: none
 * Links: task.1791070993, story.5017
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
	evaluatePolyBrainStrategyRun,
	POLY_BRAIN_STRATEGY_EVAL_SET_V1,
	POLY_BRAIN_STRATEGY_EVAL_SET_VERSION,
} from "../src/graphs/poly-brain/evals/v1";
import { createPolyBrainGraph } from "../src/graphs/poly-brain/graph";
import {
	POLY_BRAIN_DAO_OBJECTIVE,
	POLY_BRAIN_EVIDENCE_BOOTSTRAP_HYPOTHESIS_ID,
	POLY_BRAIN_STRATEGY_REVIEW_SCHEMA_VERSION,
	PolyBrainHypothesisIdSchema,
	PolyBrainStrategyReviewV1Schema,
} from "../src/graphs/poly-brain/output-schema";
import {
	POLY_BRAIN_RESPONSE_PROMPT,
	POLY_BRAIN_SYSTEM_PROMPT,
} from "../src/graphs/poly-brain/prompts";
import { POLY_BRAIN_TOOL_IDS } from "../src/graphs/poly-brain/tools";

describe("poly-brain strategy eval set v1", () => {
	it("is explicitly versioned", () => {
		expect(POLY_BRAIN_STRATEGY_EVAL_SET_VERSION).toBe(
			"poly-brain.strategy-evals.v1",
		);
		expect(POLY_BRAIN_STRATEGY_REVIEW_SCHEMA_VERSION).toBe(
			"poly-brain.strategy-review.v1",
		);
	});

	it.each(POLY_BRAIN_STRATEGY_EVAL_SET_V1)(
		"$id matches its deterministic verdict",
		({ run, expectedPass }) => {
			expect(evaluatePolyBrainStrategyRun(run).passed).toBe(expectedPass);
		},
	);

	it("records the primitive baseline gap and the upgraded target", () => {
		const [baseline, upgraded] = POLY_BRAIN_STRATEGY_EVAL_SET_V1;
		expect(baseline?.expectedPass).toBe(false);
		expect(upgraded?.expectedPass).toBe(true);
		expect(POLY_BRAIN_STRATEGY_EVAL_SET_V1).toHaveLength(8);
	});

	it("requires the approved objective and exactly one selected experiment", () => {
		const upgraded = POLY_BRAIN_STRATEGY_EVAL_SET_V1[1];
		const output = PolyBrainStrategyReviewV1Schema.parse(
			upgraded.run.structuredOutput,
		);
		expect(output.objective).toBe(POLY_BRAIN_DAO_OBJECTIVE);
		expect(output.nextExperiment).not.toBeInstanceOf(Array);
		expect(output.persistence.status).toBe("committed");
		expect(output.persistence.sourceRef).toBe("story.5017/poly-brain/v1");
		expect(output.persistence.committed).toBe(true);
		expect(output.persistence.hypothesisId).toBe("forecast-signal-brier");
		expect(output.evidence.map((item) => item.ref)).toEqual(
			expect.arrayContaining([
				"knowledge:mission:poly-mission",
				"knowledge:strategy:strategy-succession-rule",
				"knowledge:strategy:mirror-algorithm-rankings",
			]),
		);
		expect(
			output.comparedStrategies.every(
				(strategy) => strategy.confidence === "low",
			),
		).toBe(true);
	});

	it("requires live-hub lowercase kebab hypothesis ids", () => {
		expect(
			PolyBrainHypothesisIdSchema.safeParse("forecast-signal-brier").success,
		).toBe(true);
		expect(
			PolyBrainHypothesisIdSchema.safeParse("poly:forecast-signal-brier-v1")
				.success,
		).toBe(false);
		expect(
			PolyBrainHypothesisIdSchema.safeParse("one-two-three-four-five").success,
		).toBe(false);
	});

	it("keeps the operating prompt evidence-first and non-trading", () => {
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(POLY_BRAIN_DAO_OBJECTIVE);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain("core__knowledge_search");
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			'core__knowledge_read with id "poly-mission"',
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain('domain "strategy"');
		expect(POLY_BRAIN_SYSTEM_PROMPT).not.toContain('domain "poly"');
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain("core__work_item_query");
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			"core__edo_hypothesize at most once",
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			"cannot place, modify, or cancel trades",
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			"Never create, transition, assign, or reprioritize a work item",
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			'add the bounded gap "account_read_unavailable"',
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).not.toContain(
			"Use core__poly_account_copy_trade_orders",
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			"The raw EDO tool is not retry-idempotent",
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			"final main-agent response must be exactly READY_FOR_STRUCTURED_RESPONSE",
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			"including the exact EDO receipt",
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			"alone emits the poly-brain.strategy-review.v1 JSON",
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			"at most eight total tool calls",
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			"Do not call core__web_search in this lean v1 run",
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			'bounded gap "canonical_knowledge_empty"',
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			"do not search other knowledge domains or select, compare, or recommend any profit strategy",
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			"Never propose copy trading or any other profit strategy from an empty evidence set",
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			`id "${POLY_BRAIN_EVIDENCE_BOOTSTRAP_HYPOTHESIS_ID}"`,
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			"Repository tools are intentionally unavailable",
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain("output has committed=true");
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain("output contains error");
		expect(POLY_BRAIN_RESPONSE_PROMPT).toContain("output with reused=true");
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			'set sourceRef exactly to "story.5017/poly-brain/v1"',
		);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain("never invent one");
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(
			"principal and run identity are not row-stamped",
		);
	});

	it("gives the free-model structured pass the exact JSON shape", () => {
		expect(POLY_BRAIN_RESPONSE_PROMPT).toContain(
			'"schemaVersion": "poly-brain.strategy-review.v1"',
		);
		expect(POLY_BRAIN_RESPONSE_PROMPT).toContain(
			'"objective": "Poly learns which ethical profit strategy to test next"',
		);
		expect(POLY_BRAIN_RESPONSE_PROMPT).toContain(
			'"persistence": {"status": "committed"',
		);
		expect(POLY_BRAIN_RESPONSE_PROMPT).toContain(
			"no acknowledgement, prose, or markdown fences",
		);
	});

	it("does not expose out-of-budget or unconfigured research tools", () => {
		expect(POLY_BRAIN_TOOL_IDS).not.toContain("core__web_search");
		expect(POLY_BRAIN_TOOL_IDS).not.toContain("core__repo_list");
		expect(POLY_BRAIN_TOOL_IDS).not.toContain("core__repo_search");
		expect(POLY_BRAIN_TOOL_IDS).not.toContain("core__repo_open");
	});

	it("allows an honest uncited candidate hypothesis only when knowledge is empty", () => {
		const upgraded = POLY_BRAIN_STRATEGY_EVAL_SET_V1[1];
		const uncited = {
			...upgraded.run.structuredOutput,
			persistence: {
				...upgraded.run.structuredOutput.persistence,
				evidenceForIds: [],
			},
		};
		expect(PolyBrainStrategyReviewV1Schema.safeParse(uncited).success).toBe(
			false,
		);
		const candidateEmpty = {
			...uncited,
			comparedStrategies: [],
			nextExperiment: {
				strategyId: "canonical-evidence-bootstrap",
				title: "Restore canonical strategy evidence",
				hypothesis:
					"Restoring canonical evidence enables a grounded strategy comparison.",
				method: "Seed the candidate knowledge snapshot and rerun the review.",
				successCriterion: "Mission and strategy entries are retrieved.",
				failureCriterion: "Canonical entries remain unavailable.",
				timebox: "7 days",
				workItemIds: [],
			},
			gaps: ["canonical_knowledge_empty"],
		};
		expect(
			PolyBrainStrategyReviewV1Schema.safeParse(candidateEmpty).success,
		).toBe(true);

		const inventedStrategy = {
			...candidateEmpty,
			comparedStrategies: upgraded.run.structuredOutput.comparedStrategies,
		};
		expect(
			PolyBrainStrategyReviewV1Schema.safeParse(inventedStrategy).success,
		).toBe(false);
	});

	it("composes a runnable graph with the default typed response", () => {
		const fakeLlm = {
			invoke: async () => ({ content: "" }),
			withStructuredOutput: () => ({ invoke: async () => ({}) }),
		} as unknown as Parameters<typeof createPolyBrainGraph>[0]["llm"];
		const graph = createPolyBrainGraph({ llm: fakeLlm, tools: [] });
		expect(graph.invoke).toBeTypeOf("function");
	});
});

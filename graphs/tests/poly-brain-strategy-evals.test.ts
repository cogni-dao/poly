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
	POLY_BRAIN_STRATEGY_REVIEW_SCHEMA_VERSION,
	PolyBrainStrategyReviewV1Schema,
} from "../src/graphs/poly-brain/output-schema";
import { POLY_BRAIN_SYSTEM_PROMPT } from "../src/graphs/poly-brain/prompts";

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
		expect(POLY_BRAIN_STRATEGY_EVAL_SET_V1).toHaveLength(6);
	});

	it("requires the approved objective and exactly one selected experiment", () => {
		const upgraded = POLY_BRAIN_STRATEGY_EVAL_SET_V1[1];
		const output = PolyBrainStrategyReviewV1Schema.parse(
			upgraded.run.structuredOutput,
		);
		expect(output.objective).toBe(POLY_BRAIN_DAO_OBJECTIVE);
		expect(output.nextExperiment).not.toBeInstanceOf(Array);
		expect(output.persistence.status).toBe("committed");
		expect(output.persistence.sourceRef).toContain("schedule:story.5017:");
		expect(output.persistence.committed).toBe(true);
	});

	it("keeps the operating prompt evidence-first and non-trading", () => {
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain(POLY_BRAIN_DAO_OBJECTIVE);
		expect(POLY_BRAIN_SYSTEM_PROMPT).toContain("core__knowledge_search");
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
			"do not present them as runtime-stamped identity",
		);
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

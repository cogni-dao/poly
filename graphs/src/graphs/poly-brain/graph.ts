// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-graphs/graphs/poly-brain/graph`
 * Purpose: Recurring DAO-objective strategy-review graph factory.
 * Scope: Creates a LangGraph ReAct agent with a typed strategy-review output. Does not execute graphs or read env.
 * Invariants: Pure factory, TYPE_TRANSPARENT_RETURN, PACKAGES_NO_ENV.
 * Side-effects: none
 * Links: task.1791070993, story.5017
 * @public
 */

import type { CreateReactAgentGraphOptions } from "@cogni/langgraph-graphs/graphs";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { guardScheduledGraphTools } from "../guarded-edo-tool";
import {
	POLY_BRAIN_EVIDENCE_BOOTSTRAP_HYPOTHESIS_ID,
	PolyBrainStrategyReviewV1Schema,
} from "./output-schema";
import {
	POLY_BRAIN_RESPONSE_PROMPT,
	POLY_BRAIN_SYSTEM_PROMPT,
} from "./prompts";
import { POLY_BRAIN_TOOL_IDS } from "./tools";

export const POLY_BRAIN_GRAPH_NAME = "poly-brain" as const;

/**
 * Create Poly's recurring strategy-review agent.
 *
 * NOTE: Return type intentionally NOT annotated (TYPE_TRANSPARENT_RETURN).
 */
export function createPolyBrainGraph(opts: CreateReactAgentGraphOptions) {
	const { llm, tools, responseFormat } = opts;
	const allowedToolIds = new Set<string>(POLY_BRAIN_TOOL_IDS);

	return createReactAgent({
		llm,
		// Keep the graph's lean v1 budget enforceable even when an app-local
		// catalog temporarily grants a wider compatibility set.
		tools: guardScheduledGraphTools(tools, allowedToolIds, {
			domain: "strategy",
			sourceRef: "story.5017/poly-brain/v1",
			sourceNode: POLY_BRAIN_GRAPH_NAME,
			requiredTag: "strategy-research-v1",
			pinnedHypotheses: {
				[POLY_BRAIN_EVIDENCE_BOOTSTRAP_HYPOTHESIS_ID]: {
					title: "Restore canonical mission and strategy evidence",
					content:
						"If canonical mission and strategy evidence are restored, the next Poly Brain run can compare ethical-profit directions from grounded facts instead of selecting a strategy without evidence.",
					evidenceForIds: [],
				},
			},
		}),
		messageModifier: POLY_BRAIN_SYSTEM_PROMPT,
		responseFormat:
			responseFormat ??
			({
				prompt: POLY_BRAIN_RESPONSE_PROMPT,
				schema: PolyBrainStrategyReviewV1Schema,
			} as const),
	});
}

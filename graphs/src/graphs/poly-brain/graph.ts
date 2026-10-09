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
import { PolyBrainStrategyReviewV1Schema } from "./output-schema";
import { POLY_BRAIN_SYSTEM_PROMPT } from "./prompts";

export const POLY_BRAIN_GRAPH_NAME = "poly-brain" as const;

/**
 * Create Poly's recurring strategy-review agent.
 *
 * NOTE: Return type intentionally NOT annotated (TYPE_TRANSPARENT_RETURN).
 */
export function createPolyBrainGraph(opts: CreateReactAgentGraphOptions) {
	const { llm, tools, responseFormat } = opts;

	return createReactAgent({
		llm,
		tools: [...tools],
		messageModifier: POLY_BRAIN_SYSTEM_PROMPT,
		responseFormat:
			responseFormat ??
			({
				prompt:
					"Return only the final Poly strategy review. It must satisfy the poly-brain.strategy-review.v1 schema and reflect tool results from this run.",
				schema: PolyBrainStrategyReviewV1Schema,
			} as const),
	});
}

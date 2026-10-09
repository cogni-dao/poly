// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Node-local, GraphRunWorkflow-compatible algorithm evaluation graph. */
import type { CreateReactAgentGraphOptions } from "@cogni/langgraph-graphs/graphs";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import { PolyAlgorithmEvaluationReportSchema } from "./output-schema";
import {
	POLY_ALGORITHM_EVALUATION_RESPONSE_PROMPT,
	POLY_ALGORITHM_EVALUATION_SYSTEM_PROMPT,
} from "./prompts";

export const POLY_ALGORITHM_EVALUATION_GRAPH_NAME =
	"poly-algorithm-evaluation" as const;

/**
 * NOTE: Return type intentionally not annotated (TYPE_TRANSPARENT_RETURN).
 * The response schema is fixed here so Temporal schedules receive typed output
 * without serializing a Zod schema in their input payload.
 */
export function createPolyAlgorithmEvaluationGraph(
	opts: CreateReactAgentGraphOptions,
) {
	return createReactAgent({
		llm: opts.llm,
		tools: [...opts.tools],
		messageModifier: POLY_ALGORITHM_EVALUATION_SYSTEM_PROMPT,
		responseFormat: {
			prompt: POLY_ALGORITHM_EVALUATION_RESPONSE_PROMPT,
			schema: PolyAlgorithmEvaluationReportSchema,
		},
	});
}

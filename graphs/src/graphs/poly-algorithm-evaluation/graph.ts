// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Node-local, GraphRunWorkflow-compatible algorithm evaluation graph. */
import type { CreateReactAgentGraphOptions } from "@cogni/langgraph-graphs/graphs";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import { guardScheduledGraphTools } from "../guarded-edo-tool";
import { PolyAlgorithmEvaluationReportSchema } from "./output-schema";
import {
	POLY_ALGORITHM_EVALUATION_RESPONSE_PROMPT,
	POLY_ALGORITHM_EVALUATION_SYSTEM_PROMPT,
	POLY_ALGORITHM_EVIDENCE_BOOTSTRAP_HYPOTHESIS_ID,
} from "./prompts";
import { POLY_ALGORITHM_EVALUATION_TOOL_IDS } from "./tools";

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
	const allowedToolIds = new Set<string>(POLY_ALGORITHM_EVALUATION_TOOL_IDS);
	return createReactAgent({
		llm: opts.llm,
		tools: guardScheduledGraphTools(opts.tools, allowedToolIds, {
			domain: "strategy",
			sourceRef: "story.5017/poly-algorithm-evaluation/v1",
			sourceNode: POLY_ALGORITHM_EVALUATION_GRAPH_NAME,
			requiredTag: "algorithm-evaluation-v1",
			pinnedHypotheses: {
				[POLY_ALGORITHM_EVIDENCE_BOOTSTRAP_HYPOTHESIS_ID]: {
					title: "Restore canonical mission and algorithm evidence",
					content:
						"If canonical mission and algorithm evidence are restored, the next evaluation run can assess an exact algorithm identity from grounded facts without placing trades.",
					evidenceForIds: [],
				},
			},
		}),
		messageModifier: POLY_ALGORITHM_EVALUATION_SYSTEM_PROMPT,
		responseFormat: {
			prompt: POLY_ALGORITHM_EVALUATION_RESPONSE_PROMPT,
			schema: PolyAlgorithmEvaluationReportSchema,
		},
	});
}

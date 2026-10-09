// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Capability boundary for the algorithm-evaluation prototype. */
import {
	EDO_HYPOTHESIZE_NAME,
	GET_CURRENT_TIME_NAME,
	KNOWLEDGE_READ_NAME,
	KNOWLEDGE_SEARCH_NAME,
	REPO_LIST_NAME,
	REPO_OPEN_NAME,
	REPO_SEARCH_NAME,
} from "@cogni/ai-tools";

/**
 * Reads saved facts and durable guidance, then writes only EDO learning rows.
 * No generic knowledge, work-item, policy, target, wallet, or trading write is
 * present in this allowlist.
 */
export const POLY_ALGORITHM_EVALUATION_TOOL_IDS = [
	GET_CURRENT_TIME_NAME,
	KNOWLEDGE_SEARCH_NAME,
	KNOWLEDGE_READ_NAME,
	REPO_LIST_NAME,
	REPO_SEARCH_NAME,
	REPO_OPEN_NAME,
	EDO_HYPOTHESIZE_NAME,
] as const;

export type PolyAlgorithmEvaluationToolId =
	(typeof POLY_ALGORITHM_EVALUATION_TOOL_IDS)[number];

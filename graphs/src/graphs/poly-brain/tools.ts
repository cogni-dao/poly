// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-graphs/graphs/poly-brain/tools`
 * Purpose: Tool IDs the poly-brain strategy reviewer can use.
 * Scope: Exports tool capability metadata. Does not enforce policy.
 * Invariants: SINGLE_SOURCE_OF_TRUTH, CAPABILITY_NOT_POLICY.
 * Side-effects: none
 * Links: task.1791070993, story.5017
 * @public
 */

import {
	EDO_HYPOTHESIZE_NAME,
	GET_CURRENT_TIME_NAME,
	KNOWLEDGE_READ_NAME,
	KNOWLEDGE_SEARCH_NAME,
	REPO_LIST_NAME,
	REPO_OPEN_NAME,
	REPO_SEARCH_NAME,
	WEB_SEARCH_NAME,
	WORK_ITEM_QUERY_NAME,
} from "@cogni/ai-tools";

/**
 * The graph reads current time, node knowledge, work priorities, repository
 * evidence, and the web. Its sole write is one falsifiable EDO hypothesis for
 * the selected next experiment.
 *
 * Deliberately absent: knowledge_write, work_item_transition, schedule_manage,
 * wallet/policy/order/trade tools, and the other EDO mutation tools.
 */
export const POLY_BRAIN_TOOL_IDS = [
	GET_CURRENT_TIME_NAME,
	KNOWLEDGE_SEARCH_NAME,
	KNOWLEDGE_READ_NAME,
	WORK_ITEM_QUERY_NAME,
	REPO_LIST_NAME,
	REPO_SEARCH_NAME,
	REPO_OPEN_NAME,
	WEB_SEARCH_NAME,
	EDO_HYPOTHESIZE_NAME,
] as const;

export type PolyBrainToolId = (typeof POLY_BRAIN_TOOL_IDS)[number];

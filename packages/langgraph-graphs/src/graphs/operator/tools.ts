// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/operator/tools`
 * Purpose: Tool IDs for operator roles (Operating Review, Git Reviewer).
 * Scope: Exports tool capability metadata. Does NOT enforce policy.
 * Invariants:
 *   - SINGLE_SOURCE_OF_TRUTH: This is THE list of tools each operator role can use
 *   - CAPABILITY_NOT_POLICY: These are capabilities, not authorization
 * Side-effects: none
 * Links: agent-roles spec, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/tool-use.md
 * @public
 */

import {
  GET_CURRENT_TIME_NAME,
  METRICS_QUERY_NAME,
  SCHEDULE_LIST_NAME,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_READ_NAME,
} from "@cogni/ai-tools";

/**
 * Tool IDs for Operating Review.
 * Read-only on work items: query and read. The released ai-tools no longer ships core__work_item_transition, and poly
 * offers no program the full-schema core__work_item_update until the program plumbing is ported.
 * Schedule read-only (no SCHEDULE_MANAGE — planner must not modify its own schedule).
 */
export const OPERATING_REVIEW_TOOL_IDS = [
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_READ_NAME,
  GET_CURRENT_TIME_NAME,
  METRICS_QUERY_NAME,
  SCHEDULE_LIST_NAME,
] as const;

/**
 * Tool IDs for Git Reviewer.
 * Currently a queue observer only — no GitHub API access.
 * GitHub PR tools (read, comment) will be added when implemented.
 */
export const GIT_REVIEWER_TOOL_IDS = [GET_CURRENT_TIME_NAME] as const;

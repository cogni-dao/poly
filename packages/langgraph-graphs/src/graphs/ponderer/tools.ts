// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/ponderer/tools`
 * Purpose: Tool IDs for ponderer graph (single source of truth).
 * Scope: Exports tool capability metadata. Does NOT enforce policy (that's ToolRunner's job).
 * Invariants:
 *   - SINGLE_SOURCE_OF_TRUTH: This is THE list of tools ponderer can use
 *   - CAPABILITY_NOT_POLICY: These are capabilities, not authorization
 * Side-effects: none
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/tool-use.md, https://node-template.cognidao.org/knowledge/graph-execution-invariants
 * @public
 */

import { GET_CURRENT_TIME_NAME, METRICS_QUERY_NAME } from "@cogni/ai-tools";

/**
 * Tool IDs for ponderer graph.
 * Single source of truth - imported by server.ts, cogni-exec.ts, and catalog.ts.
 */
export const PONDERER_TOOL_IDS = [
  GET_CURRENT_TIME_NAME,
  METRICS_QUERY_NAME,
] as const;

/**
 * Type for ponderer tool IDs.
 */
export type PondererToolId = (typeof PONDERER_TOOL_IDS)[number];

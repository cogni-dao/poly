// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/brain/graph`
 * Purpose: Code-aware agent graph factory with repository tools.
 * Scope: Creates LangGraph React agent with repo-aware system prompt. Does NOT execute graphs or read env.
 * Invariants:
 *   - Pure factory function — no side effects, no env reads
 *   - LLM and tools are injected, not instantiated
 *   - TYPE_TRANSPARENT_RETURN: No explicit return type annotation to preserve CompiledStateGraph for CLI schema extraction
 * Side-effects: none
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/cogni-brain.md, https://node-template.cognidao.org/knowledge/graph-execution-invariants
 * @public
 */

import { MessagesAnnotation } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import type { CreateReactAgentGraphOptions } from "../types";
import { BRAIN_SYSTEM_PROMPT } from "./prompts";

/**
 * Graph name constant for routing.
 */
export const BRAIN_GRAPH_NAME = "brain" as const;

/**
 * Create a code-aware brain agent graph.
 *
 * Single ReAct agent with repository search and file access tools.
 * Uses createReactAgent with tool-calling loop.
 *
 * NOTE: Return type is intentionally NOT annotated to preserve the concrete
 * CompiledStateGraph type for LangGraph CLI schema extraction.
 *
 * @param opts - Options with LLM and tools
 * @returns Compiled LangGraph ready for invoke()
 */
export function createBrainGraph(opts: CreateReactAgentGraphOptions) {
  const { llm, tools } = opts;

  return createReactAgent({
    llm,
    tools: [...tools], // Spread readonly array to mutable for LangGraph
    messageModifier: BRAIN_SYSTEM_PROMPT,
    stateSchema: MessagesAnnotation,
  });
}

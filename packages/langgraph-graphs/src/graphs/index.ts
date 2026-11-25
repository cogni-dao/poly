// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs`
 * Purpose: Barrel export for graph factories and shared types.
 * Scope: Graph creation functions and type definitions. Does NOT include runners (those live in src/).
 * Invariants:
 *   - Graphs are pure factories — no side effects, no env reads
 *   - All LangChain graph creation code lives here
 *   - Shared types prevent per-graph interface duplication
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/graph-execution-invariants, https://node-template.cognidao.org/knowledge/agent-development
 * @public
 */

// Autoresearch graphs (Karpathy-style experiment loops)
export type {
  CreateReactAgentGraphOptions,
  GraphInvokeOptions,
  InvokableGraph,
  MessageGraphInput,
  MessageGraphOutput,
} from "./types";

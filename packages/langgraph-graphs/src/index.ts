// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs`
 * Purpose: Barrel export for LangGraph graph definitions and runtime utilities.
 * Scope: Re-exports public types. All @langchain/* code lives here (per NO_LANGCHAIN_IN_SRC). Does not contain implementation logic.
 * Invariants:
 *   - SINGLE_SOURCE_OF_TRUTH: These are the canonical LangGraph definitions
 *   - NO_LANGCHAIN_IN_SRC: Only this package imports @langchain/*
 *   - PACKAGES_NO_SRC_IMPORTS: Never import from src/
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/graph-execution-invariants
 * @public
 */

// Re-export graph ids (the node's one composed catalog is built in the app with `createNodeCatalog`)
export {
  DEFAULT_LANGGRAPH_GRAPH_ID,
  LANGGRAPH_GRAPH_IDS,
  LANGGRAPH_PROVIDER_ID,
  type LangGraphGraphId,
} from "./catalog";
// The in-process provider, runner, catalog composer and their ports are the published package's: one import path for the node, no copy.
export type {
  CatalogEntry,
  LangGraphCatalog,
} from "@cogni/shared-langgraph-graphs";
export { LANGGRAPH_CATALOG as SHARED_LANGGRAPH_CATALOG } from "@cogni/shared-langgraph-graphs";
export type {
  AgentAuthorityPort,
  CodingCallerPolicy,
  CompletionFn,
  CompletionResult,
  CompletionUnitFinal,
  CompletionUnitParams,
  CompletionUnitPort,
  CreateGraphFn,
  GraphResult,
  InProcGraphRequest,
  InProcProviderDeps,
  InProcRunnerOptions,
  Message,
  NodeCatalogChanges,
  Persistence,
  ProviderLogger,
  RunScope,
  RunScopePort,
  SourceContext,
  ToolExecFn,
  ToolExecResult,
} from "@cogni/shared-langgraph-graphs/inproc";
export {
  createInProcGraphRunner,
  createLangGraphInProcProvider,
  createNodeCatalog,
  INPROC_EVENTS,
  LANGGRAPH_INPROC_PROVIDER_ID,
  requiresInProcess,
  resolveNodeSourceContext,
} from "@cogni/shared-langgraph-graphs/inproc";
// Re-export runtime types (interfaces only, not implementations)
export type { MakeLangChainToolOptions } from "./runtime/index";
export type { McpServerConfig, McpServersConfig } from "./runtime/mcp/index";
// Re-export MCP client utilities + tool source
export {
  loadMcpTools,
  McpToolSource,
  parseMcpConfigFromEnv,
} from "./runtime/mcp/index";

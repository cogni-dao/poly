// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/runtime`
 * Purpose: LangChain runtime utilities for graph execution.
 * Scope: Re-exports from core/ (generic) and cogni/ (Cogni executor-specific). Does NOT contain implementation logic.
 * Invariants:
 *   - CORE_NO_ALS: core/ modules have no ALS dependencies
 *   - COGNI_USES_ALS: cogni/ modules use CogniExecContext (AsyncLocalStorage)
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/graph-execution-invariants, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/tool-use.md
 * @public
 */

// ============================================================================
// Core (generic, no ALS)
// ============================================================================

export {
  // Async queue
  AsyncQueue,
  // Tool wrappers
  type ExecResolver,
  // Message types
  fromBaseMessage,
  type MakeLangChainToolOptions,
  type MakeLangChainToolsOptions,
  // Server graph helper
  type Message,
  type MessageToolCall,
  makeLangChainTool,
  makeLangChainTools,
  makeServerGraph,
  type ToLangChainToolsCapturedOptions,
  type ToolExecFn,
  type ToolExecResult,
  toBaseMessage,
  toLangChainToolsCaptured,
} from "./core";

// ============================================================================
// Cogni executor-specific (uses ALS)
// ============================================================================

export {
  // Completion adapter
  CogniCompletionAdapter,
  // Execution context
  type CogniExecContext,
  type CompletionFn,
  type CompletionResult,
  getCogniExecContext,
  hasCogniExecContext,
  // Cogni graph helper
  makeCogniGraph,
  runWithCogniExecContext,
  type TokenSink,
  type ToLangChainToolsFromContextOptions,
  type ToolCall,
  toLangChainToolsFromContext,
} from "./cogni";

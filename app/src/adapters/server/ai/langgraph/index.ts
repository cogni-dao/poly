// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/langgraph`
 * Purpose: Barrel export for LangGraph adapter components.
 * Scope: Re-exports provider, catalog types. Isolates LangGraph concerns. Does NOT export @langchain/* types.
 * Invariants:
 *   - NO_LANGCHAIN_IN_ADAPTERS_ROOT: LangChain imports only in this directory
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/graph-execution-invariants, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/agent-discovery.md
 * @public
 */

// Catalog types (generic, no inproc imports)
export type { LangGraphCatalog, LangGraphCatalogEntry } from "./catalog";
export type {
  LangGraphDevClientConfig,
  LangGraphDevProviderConfig,
} from "./dev";
// Dev server providers (langgraph dev, port 2024)
export {
  createLangGraphDevClient,
  LangGraphDevAgentCatalogProvider,
  LangGraphDevProvider,
} from "./dev";
// Execution provider (requires CompletionUnitAdapter)
export {
  type CompletionUnitAdapter,
  LANGGRAPH_PROVIDER_ID,
  LangGraphInProcProvider,
} from "./inproc.provider";
// Discovery-only provider (no execution deps)
export {
  LANGGRAPH_PROVIDER_ID as LANGGRAPH_INPROC_AGENT_CATALOG_PROVIDER_ID,
  LangGraphInProcAgentCatalogProvider,
} from "./inproc-agent-catalog.provider";

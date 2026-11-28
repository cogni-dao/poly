// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/langgraph/inproc.provider`
 * Purpose: Poly's adapter over the shared in-process LangGraph provider (`@cogni-dao/langgraph-graphs/inproc`, through `@cogni/langgraph-graphs`).
 * Scope: Binds Poly's ports (billed completion adapter, execution scope, logger, trace id, model allow-list) to the package provider, and composes the tool source per request. Holds no guard, audience, denial, catalog or runner logic; `tests/meta/inproc-provider-no-local-guard.test.ts` fails if it grows any.
 * Invariants:
 *   - NO_LOCAL_PROVIDER_LOGIC: the tool guard, principal lock, audience filter, terminal denial, MCP resolution and run runner live in the package; this file only wires
 *   - NO_LANGCHAIN_IN_SRC: no @langchain imports
 *   - GRAPH_ID_NAMESPACED: graphId format is "langgraph:${graphName}"
 *   - PER_REQUEST_COMPOSITION: the provider is cheap to build and never caches its tool source. Poly builds a principal-scoped tool source per request and, when the run needs its model bound into a tool (`composeTools`), one provider per run
 *   - ONE_COMPOSED_CATALOG: the catalog is the node's one composed catalog (`@bootstrap/ai/node-catalog`), injected here
 * Side-effects: none at import
 * Links: https://node-template.cognidao.org/knowledge/inproc-provider-package-design, https://node-template.cognidao.org/knowledge/graph-execution-invariants
 * @internal
 */

import type { ToolSourcePort } from "@cogni/ai-core";
import type { CatalogBoundTool } from "@cogni/ai-tools";
import {
  type AgentAuthorityPort,
  type CodingCallerPolicy,
  type CompletionUnitPort,
  createLangGraphInProcProvider,
  type InProcProviderDeps,
  type LangGraphCatalog,
  type Persistence,
  type ProviderLogger,
  type RunScopePort,
  type SourceContext,
} from "@cogni/langgraph-graphs";
import { trace } from "@opentelemetry/api";
import {
  getExecutionScope,
  runInScope,
} from "@/adapters/server/ai/execution-scope";
import type {
  ExecutionContext,
  GraphExecutorPort,
  GraphRunRequest,
  GraphRunResult,
  LlmToolDefinition,
} from "@/ports";
import { isModelAllowed } from "@/shared/ai/model-catalog.server";
import { makeLogger } from "@/shared/observability";

export const LANGGRAPH_PROVIDER_ID = "langgraph" as const;

/** Poly's billed completion adapter (`InProcCompletionUnitAdapter`), seen as the package port. */
export type CompletionUnitAdapter = CompletionUnitPort<LlmToolDefinition>;

/**
 * Poly's tool contracts, seen as the package's. Poly's `@cogni/ai-tools` is a local wrapper whose contracts also accept zod v3
 * schemas; the package types the same contracts against the published `@cogni/ai-tools`. The provider reads only `effect`, `requires`,
 * `secretArgs` and the name from them, so the seam is structural at runtime; this is the one place the types are joined.
 */
export function packageToolBundle(
  bundle: readonly CatalogBoundTool[]
): InProcProviderDeps["toolBundle"] {
  return bundle as unknown as InProcProviderDeps["toolBundle"];
}

/** The tool source and tool contracts one run sees. */
export interface RunTools {
  readonly tools: ToolSourcePort;
  readonly toolBundle: readonly CatalogBoundTool[];
}

/** What Poly injects. Everything the provider needs from Poly arrives here. */
export interface PolyProviderWiring {
  /** Poly's one composed catalog (`POLY_NODE_LANGGRAPH_CATALOG`). */
  readonly catalog: LangGraphCatalog;
  readonly completion: CompletionUnitAdapter;
  readonly tools: ToolSourcePort;
  readonly toolBundle: readonly CatalogBoundTool[];
  readonly mcpTools?: () => Promise<ToolSourcePort | null>;
  readonly authority?: AgentAuthorityPort;
  readonly sourceContext?: (required: boolean) => Promise<SourceContext>;
  readonly persistence?: () => Promise<Persistence>;
  readonly coding?: CodingCallerPolicy;
  /** The tool source and contracts for this run. Absent: `tools` and `toolBundle` as given. */
  readonly composeTools?: (req: GraphRunRequest) => RunTools;
  readonly log?: ProviderLogger;
}

/** Poly's run scope (`ExecutionScope`) seen as the package's `RunScopePort`. The launcher sets `actorUserId`; that caller is the run's subject. */
const polyRunScope: RunScopePort = {
  current() {
    const scope = getExecutionScope();
    return {
      subjectUserId: scope.subjectUserId ?? scope.actorUserId,
      accountId: scope.billing.billingAccountId,
      abortSignal: scope.abortSignal,
      runAs: (identity, fn) =>
        runInScope(
          {
            ...scope,
            runId: identity.runId,
            ...(identity.principalId
              ? { principalId: identity.principalId }
              : {}),
            ...(identity.subjectUserId
              ? { subjectUserId: identity.subjectUserId }
              : {}),
          },
          fn
        ),
    };
  },
};

export class LangGraphInProcProvider implements GraphExecutorPort {
  readonly providerId = LANGGRAPH_PROVIDER_ID;

  constructor(private readonly wiring: PolyProviderWiring) {}

  runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult {
    const w = this.wiring;
    const { tools, toolBundle } = w.composeTools?.(req) ?? w;
    return createLangGraphInProcProvider<LlmToolDefinition>({
      catalog: w.catalog,
      completion: w.completion,
      tools,
      toolBundle: packageToolBundle(toolBundle),
      scope: polyRunScope,
      log: w.log ?? makeLogger({ component: "LangGraphInProcProvider" }),
      isChildModelAllowed: isModelAllowed,
      traceId: () => trace.getActiveSpan()?.spanContext().traceId,
      ...(w.mcpTools && { mcpTools: w.mcpTools }),
      ...(w.sourceContext && { sourceContext: w.sourceContext }),
      ...(w.persistence && { persistence: w.persistence }),
      ...(w.authority && { authority: w.authority }),
      ...(w.coding && { coding: w.coding }),
    }).runGraph(req, ctx);
  }
}

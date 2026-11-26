// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/langgraph/inproc.provider`
 * Purpose: LangGraph in-process graph provider for Next.js runtime.
 * Scope: Routes graph execution to package runner. Does NOT import @langchain/* directly — all LangChain in package.
 * Invariants:
 *   - NO_LANGCHAIN_IN_SRC: No @langchain imports; delegates to package runner
 *   - GRAPH_ID_NAMESPACED: graphId format is "langgraph:${graphName}"
 *   - NODE_RUNTIME_CATALOG_BOUNDARY: the catalog is a CONSTRUCTOR ARGUMENT, not an
 *     import. Graph sets and per-graph tool allowlists are app runtime policy, so
 *     the node composes them in `@bootstrap/ai/node-catalog` and injects them
 *     here; the shared @cogni/langgraph-graphs catalog is only the default. On the
 *     poly node that injection is what makes `langgraph:poly-brain` resolve
 *     instead of returning `not_found`.
 *   - TOOL_SOURCE_MAY_BE_COMPOSED: the injected toolSource is whatever bootstrap
 *     composed, which for in-process runs is a per-request principal-scoped
 *     overlay in front of the container source. This provider stays unaware of
 *     principals: it resolves tool ids and nothing else.
 *   - NODE_BUNDLE_IS_CANONICAL: Resolves BoundTool from injected node bundle (CORE_TOOL_BUNDLE [+ POLY_TOOL_BUNDLE for poly]); never iterates the global TOOL_CATALOG (which is per-package and can drift behind per-node bundles).
 *   - DENY_BY_DEFAULT: Tool policy explicitly provided per graph
 *   - MCP_VIA_ASYNC_SOURCE: MCP tools resolved via async getMcpToolSource() function (shared cache with reconnect-on-error)
 * Side-effects: IO (executes graphs via package runner, MCP tool resolution via HTTP)
 * Notes: Discovery is in LangGraphInProcAgentCatalogProvider, not here.
 * Links: https://node-template.cognidao.org/knowledge/graph-execution-invariants
 *
 * SOURCE PORT RECORD (https://cognidao.org/knowledge/port-node-source-once; story.0090, task.0204 item 4 / task.0175 Stage 4). A recorded literal source port, not a sync lane.
 *   - Source revision: node-template main 2157e635 (#468, the agent-grants 0.10.0 / sandbox 0.3.0 release), as adopted by red#88 at head d73090d4 (red's merge
 *     commit once #88 merges; the wiring shape, not a second source of truth). The ported hunks are red's `60609d3` harness state, 3-way merged onto Poly's base.
 *   - Source symbols and destinations (every literal port; nothing else is copied):
 *       adapters/server/ai/langgraph/inproc.provider.ts   `LANGGRAPH_PROVIDER_ID`, `CompletionUnitAdapter`, `SharedCogniDeps`, `LangGraphInProcProvider`
 *                                                          (guard wrap, `offeredToolIds`, terminal-denial abort, coding-audience check, forced-exec recheck)
 *       adapters/server/ai/langgraph/source-context.ts    `loadCogniSourceContext` (node-template `resolveNodeSourceContext` semantics)
 *       adapters/server/ai/langgraph/dispatch.ts          `createLangGraphDispatch` (cogni always in process; other graphs keep dev routing)
 *       adapters/server/ai/execution-scope.ts             the `runId`, `principalId`, `subjectUserId` additions to `ExecutionScope`
 *       bootstrap/graph-executor.factory.ts               the shared-run composition in `createInProcProvider` (`sharedTools`, authority, `sandboxReady`, source context)
 *       bootstrap/chat-actor-proof.ts                     the authenticated-actor proof the audience check reads
 *       bootstrap/capabilities/schedule-model.ts          `bindScheduleModel` (the released schedule tools run with the run's model)
 *       app/_facades/ai/completion.server.ts              the durable-claim and actor hunks (`acceptanceMode: "workflow-start"`, claim key)
 *       app/api/internal/graphs/[graphId]/runs/route.ts   the claim-verified receiver hunks
 *       app/(admin)/_lib/admin-session.ts                 the one AdminSession mint, incl. the cookie-write origin fix (red@512cafc7: Origin vs x-forwarded-host/host)
 *       shared/observability/db-error-fields.ts           `failureFields`, handed to the agent-grants host as its error-field hook
 *   - Reuse: node-template (source), Red and Poly today; task.0175 lists beacon, toks5, levelup and the operator as further holders, so expected reuse is five or more.
 *     Change frequency is high: every guard, scope or catalog change has touched it.
 *   - Prospective package API: hub atom `inproc-provider-package-design` in the design inbox
 *     https://node-template.cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-6e422af6 (task.0175 Stage 4); its API is the contract and is not restated here.
 *     Node-local after extraction: `ExecutionScope` filling, the completion adapter, MCP source wiring, Poly's injected catalog and per-request principal tool source, graph prompts.
 *   - Why not now: no published package carries the provider yet (agent-grants/host, work-items and sandbox 0.3.0 do not), a codemod cannot move a diverged 700-line file,
 *     and a pinned workflow would rewrite node-owned hunks.
 *   - Divergences from the source, all node-owned: the injected node catalog (5th constructor argument) and the per-request principal tool source (Poly); the cogni
 *     coordinator prompt is rewritten in `packages/langgraph-graphs/src/catalog.ts` to name only the workflows Poly runs (no `work-closeout`; the prioritizer without its
 *     write tools), because the released prompt embeds the template's workflow list.
 *   - Exit: task.0175 Stage 4. Extraction is forced by the first second cross-repo fix to this file, or by the package release that exports the provider, whichever is first.
 * @internal
 */

import {
  type GuardDeps,
  guardTools,
  offeredToolIds,
  type ToolRequires,
} from "@cogni/agent-grants";
import type { AiEvent, BoundToolRuntime, ToolSourcePort } from "@cogni/ai-core";
import {
  createStaticToolSourceFromRecord,
  createToolAllowlistPolicy,
  createToolRunner,
} from "@cogni/ai-core";
import type { CatalogBoundTool } from "@cogni/ai-tools";
import {
  type CompletionFn,
  type CreateGraphFn,
  createInProcGraphRunner,
  createSharedInProcGraphRunner,
  type GraphResult,
  type InProcGraphRequest,
  LANGGRAPH_CATALOG,
  SHARED_NODE_CATALOG,
  type SharedRunnerOptions,
  type ToolExecFn,
} from "@cogni/langgraph-graphs";
import { trace } from "@opentelemetry/api";
import type { Logger } from "pino";
import {
  getExecutionScope,
  runInScope,
} from "@/adapters/server/ai/execution-scope";
import type {
  AiExecutionErrorCode,
  CompletionFinalResult,
  ExecutionContext,
  GraphExecutorPort,
  GraphFinal,
  GraphRunRequest,
  GraphRunResult,
  LlmToolDefinition,
  Message,
} from "@/ports";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

import type { CompletionUnitParams } from "../inproc-completion-unit.adapter";

import type { LangGraphCatalog } from "./catalog";

/**
 * Provider ID for LangGraph in-process execution.
 */
export const LANGGRAPH_PROVIDER_ID = "langgraph" as const;

/**
 * Adapter interface for executing completion units.
 * Matches InProcCompletionUnitAdapter.executeCompletionUnit signature.
 */
export interface CompletionUnitAdapter {
  executeCompletionUnit(params: CompletionUnitParams): {
    stream: AsyncIterable<AiEvent>;
    final: Promise<CompletionFinalResult>;
  };
}

/**
 * Catalog entry shape (matches LangGraphCatalogEntry<CreateGraphFn>).
 * Per NODE_BUNDLE_IS_CANONICAL: tools referenced by ID, resolved from the injected node bundle.
 */
interface ProviderCatalogEntry {
  readonly displayName: string;
  readonly sharedRuntime?: boolean;
  readonly description: string;
  readonly toolIds: readonly string[];
  readonly mcpServerIds?: readonly string[];
  readonly graphFactory: CreateGraphFn;
  readonly systemPrompt?: string;
}

/**
 * LangGraph in-process provider.
 *
 * Routes graph execution to package runner (createInProcGraphRunner).
 * All LangChain logic is in the package — this provider is LangChain-free.
 *
 * Per GRAPH_LLM_VIA_COMPLETION: all LLM calls go through adapter.executeCompletionUnit
 * for billing/telemetry centralization.
 *
 * Note: Discovery (listAgents) is in LangGraphInProcAgentCatalogProvider.
 */
export interface SharedCogniDeps {
  readonly sharedTools?: (req: GraphRunRequest) => Readonly<
    Record<
      string,
      {
        readonly contract: CatalogBoundTool["contract"];
        readonly runtime: BoundToolRuntime;
      }
    >
  >;
  readonly resolvePrincipal: (slug: string) => Promise<string | null>;
  readonly guardDeps: Omit<GuardDeps, "runAs">;
  readonly sourceContext: () => Promise<
    NonNullable<SharedRunnerOptions["sourceContext"]>
  >;
  readonly isCodingActor: (actor: string) => boolean;
  readonly sandboxReady: () => boolean;
}

export class LangGraphInProcProvider implements GraphExecutorPort {
  readonly providerId = LANGGRAPH_PROVIDER_ID;
  private readonly log: Logger;
  private readonly catalog: LangGraphCatalog<CreateGraphFn>;
  private readonly boundToolMap: ReadonlyMap<string, CatalogBoundTool>;

  constructor(
    private readonly adapter: CompletionUnitAdapter,
    private readonly toolSource: ToolSourcePort,
    private readonly getMcpToolSource: () => Promise<ToolSourcePort | null> = () =>
      Promise.resolve(null),
    nodeBundle: readonly CatalogBoundTool[] = [],
    /**
     * This node's catalog, INJECTED. Per NODE_RUNTIME_CATALOG_BOUNDARY the graph
     * set plus each graph's tool allowlist is app runtime policy, so it is
     * composed at the bootstrap composition root (`@bootstrap/ai/node-catalog`)
     * and handed in here. That keeps this adapter node-agnostic AND leaves the
     * catalog free to name an app-local tool id, which it could not do if this
     * module imported it — `adapters` must not import `features`.
     *
     * Defaults to the shared base catalog, so a caller with no node policy (and
     * every existing test) behaves exactly as before.
     */
    catalog: LangGraphCatalog<CreateGraphFn> =
      LANGGRAPH_CATALOG as LangGraphCatalog<CreateGraphFn>,
    private readonly sharedCogni?: SharedCogniDeps,
  ) {
    this.log = makeLogger({ component: "LangGraphInProcProvider" });
    this.boundToolMap = new Map(nodeBundle.map((bt) => [bt.contract.name, bt]));

    this.catalog = catalog;

    this.log.debug(
      {
        graphCount: Object.keys(this.catalog).length,
        graphs: Object.keys(this.catalog),
      },
      "LangGraphInProcProvider initialized",
    );
  }

  runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult {
    const { runId, messages, modelRef, graphId } = req;
    const model = modelRef.modelId;
    const scope = getExecutionScope();
    const requestId = ctx?.requestId ?? req.runId;

    // Extract graph name from graphId (e.g., "langgraph:cogni" → "cogni")
    const graphName = this.extractGraphName(graphId);
    if (!graphName) {
      this.log.error({ runId, graphId }, "Invalid graphId format");
      // Client error: malformed graphId
      return this.createErrorResult(runId, requestId, "invalid_request");
    }

    const entry = this.catalog[graphName] as ProviderCatalogEntry | undefined;
    if (!entry) {
      this.log.error({ runId, graphName }, "Graph not found in catalog");
      // Client error: graph doesn't exist
      return this.createErrorResult(runId, requestId, "not_found");
    }

    if (entry.sharedRuntime) return this.runSharedCogni(req, ctx);

    this.log.debug(
      { runId, graphName, model, messageCount: messages.length },
      "LangGraphInProcProvider.runGraph routing to package runner",
    );

    // Create completion function wrapping adapter
    const completionFn = this.createCompletionFn(req);

    // P0 Contract: undefined => catalog default, [] => deny-all, [...] => exact
    const catalogToolIds = entry.toolIds;
    const toolIds: readonly string[] = req.toolIds ?? catalogToolIds;
    if (req.toolIds === undefined) {
      this.log.debug(
        { runId, graphName, catalogToolIds },
        "toolIds undefined; using catalog default per P0 contract",
      );
    }

    // Resolve BoundToolRuntime from injected toolSource (per TOOL_SOURCE_RETURNS_BOUND_TOOL)
    // Per CAPABILITY_INJECTION: toolSource contains real implementations with I/O
    const runtimeTools: Record<string, BoundToolRuntime> = {};
    for (const toolId of catalogToolIds) {
      const runtime = this.toolSource.getBoundTool(toolId);
      if (runtime) {
        runtimeTools[toolId] = runtime;
      } else {
        this.log.error(
          { runId, graphName, toolId },
          "Tool not found in toolSource; graph misconfigured",
        );
      }
    }

    // Resolve MCP tools if this graph declares mcpServerIds.
    // getMcpToolSource() is async (shared cache with reconnect-on-error),
    // so we wrap the graph execution in a promise and stream from it.
    const mcpServerIds = entry.mcpServerIds ?? [];

    // Async helper: resolve MCP tools then execute graph
    const resolveMcpAndExecute = async (): Promise<{
      stream: AsyncIterable<AiEvent>;
      final: Promise<GraphResult>;
    }> => {
      const mcpToolIds: string[] = [];
      if (mcpServerIds.length > 0) {
        const mcpToolSource = await this.getMcpToolSource();
        if (mcpToolSource) {
          for (const serverId of mcpServerIds) {
            for (const spec of mcpToolSource.listToolSpecs()) {
              if (spec.name.startsWith(`${serverId}__`)) {
                const runtime = mcpToolSource.getBoundTool(spec.name);
                if (runtime) {
                  runtimeTools[spec.name] = runtime;
                  mcpToolIds.push(spec.name);
                }
              }
            }
          }
          if (mcpToolIds.length > 0) {
            this.log.debug(
              {
                runId,
                graphName,
                mcpServerIds,
                mcpToolCount: mcpToolIds.length,
              },
              "Resolved MCP tools for graph",
            );
          }
        }
      }

      // Combined tool IDs for allowlist: native catalog tools + MCP tools
      const allToolIds = [...toolIds, ...mcpToolIds];

      // Get catalog tools for contract extraction from the injected node bundle
      // (per NODE_BUNDLE_IS_CANONICAL — TOOL_CATALOG only has core tools post-bug.0319 ckpt 2)
      const catalogTools = catalogToolIds
        .map((id) => this.boundToolMap.get(id))
        .filter((bt): bt is NonNullable<typeof bt> => bt !== undefined);

      // Create tool execution function factory
      // Policy allowlist includes both native and MCP tool IDs
      const createToolExecFn = (emit: (e: AiEvent) => void): ToolExecFn => {
        const policy = createToolAllowlistPolicy(allToolIds);
        const source = createStaticToolSourceFromRecord(runtimeTools);
        const toolRunner = createToolRunner(source, emit, {
          policy,
          ctx: { runId },
        });

        return async (name, args, toolCallId) => {
          const result =
            toolCallId !== undefined
              ? await toolRunner.exec(name, args, {
                  modelToolCallId: toolCallId,
                })
              : await toolRunner.exec(name, args);
          if (!result.ok) {
            this.log.warn(
              {
                event: EVENT_NAMES.AI_TOOL_CALL_ERROR,
                runId,
                graphName,
                tool: name,
                errorCode: result.errorCode,
                safeMessage: result.safeMessage.slice(0, 300),
              },
              "tool call failed",
            );
          }
          return result;
        };
      };

      const toolContracts = catalogTools.map((bt) => bt.contract);

      const mcpToolSpecs = mcpToolIds
        .map((id) => runtimeTools[id]?.spec)
        .filter((s): s is NonNullable<typeof s> => s !== undefined);

      const traceId =
        trace.getActiveSpan()?.spanContext().traceId ??
        "00000000000000000000000000000000";
      const runnerRequest: InProcGraphRequest = {
        runId,
        messages: messages as InProcGraphRequest["messages"],
        ...(scope.abortSignal !== undefined && {
          abortSignal: scope.abortSignal,
        }),
        ...(traceId !== undefined && { traceId }),
        ...(requestId !== undefined && { ingressRequestId: requestId }),
        configurable: { model, toolIds },
      };

      return createInProcGraphRunner({
        createGraph: entry.graphFactory,
        completionFn,
        createToolExecFn,
        // Local contracts carry node-owned zod types; the runner reads only the erased contract shape.
        toolContracts: toolContracts as unknown as Parameters<
          typeof createInProcGraphRunner
        >[0]["toolContracts"],
        ...(mcpToolSpecs.length > 0 && { mcpToolSpecs }),
        request: runnerRequest,
        ...(req.responseFormat !== undefined && {
          responseFormat: req.responseFormat,
        }),
        ...(entry.systemPrompt !== undefined && {
          systemPrompt: entry.systemPrompt,
        }),
      });
    };

    // Execute: resolve MCP (if needed) then run graph.
    // Returns {stream, final} synchronously per GraphRunResult contract;
    // the inner async generator awaits the promise.
    const innerResult = resolveMcpAndExecute();

    const stream = (async function* () {
      let inner: Awaited<ReturnType<typeof resolveMcpAndExecute>>;
      try {
        inner = await innerResult;
      } catch {
        yield {
          type: "error" as const,
          error: "internal" as AiExecutionErrorCode,
        };
        yield { type: "done" as const };
        return;
      }
      yield* inner.stream;
    })();

    const final = innerResult.then(
      (r) => this.mapToGraphFinal(r.final, runId, requestId, graphName),
      () =>
        ({
          ok: false as const,
          runId,
          requestId,
          error: "internal",
        }) as const,
    );

    // mapToGraphFinal returns Promise<GraphFinal>, so final is Promise<Promise<GraphFinal> | GraphFinal>
    // Flatten with .then()
    const flatFinal = final.then((f) => f);

    return { stream, final: flatFinal };
  }

  private runSharedCogni(
    req: GraphRunRequest,
    ctx?: ExecutionContext,
  ): GraphRunResult {
    const scope = getExecutionScope();
    const runId = req.runId;
    const requestId = ctx?.requestId ?? runId;
    const actor = ctx?.actorUserId;
    const entry = SHARED_NODE_CATALOG.cogni;
    const deps = this.sharedCogni;
    const shell = "core__sandbox_shell";
    const execute = async () => {
      if (
        !deps ||
        !actor ||
        scope.actorUserId !== actor ||
        !entry.principal ||
        !entry.program
      )
        throw new Error("shared_identity_unavailable");
      const principalId = await deps.resolvePrincipal(entry.principal);
      if (!principalId) throw new Error("shared_principal_unavailable");
      const sourceContext = await deps.sourceContext();
      const audience = deps.isCodingActor(actor);
      const sharedTools = deps.sharedTools?.(req);
      const requested = new Set(req.toolIds ?? entry.toolIds);
      const ids = entry.toolIds.filter((id) => requested.has(id));
      const runtimes: Record<string, BoundToolRuntime> = {};
      const requires: Record<string, ToolRequires> = {};
      for (const id of ids) {
        const override = sharedTools?.[id];
        const bound = override ?? this.boundToolMap.get(id);
        const runtime = override?.runtime ?? this.toolSource.getBoundTool(id);
        if (!bound || !runtime) {
          this.log.warn(
            { event: "agent_cogni.tool_unavailable", runId, tool: id },
            "shared tool unavailable",
          );
          if (id === shell && audience) throw new Error("sandbox_unavailable");
          continue;
        }
        runtimes[id] = runtime;
        if (bound.contract.requires) requires[id] = bound.contract.requires;
      }
      const guardScope = {
        runId,
        principalId,
        subjectUserId: actor,
        accountId: scope.billing.billingAccountId,
        payer: scope.billing.billingAccountId,
      };
      const { offered, excluded } = await offeredToolIds(
        Object.entries(runtimes).map(([id, runtime]) => ({
          id,
          effect: runtime.spec.effect,
        })),
        requires,
        guardScope,
        deps.guardDeps,
      );
      if (!audience && ids.includes(shell)) {
        this.log.warn(
          {
            event: "agent_coding.audience_denied",
            runId,
            actor,
            program: entry.program,
          },
          "coding audience denied",
        );
      }
      if (
        audience &&
        ids.includes(shell) &&
        (!deps.sandboxReady() || !offered.includes(shell))
      ) {
        const denial = excluded.find((item) => item.tool === shell);
        throw new Error(denial?.code ?? "sandbox_unavailable");
      }
      const allowed = offered.filter((id) => audience || id !== shell);
      const allowedSet = new Set(allowed);
      const filtered = Object.fromEntries(
        Object.entries(runtimes).filter(([id]) => allowedSet.has(id)),
      );
      const abort = new AbortController();
      if (scope.abortSignal?.aborted) abort.abort(scope.abortSignal.reason);
      else
        scope.abortSignal?.addEventListener(
          "abort",
          () => abort.abort(scope.abortSignal?.reason),
          { once: true },
        );
      let denied = false;
      const guarded = guardTools(filtered, requires, guardScope, {
        ...deps.guardDeps,
        onTerminalDenial: () => {
          denied = true;
          abort.abort(new Error("agent_tool_denied"));
        },
        runAs: (identity, fn) =>
          runInScope(
            {
              ...scope,
              runId,
              ...(identity.principalId && {
                principalId: identity.principalId,
              }),
              ...(identity.subjectUserId && {
                subjectUserId: identity.subjectUserId,
              }),
            },
            fn,
          ),
      });
      const completionFn = this.createCompletionFn(req);
      const completion: typeof completionFn = (params) => {
        if (denied || abort.signal.aborted)
          throw new Error("agent_tool_denied");
        return completionFn(params);
      };
      const createToolExecFn = (emit: (e: AiEvent) => void): ToolExecFn => {
        const runner = createToolRunner(
          createStaticToolSourceFromRecord(guarded),
          emit,
          {
            policy: createToolAllowlistPolicy(allowed),
            ctx: { runId },
          },
        );
        return (name, args, toolCallId) => {
          if (name === shell && !audience) {
            this.log.warn(
              {
                event: "agent_coding.audience_denied",
                runId,
                actor,
                program: entry.program,
              },
              "coding audience denied",
            );
            denied = true;
            abort.abort(new Error("agent_tool_denied"));
            return Promise.resolve({
              ok: false as const,
              errorCode: "policy_denied" as const,
              safeMessage: "Tool call denied by policy",
            });
          }
          return toolCallId !== undefined
            ? runner.exec(name, args, { modelToolCallId: toolCallId })
            : runner.exec(name, args);
        };
      };
      const contracts = allowed
        .map(
          (id) =>
            sharedTools?.[id]?.contract ?? this.boundToolMap.get(id)?.contract,
        )
        .filter((x): x is NonNullable<typeof x> => !!x);
      const runner = createSharedInProcGraphRunner({
        createGraph: entry.graphFactory,
        completionFn: completion,
        createToolExecFn,
        toolContracts: contracts as unknown as Parameters<
          typeof createSharedInProcGraphRunner
        >[0]["toolContracts"],
        program: entry.program,
        trustedActorId: actor,
        trustedProgramId: entry.program,
        sourceContext,
        request: {
          runId,
          messages: req.messages,
          abortSignal: abort.signal,
          ingressRequestId: requestId,
          configurable: { model: req.modelRef.modelId, toolIds: allowed },
        },
        ...(entry.systemPrompt && { systemPrompt: entry.systemPrompt }),
        ...(req.responseFormat && { responseFormat: req.responseFormat }),
      });
      return { ...runner, denied: () => denied };
    };
    const inner = execute().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown";
      const reason = [
        "shared_identity_unavailable",
        "shared_principal_unavailable",
        "node_source_context_unavailable",
        "node_source_context_overflow",
        "authz_unavailable",
        "policy_denied",
        "sandbox_unavailable",
      ].includes(message)
        ? message
        : message.startsWith("shared_tool_unavailable:")
          ? "shared_tool_unavailable"
          : "authority_or_source_unavailable";
      this.log.error(
        { event: "agent_cogni.start_denied", runId, reason },
        "shared Cogni run unavailable",
      );
      throw error;
    });
    const stream = (async function* () {
      try {
        const result = await inner;
        yield* result.stream;
      } catch {
        yield { type: "error" as const, error: "internal" as const };
        yield { type: "done" as const };
      }
    })();
    const final = inner.then(
      (result) => this.mapToGraphFinal(result.final, runId, requestId, "cogni"),
      () => ({
        ok: false as const,
        runId,
        requestId,
        error: "internal" as const,
      }),
    );
    return { stream, final };
  }

  /**
   * Extract graph name from namespaced graphId.
   * Per GRAPH_ID_NAMESPACED: "langgraph:cogni" → "cogni"
   */
  private extractGraphName(graphId: string): string | undefined {
    const prefix = `${this.providerId}:`;
    if (graphId.startsWith(prefix)) {
      return graphId.slice(prefix.length);
    }

    return undefined;
  }

  /**
   * Create completion function wrapping adapter.executeCompletionUnit.
   */
  private createCompletionFn(
    req: GraphRunRequest,
  ): CompletionFn<LlmToolDefinition> {
    const { runId, graphId } = req;
    const attempt = 0; // P0_ATTEMPT_FREEZE

    return (params: {
      messages: Message[];
      model: string;
      tools?: readonly LlmToolDefinition[];
      abortSignal?: AbortSignal;
    }) => {
      const result = this.adapter.executeCompletionUnit({
        messages: params.messages as GraphRunRequest["messages"],
        model: params.model,
        runContext: { runId, attempt, graphId },
        ...(params.abortSignal && { abortSignal: params.abortSignal }),
        ...(params.tools?.length && { tools: [...params.tools] }),
      });

      return {
        stream: result.stream,
        final: result.final.then((r) => {
          if (!r.ok) return { ok: false as const, error: r.error };
          return {
            ok: true as const,
            content: r.content ?? "",
            ...(r.toolCalls && { toolCalls: r.toolCalls }),
            ...(r.usage && { usage: r.usage }),
            ...(r.finishReason && { finishReason: r.finishReason }),
          };
        }),
      };
    };
  }

  /**
   * Map package GraphResult to port GraphFinal.
   * GraphResult.error is now AiExecutionErrorCode - direct passthrough.
   * Logs errors at adapter boundary for debugging.
   */
  private async mapToGraphFinal(
    final: Promise<GraphResult>,
    runId: string,
    requestId: string,
    graphName: string,
  ): Promise<GraphFinal> {
    const result = await final;

    if (!result.ok) {
      // Log error at adapter boundary (per OBSERVABILITY.md: adapter ERROR log)
      this.log.error(
        {
          runId,
          reqId: requestId,
          graphName,
          errorCode: result.error ?? "internal",
          errorMessage: result.errorMessage,
          event: EVENT_NAMES.ADAPTER_LANGGRAPH_INPROC_ERROR,
        },
        EVENT_NAMES.ADAPTER_LANGGRAPH_INPROC_ERROR,
      );

      // Direct passthrough - GraphResult.error is already AiExecutionErrorCode
      return { ok: false, runId, requestId, error: result.error ?? "internal" };
    }

    // Conditional spreads for exactOptionalPropertyTypes
    return {
      ok: true,
      runId,
      requestId,
      finishReason: "stop",
      ...(result.usage !== undefined && { usage: result.usage }),
      ...(result.content !== undefined && { content: result.content }),
      ...(result.structuredOutput !== undefined && {
        structuredOutput: result.structuredOutput,
      }),
    };
  }

  /**
   * Create error result for invalid requests.
   * Per ERROR_NORMALIZATION: details logged, stream gets code only.
   */
  private createErrorResult(
    runId: string,
    requestId: string,
    code: AiExecutionErrorCode = "internal",
  ): GraphRunResult {
    const errorStream = (async function* () {
      yield { type: "error" as const, error: code };
      yield { type: "done" as const };
    })();

    return {
      stream: errorStream,
      final: Promise.resolve({
        ok: false as const,
        runId,
        requestId,
        error: code,
      }),
    };
  }
}

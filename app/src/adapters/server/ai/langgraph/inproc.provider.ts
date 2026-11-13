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
 * Links: GRAPH_EXECUTION.md, LANGGRAPH_AI.md
 * @internal
 */

import {
  type GuardDeps,
  guardTools,
  offeredToolIds,
  type RunIdentity,
  type TerminalDenial,
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
  type GraphResult,
  type InProcGraphRequest,
  LANGGRAPH_CATALOG,
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
  readonly description: string;
  readonly toolIds: readonly string[];
  readonly mcpServerIds?: readonly string[];
  /** Internal agent principal slug this graph acts as (catalog `principal`). */
  readonly principal?: string;
  readonly graphFactory: CreateGraphFn;
  readonly systemPrompt?: string;
}

/**
 * The node's tool-authority wiring (bootstrap/agent-authority.ts), seen structurally so adapters do not
 * import bootstrap. Absent means no principal can be resolved and every scoped tool is denied.
 */
export interface ProviderAgentAuthority {
  /** The seeded user id for a catalog principal slug, or null when no row exists. */
  resolvePrincipal(slug: string): Promise<string | null>;
  readonly guardDeps: Omit<GuardDeps, "runAs">;
}

/** The one fixed outcome a denied run ends with (DENIAL_IS_TERMINAL). */
function denialMessage(code: "policy_denied" | "authz_unavailable"): string {
  return code === "authz_unavailable"
    ? "I can't check my permissions right now, so I stopped. Try again later."
    : "I don't have permission to do that on this node, so I stopped. Ask a node admin to allow it.";
}

/** With no authority wired, the guard can reach no store and no admin check: scoped tools deny. */
const DENY_ALL_GUARD_DEPS: Omit<GuardDeps, "runAs"> = {
  withStore: async () => {
    throw new Error("agent_authority_not_configured");
  },
  adminCheck: async () => "unavailable",
};

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
    private readonly authority?: ProviderAgentAuthority
  ) {
    this.log = makeLogger({ component: "LangGraphInProcProvider" });
    this.boundToolMap = new Map(nodeBundle.map((bt) => [bt.contract.name, bt]));

    this.catalog = catalog;

    this.log.debug(
      {
        graphCount: Object.keys(this.catalog).length,
        graphs: Object.keys(this.catalog),
      },
      "LangGraphInProcProvider initialized"
    );
  }

  runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult {
    const { runId, messages, modelRef, graphId } = req;
    const model = modelRef.modelId;
    const scope = getExecutionScope();
    const requestId = ctx?.requestId ?? req.runId;

    // Extract graph name from graphId (e.g., "langgraph:poet" → "poet")
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

    this.log.debug(
      { runId, graphName, model, messageCount: messages.length },
      "LangGraphInProcProvider.runGraph routing to package runner"
    );

    // Create completion function wrapping adapter
    const completionFn = this.createCompletionFn(req);

    // P0 Contract: undefined => catalog default, [] => deny-all, [...] => exact
    const catalogToolIds = entry.toolIds;
    const toolIds: readonly string[] = req.toolIds ?? catalogToolIds;
    if (req.toolIds === undefined) {
      this.log.debug(
        { runId, graphName, catalogToolIds },
        "toolIds undefined; using catalog default per P0 contract"
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
          "Tool not found in toolSource; graph misconfigured"
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
      // Principal lock: the catalog names the agent this graph acts as. No seed row denies the run
      // before any tool runs (SCOPED_TOOL_NEEDS_PRINCIPAL; fail closed).
      let principalId: string | undefined;
      if (entry.principal) {
        try {
          principalId =
            (await this.authority?.resolvePrincipal(entry.principal)) ??
            undefined;
        } catch (error) {
          // The principal store is down: fail closed, and say so as `authz_unavailable` (not a generic internal error).
          this.log.error(
            {
              event: EVENT_NAMES.AGENT_TOOL_AUTHZ,
              runId,
              graphName,
              principal: entry.principal,
              decision: "unavailable",
              code: "authz_unavailable",
              reason: "principal_lookup_failed",
              errorName: error instanceof Error ? error.name : "unknown",
            },
            "graph principal lookup failed; run denied",
          );
          throw error;
        }
        if (!principalId) {
          this.log.error(
            {
              event: EVENT_NAMES.AGENT_TOOL_AUTHZ,
              runId,
              graphName,
              principal: entry.principal,
              decision: "deny",
              code: "policy_denied",
              reason: "principal_not_seeded",
            },
            "graph principal has no seed row; run denied",
          );
          throw new Error("agent_principal_not_seeded");
        }
      }
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
              "Resolved MCP tools for graph"
            );
          }
        }
      }

      // The contracts' `requires` are the only input that names scopes. An MCP tool has none yet, so it is
      // denied (it is external_side_effect) until MCP server scopes merge into requiresById.
      const requiresById: Record<string, ToolRequires> = {};
      for (const [id, bound] of this.boundToolMap) {
        if (bound.contract.requires) requiresById[id] = bound.contract.requires;
      }
      const guardScope = {
        runId,
        principalId,
        subjectUserId: scope.subjectUserId,
        payer: scope.billing.billingAccountId,
      };
      const guardBase = this.authority?.guardDeps ?? DENY_ALL_GUARD_DEPS;

      // DENIAL_IS_TERMINAL (1/2): the model is never offered a tool whose principal lock already fails.
      const { offered, excluded } = await offeredToolIds(
        Object.entries(runtimeTools).map(([id, rt]) => ({
          id,
          effect: rt.spec.effect,
        })),
        requiresById,
        guardScope,
        guardBase
      );
      const offeredSet = new Set(offered);

      // A run with no interactive caller (one with no subject, such as a scheduled run or a webhook) whose
      // every write tool is withheld has nothing it may do: end it now, with no model call, instead of paying for a
      // "no permission" answer on every tick. An interactive run keeps the system note below and may answer once.
      const writeTools = Object.entries(runtimeTools).filter(
        ([, rt]) => rt.spec.effect !== "read_only"
      );
      const noInteractiveCaller = !scope.subjectUserId;
      const endWithoutModel =
        noInteractiveCaller &&
        writeTools.length > 0 &&
        writeTools.every(([id]) => !offeredSet.has(id));
      for (const id of Object.keys(runtimeTools)) {
        if (!offeredSet.has(id)) delete runtimeTools[id];
      }
      const offeredToolIdList = toolIds.filter((id) => offeredSet.has(id));
      const offeredMcpToolIds = mcpToolIds.filter((id) => offeredSet.has(id));

      // Combined tool IDs for allowlist: native catalog tools + MCP tools
      const allToolIds = [...offeredToolIdList, ...offeredMcpToolIds];

      // Get catalog tools for contract extraction from the injected node bundle
      // (per NODE_BUNDLE_IS_CANONICAL — TOOL_CATALOG only has core tools post-bug.0319 ckpt 2)
      const catalogTools = catalogToolIds
        .filter((id) => offeredSet.has(id))
        .map((id) => this.boundToolMap.get(id))
        .filter((bt): bt is NonNullable<typeof bt> => bt !== undefined);

      // DENIAL_IS_TERMINAL (2/2): an exec-time denial ends the run cleanly. The run's abort signal chains the caller's.
      const runAbort = new AbortController();
      const callerSignal = scope.abortSignal;
      if (callerSignal) {
        if (callerSignal.aborted) runAbort.abort(callerSignal.reason);
        else
          callerSignal.addEventListener(
            "abort",
            () => runAbort.abort(callerSignal.reason),
            { once: true }
          );
      }
      let terminal: TerminalDenial | null = null;
      let modelCalls = 0;
      let modelCallsAfterDenial = 0;
      const countedCompletionFn: typeof completionFn = (params) => {
        modelCalls += 1;
        if (terminal) modelCallsAfterDenial += 1;
        return completionFn(params);
      };

      // Create tool execution function factory
      // Policy allowlist includes both native and MCP tool IDs
      const createToolExecFn = (emit: (e: AiEvent) => void): ToolExecFn => {
        const policy = createToolAllowlistPolicy(allToolIds);
        // GUARD_COVERS_EVERY_RUNNER_SITE: every runtime (native + MCP) passes through the guard.
        const guarded = guardTools(runtimeTools, requiresById, guardScope, {
          ...guardBase,
          onTerminalDenial: (denial) => {
            if (terminal) return;
            terminal = denial;
            runAbort.abort(new Error("agent_tool_denied"));
          },
          runAs: (identity: RunIdentity, fn) =>
            runInScope(
              {
                ...scope,
                ...(identity.principalId
                  ? { principalId: identity.principalId }
                  : {}),
                ...(identity.subjectUserId
                  ? { subjectUserId: identity.subjectUserId }
                  : {}),
              },
              fn
            ),
        });
        const source = createStaticToolSourceFromRecord(guarded);
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
              "tool call failed"
            );
          }
          return result;
        };
      };

      const toolContracts = catalogTools.map((bt) => bt.contract);

      const mcpToolSpecs = offeredMcpToolIds
        .map((id) => runtimeTools[id]?.spec)
        .filter((s): s is NonNullable<typeof s> => s !== undefined);

      const traceId =
        trace.getActiveSpan()?.spanContext().traceId ??
        "00000000000000000000000000000000";
      const runnerRequest: InProcGraphRequest = {
        runId,
        // A run that lost tools says so up front, so the model stops instead of hunting for another way (a
        // denied run must not loop). Only tools the graph lists are named.
        messages: (excluded.length > 0
          ? [
              {
                role: "system",
                content: `You have no permission to use: ${excluded.map((e) => e.tool).join(", ")}. If the task needs one of them, say so in one sentence and stop. Do not look for another way.`,
              },
              ...messages,
            ]
          : messages) as InProcGraphRequest["messages"],
        abortSignal: runAbort.signal,
        ...(traceId !== undefined && { traceId }),
        ...(requestId !== undefined && { ingressRequestId: requestId }),
        configurable: { model, toolIds: offeredToolIdList },
      };

      if (endWithoutModel) {
        const code = excluded.every((e) => e.code === "authz_unavailable")
          ? ("authz_unavailable" as const)
          : ("policy_denied" as const);
        this.log.warn(
          {
            event: EVENT_NAMES.AGENT_RUN_DENIED,
            runId,
            graphName,
            principal: entry.principal ?? null,
            tools: writeTools.map(([id]) => id),
            code,
            reason: "no_permission",
            modelCalls: 0,
            modelCallsAfterDenial: 0,
          },
          "run ended without a model call: every write tool is withheld"
        );
        const text = denialMessage(code);
        return {
          stream: (async function* () {
            yield { type: "text_delta" as const, delta: text };
            yield { type: "assistant_final" as const, content: text };
            yield { type: "done" as const } as AiEvent;
          })(),
          final: Promise.resolve({
            ok: true,
            finishReason: "stop",
            content: text,
          } as GraphResult),
        };
      }
      const inner = createInProcGraphRunner({
        createGraph: entry.graphFactory,
        completionFn: countedCompletionFn,
        createToolExecFn,
        toolContracts,
        ...(mcpToolSpecs.length > 0 && { mcpToolSpecs }),
        request: runnerRequest,
        ...(req.responseFormat !== undefined && {
          responseFormat: req.responseFormat,
        }),
        ...(entry.systemPrompt !== undefined && {
          systemPrompt: entry.systemPrompt,
        }),
      });
      return this.endDeniedRunCleanly(inner, {
        runId,
        graphName,
        principal: entry.principal ?? null,
        denial: () => terminal,
        modelCalls: () => ({ modelCalls, modelCallsAfterDenial }),
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
        }) as const
    );

    // mapToGraphFinal returns Promise<GraphFinal>, so final is Promise<Promise<GraphFinal> | GraphFinal>
    // Flatten with .then()
    const flatFinal = final.then((f) => f);

    return { stream, final: flatFinal };
  }

  /**
   * DENIAL_IS_TERMINAL. When the guard denied a tool, the run was aborted (see `onTerminalDenial`). The runner reports an
   * abort as an error; this turns it into a clean completion: no error event, one fixed assistant message, `final.ok`.
   * Logs one `agent_run.denied` event with the model-call counts. A run with no denial passes through untouched.
   */
  private endDeniedRunCleanly(
    inner: { stream: AsyncIterable<AiEvent>; final: Promise<GraphResult> },
    info: {
      runId: string;
      graphName: string;
      principal: string | null;
      denial: () => TerminalDenial | null;
      modelCalls: () => { modelCalls: number; modelCallsAfterDenial: number };
    }
  ): { stream: AsyncIterable<AiEvent>; final: Promise<GraphResult> } {
    const log = this.log;
    const message = (denial: TerminalDenial) => denialMessage(denial.code);
    let logged = false;
    const logOnce = (denial: TerminalDenial) => {
      if (logged) return;
      logged = true;
      log.warn(
        {
          event: EVENT_NAMES.AGENT_RUN_DENIED,
          runId: info.runId,
          graphName: info.graphName,
          principal: info.principal,
          tool: denial.tool,
          code: denial.code,
          reason: denial.reason,
          ...info.modelCalls(),
        },
        "run ended cleanly after a tool denial"
      );
    };
    const stream = (async function* () {
      let sawFinal = false;
      for await (const event of inner.stream) {
        const denial = info.denial();
        if (denial && event.type === "error") continue; // the abort we caused
        if (event.type === "assistant_final") sawFinal = true;
        if (denial && event.type === "done") {
          if (!sawFinal) {
            yield { type: "text_delta" as const, delta: message(denial) };
            yield { type: "assistant_final" as const, content: message(denial) };
          }
          logOnce(denial);
        }
        yield event;
      }
    })();
    const final = inner.final.then((result): GraphResult => {
      const denial = info.denial();
      if (!denial) return result;
      logOnce(denial);
      if (result.ok) return result;
      return {
        ok: true,
        finishReason: "stop",
        content: message(denial),
      };
    });
    return { stream, final };
  }

  /**
   * Extract graph name from namespaced graphId.
   * Per GRAPH_ID_NAMESPACED: "langgraph:poet" → "poet"
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
    req: GraphRunRequest
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
    graphName: string
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
        EVENT_NAMES.ADAPTER_LANGGRAPH_INPROC_ERROR
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
    code: AiExecutionErrorCode = "internal"
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

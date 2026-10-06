// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/ai/principal-tool-source`
 * Purpose: Build a PER-REQUEST `ToolSourcePort` whose tools have the calling
 *   principal CLOSED OVER, and compose it in front of the module-scoped
 *   container tool source. This is the answer to the open question that blocked
 *   the third principal of the capability plane: "how does the signed-in user's
 *   principal reach a graph tool?"
 * Scope: Wiring only. No query, no authorization, no HTTP, no tool contract of
 *   its own. It joins a CONTRACT from `@cogni/poly-graphs/tools` (zod v3, the
 *   version `@cogni/ai-tools` and the LangChain runtime speak) to a TRANSPORT in
 *   `@features/agent-tools` (zod v4, the version the capability plane speaks),
 *   injecting the app-role `Database`, the principal, and a request context.
 *   That version split is why the two halves live apart; see the contract's
 *   header for the evidence.
 * Invariants:
 *   - PRINCIPAL_BY_CLOSURE_NOT_BY_CONTEXT — the principal arrives as a
 *     constructor argument and lives in a closure. It is NOT added to
 *     `ToolInvocationContext`, whose header forbids credential-shaped fields
 *     (compile-enforced by `app/tests/unit/security/no-secret-fields.types.test.ts`)
 *     and which would in any case deliver it to a layer that cannot forward it:
 *     `ToolImplementation.execute` in `@cogni/ai-tools` takes NO ctx argument,
 *     and `runtime-adapter.ts` receives `_ctx` and deliberately discards it.
 *   - PER_REQUEST_NEVER_MODULE_SCOPED — the source is constructed inside
 *     `createInProcProvider`, which `createGraphExecutor` already calls once per
 *     request with a `userId` in hand. Nothing here is cached, memoised, or
 *     hoisted to module scope: a leaked source would answer one user's graph run
 *     with another user's authority. That is the whole risk of this file.
 *   - OVERLAY_NEVER_SHADOWS — composition is checked: if a principal-scoped tool
 *     id also exists in the base source, construction THROWS rather than
 *     silently shadowing a core tool.
 *   - NO_PRIVILEGED_TRANSPORT — `resolveAppDb` only. The injected handle is the
 *     app-role pool, so the executor's tenant transaction keeps Postgres RLS as
 *     the backstop exactly as it is for the REST transport.
 *   - CTX_IS_CORRELATION_ONLY — the `ToolInvocationContext` this module reads is
 *     used for `runId`/`toolCallId` correlation and NOTHING else. No authority is
 *     derived from it.
 * Side-effects: IO at tool-invocation time (one Postgres transaction per call),
 *   via the feature transport. None at construction.
 * Links: task.1791070967, story.5006, docs/spec/capability-plane.md,
 *   graph-executor.factory.ts
 * @internal
 */

import type {
  BoundToolRuntime,
  ToolInvocationContext,
  ToolSourcePort,
  ToolSpec,
} from "@cogni/ai-core";
import {
  type CatalogBoundTool,
  type ToolContract,
  toToolSpec,
} from "@cogni/ai-tools";
import type { Database } from "@cogni/db-client";
import {
  polyAccountCopyTradeOrdersBoundTool,
  polyAccountCopyTradeOrdersToolContract,
} from "@cogni/poly-graphs";
import { trace } from "@opentelemetry/api";

import { runPolyAccountCopyTradeOrdersTool } from "@/features/agent-tools";
import {
  type Logger,
  makeLogger,
  type RequestContext,
} from "@/shared/observability";

/**
 * Contract-only bundle for the principal-scoped tools, appended to the node
 * bundle so the provider can publish their specs to the model.
 *
 * These entries carry THROWING stub implementations on purpose (see
 * `polyAccountCopyTradeOrdersBoundTool`). The bundle exists to describe the tool
 * to the LLM; execution must come from the per-request source below, and a stub
 * that throws turns "wired to the wrong source" into a loud failure instead of a
 * silent one.
 */
export const PRINCIPAL_TOOL_BUNDLE: readonly CatalogBoundTool[] = [
  polyAccountCopyTradeOrdersBoundTool as CatalogBoundTool,
];

/** Tool ids served by the per-request source. Used by the catalog overlay. */
export const PRINCIPAL_TOOL_IDS: readonly string[] = PRINCIPAL_TOOL_BUNDLE.map(
  (bt) => bt.contract.name
);

export type PrincipalToolSourceDeps = {
  /**
   * The authenticated principal for this request — the signed-in user's id,
   * threaded from the graph run's `actorUserId`. The internal agent borrows the
   * user's authority; it holds none of its own.
   */
  readonly principalId: string;
  /**
   * App-role handle factory, resolved lazily PER TOOL CALL rather than captured
   * at construction, so a long-lived graph run cannot pin a pool handle that the
   * container has since replaced. Pass `resolveAppDb`; never
   * `resolveServiceDb` / `resolveServiceReadDb`.
   */
  readonly resolveDb: () => Database;
  /** Base logger; a child is bound per tool call with the run correlation ids. */
  readonly baseLog?: Logger;
};

/**
 * Build the per-request principal-scoped tool source.
 *
 * Per PER_REQUEST_NEVER_MODULE_SCOPED: call this once per request, from the
 * place that already holds a `userId`. Never cache the result.
 */
export function createPrincipalToolSource(
  deps: PrincipalToolSourceDeps
): ToolSourcePort {
  const log =
    deps.baseLog ?? makeLogger({ component: "PrincipalToolSource" });

  const runtimes = new Map<string, BoundToolRuntime>([
    [
      polyAccountCopyTradeOrdersToolContract.name,
      principalBoundToolRuntime(
        polyAccountCopyTradeOrdersToolContract,
        (input, ctx) =>
          runPolyAccountCopyTradeOrdersTool(
            {
              db: deps.resolveDb(),
              principalId: deps.principalId,
              ctx: toolRequestContext(log, ctx, {
                routeId: "poly.agent.copy_trade.orders",
              }),
            },
            input
          )
      ),
    ],
  ]);

  return new MapToolSource(runtimes);
}

/**
 * Compose a principal-scoped overlay in front of a base source.
 *
 * `LangGraphInProcProvider` takes exactly one `ToolSourcePort`, and the base one
 * comes from the container (module-scoped, principal-free, and P0-frozen at
 * `container.ts` so it cannot be extended there). This is the seam that lets a
 * per-request source join it without a container edit.
 *
 * Per OVERLAY_NEVER_SHADOWS a collision throws at construction. Silently
 * shadowing `core__web_search` with a principal-scoped tool of the same name
 * would be a capability-confusion bug that no test would notice.
 */
export function composeToolSources(
  overlay: ToolSourcePort,
  base: ToolSourcePort
): ToolSourcePort {
  for (const spec of overlay.listToolSpecs()) {
    if (base.hasToolId(spec.name)) {
      throw new Error(
        `OVERLAY_NEVER_SHADOWS: principal-scoped tool "${spec.name}" also exists ` +
          "in the base tool source. Rename the principal-scoped tool; never shadow."
      );
    }
  }
  return new ComposedToolSource(overlay, base);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The ONE place a tool implementation sees its `ToolInvocationContext`.
 *
 * `toBoundToolRuntime` in `@cogni/ai-tools` is the normal adapter, and it
 * discards `ctx` (`async exec(validatedArgs, _ctx, _capabilities)`), because
 * `ToolImplementation.execute` has no parameter to forward it to. Changing that
 * signature would touch every tool factory in `ai-tools` AND in
 * `@cogni/poly-ai-tools`, whose index is a port-frozen P1 entry — so this
 * module builds the `BoundToolRuntime` directly instead.
 *
 * Validation and redaction still come from the contract, so this is an arity
 * adapter and not a second validation pipeline. Per CTX_IS_CORRELATION_ONLY the
 * ctx is read for `runId`/`toolCallId` and nothing else; authority comes from
 * the closure.
 */
function principalBoundToolRuntime<TInput, TOutput, TRedacted>(
  contract: ToolContract<string, TInput, TOutput, TRedacted>,
  exec: (input: TInput, ctx: ToolInvocationContext) => Promise<TOutput>
): BoundToolRuntime {
  // Double cast: `toToolSpec` takes the ERASED contract type, and erasing
  // `allowlist: ReadonlyArray<keyof TOutput>` to `ReadonlyArray<keyof unknown>`
  // (i.e. `never`) is not a single-step conversion. `toToolSpec` only reads
  // `name`, `description`, `effect`, `inputSchema`, and `allowlist`-as-strings.
  const { spec } = toToolSpec(
    contract as unknown as ToolContract<string, unknown, unknown, unknown>
  );

  return {
    id: contract.name,
    spec,
    effect: contract.effect,
    // The principal is a closure, not a connection. No broker involved.
    requiresConnection: false,
    capabilities: [],
    validateInput: (rawArgs) => contract.inputSchema.parse(rawArgs),
    exec: (validatedArgs, ctx) => exec(validatedArgs as TInput, ctx),
    validateOutput: (rawOutput) => contract.outputSchema.parse(rawOutput),
    redact: (validatedOutput) => contract.redact(validatedOutput as TOutput),
  };
}

/**
 * A `RequestContext` for a tool call. There is no HTTP request here, so the
 * graph run supplies the correlation: `reqId` is the run id, which is what makes
 * the capability's terminal event joinable to the graph run that triggered it —
 * the evidence needed to prove the internal principal on a real deploy.
 */
function toolRequestContext(
  baseLog: Logger,
  ctx: ToolInvocationContext,
  options: { routeId: string }
): RequestContext {
  const traceId =
    trace.getActiveSpan()?.spanContext().traceId ??
    "00000000000000000000000000000000";
  return {
    log: baseLog.child({
      routeId: options.routeId,
      reqId: ctx.runId,
      traceId,
      toolCallId: ctx.toolCallId,
    }),
    reqId: ctx.runId,
    traceId,
    routeId: options.routeId,
    clock: { now: () => new Date().toISOString() },
  };
}

/** Minimal `ToolSourcePort` over a prebuilt map. */
class MapToolSource implements ToolSourcePort {
  private readonly specs: readonly ToolSpec[];

  constructor(private readonly runtimes: ReadonlyMap<string, BoundToolRuntime>) {
    this.specs = Array.from(runtimes.values(), (runtime) => runtime.spec);
  }

  getBoundTool(toolId: string): BoundToolRuntime | undefined {
    return this.runtimes.get(toolId);
  }

  listToolSpecs(): readonly ToolSpec[] {
    return this.specs;
  }

  hasToolId(toolId: string): boolean {
    return this.runtimes.has(toolId);
  }
}

/** Overlay-first lookup over two sources. Collisions are rejected upstream. */
class ComposedToolSource implements ToolSourcePort {
  private readonly specs: readonly ToolSpec[];

  constructor(
    private readonly overlay: ToolSourcePort,
    private readonly base: ToolSourcePort
  ) {
    this.specs = [...overlay.listToolSpecs(), ...base.listToolSpecs()];
  }

  getBoundTool(toolId: string): BoundToolRuntime | undefined {
    return this.overlay.getBoundTool(toolId) ?? this.base.getBoundTool(toolId);
  }

  listToolSpecs(): readonly ToolSpec[] {
    return this.specs;
  }

  hasToolId(toolId: string): boolean {
    return this.overlay.hasToolId(toolId) || this.base.hasToolId(toolId);
  }
}

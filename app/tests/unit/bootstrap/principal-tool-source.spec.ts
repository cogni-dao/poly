// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/principal-tool-source`
 * Purpose: Pin the one thing that must never regress about per-request tool
 *   binding: a tool source built for user A can NEVER answer with user B's
 *   authority. Everything else in this file exists to make that assertion
 *   meaningful.
 * Scope: The per-request source and the composition seam. The tool's own
 *   rendering is pinned by
 *   `tests/unit/features/agent-tools/copy-trade-orders-tool.test.ts`.
 * Invariants: PER_REQUEST_NEVER_MODULE_SCOPED; PRINCIPAL_BY_CLOSURE_NOT_BY_CONTEXT;
 *   OVERLAY_NEVER_SHADOWS; NO_PRIVILEGED_TRANSPORT.
 * Side-effects: none
 * Links: task.1791070967, story.5006
 * @internal
 */

import type {
  BoundToolRuntime,
  ToolInvocationContext,
  ToolSourcePort,
  ToolSpec,
} from "@cogni/ai-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runPolyAccountCopyTradeOrdersTool } = vi.hoisted(() => ({
  runPolyAccountCopyTradeOrdersTool: vi.fn(),
}));

// Partial mock: the contract stays REAL (so the spec, id, and schemas under test
// are the ones that ship) and only the transport call is observed.
vi.mock("@/features/agent-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/agent-tools")>();
  return { ...actual, runPolyAccountCopyTradeOrdersTool };
});

import {
  composeToolSources,
  createPrincipalToolSource,
  PRINCIPAL_TOOL_BUNDLE,
  PRINCIPAL_TOOL_IDS,
} from "@/bootstrap/ai/principal-tool-source";
import {
  POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
  polyAccountCopyTradeOrdersBoundTool,
} from "@/features/agent-tools";

const INVOCATION: ToolInvocationContext = {
  runId: "run-abc",
  toolCallId: "call-1",
};

/** Minimal stand-in for `container.toolSource`. */
function fakeBaseSource(toolIds: readonly string[]): ToolSourcePort {
  const specs = toolIds.map(
    (name) => ({ name, description: name }) as unknown as ToolSpec
  );
  return {
    getBoundTool: (id) =>
      toolIds.includes(id)
        ? ({ id, spec: specs[toolIds.indexOf(id)] } as BoundToolRuntime)
        : undefined,
    listToolSpecs: () => specs,
    hasToolId: (id) => toolIds.includes(id),
  };
}

/** A source for an arbitrary principal; identity is asserted explicitly where it matters. */
function source(principalId = "alice") {
  return createPrincipalToolSource({
    principalId,
    resolveDb: () => ({}) as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  runPolyAccountCopyTradeOrdersTool.mockResolvedValue({
    status: "ok",
    orders: [],
    order_count: 0,
  });
});

describe("per-request principal binding", () => {
  it("does not leak one principal into another request's source", async () => {
    // PER_REQUEST_NEVER_MODULE_SCOPED. This is the assertion the whole file is
    // for: if the source or its runtimes were ever memoised at module scope,
    // the second principal would read with the first one's authority, and the
    // capability plane's authorization would be correct but aimed at the wrong
    // human. Nothing else in CI would notice.
    const db = {} as never;

    const alice = createPrincipalToolSource({
      principalId: "alice",
      resolveDb: () => db,
    });
    const bob = createPrincipalToolSource({
      principalId: "bob",
      resolveDb: () => db,
    });

    await alice
      .getBoundTool(POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME)
      ?.exec({}, INVOCATION, {});
    await bob
      .getBoundTool(POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME)
      ?.exec({}, INVOCATION, {});

    expect(
      runPolyAccountCopyTradeOrdersTool.mock.calls.map(
        ([deps]) => deps.principalId
      )
    ).toEqual(["alice", "bob"]);
  });

  it("never takes the principal from the invocation context", async () => {
    // PRINCIPAL_BY_CLOSURE_NOT_BY_CONTEXT. `ToolInvocationContext` carries only
    // correlation ids, and a future field on it must not become an authority
    // channel by accident.
    const toolSource = createPrincipalToolSource({
      principalId: "closure-principal",
      resolveDb: () => ({}) as never,
    });

    await toolSource
      .getBoundTool(POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME)
      ?.exec(
        {},
        { ...INVOCATION, principalId: "context-principal" } as never,
        {}
      );

    const deps = runPolyAccountCopyTradeOrdersTool.mock.calls[0]?.[0];
    expect(deps.principalId).toBe("closure-principal");
  });

  it("carries the graph run id into the capability's request context", async () => {
    // What makes the internal principal PROVABLE on a real deploy: the
    // capability's terminal event is correlated by `reqId` to the graph run that
    // triggered it, so one Loki query joins the two.
    const toolSource = createPrincipalToolSource({
      principalId: "alice",
      resolveDb: () => ({}) as never,
    });

    await toolSource
      .getBoundTool(POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME)
      ?.exec({}, INVOCATION, {});

    const deps = runPolyAccountCopyTradeOrdersTool.mock.calls[0]?.[0];
    expect(deps.ctx.reqId).toBe("run-abc");
    expect(deps.ctx.routeId).toBe("poly.agent.copy_trade.orders");
  });

  it("resolves the database per invocation, never once at construction", async () => {
    // A handle captured at construction outlives the pool it came from on a
    // long-running graph run.
    const resolveDb = vi.fn(() => ({}) as never);
    const toolSource = createPrincipalToolSource({
      principalId: "alice",
      resolveDb,
    });

    expect(resolveDb).not.toHaveBeenCalled();

    const tool = toolSource.getBoundTool(POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME);
    await tool?.exec({}, INVOCATION, {});
    await tool?.exec({}, INVOCATION, {});

    expect(resolveDb).toHaveBeenCalledTimes(2);
  });

  it("validates input and redacts output through the real contract", () => {
    const tool = source().getBoundTool(
      POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME
    );
    expect(tool).toBeDefined();
    expect(tool?.effect).toBe("read_only");
    // The principal is a closure, not a BYO connection — no broker involved.
    expect(tool?.requiresConnection).toBe(false);
    expect(() => tool?.validateInput({ limit: "not-a-number" })).toThrow();
    expect(tool?.validateInput({ limit: 5 })).toEqual({ limit: 5 });
    // Redaction comes from the shipped contract, not from a second pipeline.
    const unavailable = {
      status: "unavailable",
      reason: "no_readable_account",
      message: "nope",
    };
    expect(tool?.validateOutput(unavailable)).toEqual(unavailable);
    expect(tool?.redact(unavailable)).toEqual(unavailable);
  });
});

describe("composition", () => {
  it("refuses to shadow a tool the base source already owns", () => {
    // OVERLAY_NEVER_SHADOWS. Silently overriding `core__web_search` with a
    // principal-scoped tool would be a capability-confusion bug that no other
    // test could see.
    expect(() =>
      composeToolSources(
        source(),
        fakeBaseSource([POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME])
      )
    ).toThrow(/OVERLAY_NEVER_SHADOWS/);
  });

  it("serves the overlay tool and keeps every base tool reachable", () => {
    const composed = composeToolSources(
      source(),
      fakeBaseSource(["core__web_search", "core__get_current_time"])
    );

    expect(composed.hasToolId(POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME)).toBe(
      true
    );
    expect(composed.hasToolId("core__web_search")).toBe(true);
    expect(composed.getBoundTool("core__get_current_time")).toBeDefined();
    expect(composed.hasToolId("core__nonexistent")).toBe(false);
    expect(composed.listToolSpecs().map((spec) => spec.name)).toEqual([
      POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
      "core__web_search",
      "core__get_current_time",
    ]);
  });
});

describe("node bundle", () => {
  it("publishes the contract so the model can see the tool", () => {
    // The provider builds the LLM-visible tool list from the node bundle, not
    // from the tool source, so a tool missing here is invisible to the model
    // even though it would execute if called.
    expect(PRINCIPAL_TOOL_BUNDLE).toContain(
      polyAccountCopyTradeOrdersBoundTool
    );
    expect(PRINCIPAL_TOOL_IDS).toEqual([
      POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
    ]);
  });

  it("declares no write-capable tool", () => {
    // story.5006 adds no write scope. A `state_change` or
    // `external_side_effect` tool appearing in this bundle would mean an agent
    // gained a write path through the principal seam.
    for (const bound of PRINCIPAL_TOOL_BUNDLE) {
      expect(bound.contract.effect).toBe("read_only");
    }
  });
});

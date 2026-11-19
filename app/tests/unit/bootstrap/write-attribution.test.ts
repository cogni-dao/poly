// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/write-attribution`
 * Purpose: A graph-tool write records the run's actor and the run (id and kind); a route write records the caller alone (task.0133).
 * Scope: The host builders over the real launcher scope (`runGraphWithScope`), with the EDO write port stubbed.
 * Invariants:
 *   - ACTOR_FAILS_CLOSED: a run scope with no actor writes nothing.
 *   - UNKNOWN_RUN_NEVER_BLOCKS: a run with no kind still writes as the actor, with no run, and one warn event.
 * Side-effects: none
 * Links: src/bootstrap/write-attribution.ts
 * @internal
 */

import type { EdoCapability } from "@cogni/knowledge-store";
import { beforeEach, describe, expect, it, vi } from "vitest";

const attributionLog = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@/shared/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/observability")>()),
  makeLogger: () => attributionLog,
}));

import { runInScope } from "@/adapters/server/ai/execution-scope";
import { runGraphWithScope } from "@/bootstrap/graph-executor.factory";
import {
  bindEdoToolCapability,
  routeAttribution,
  runAttribution,
} from "@/bootstrap/write-attribution";

const ACTOR = "schedule-owner";
const RUN = { id: "run-42", kind: "system_scheduled" } as const;

/** Runs `fn` the way a graph tool call does: the real launcher builds the scope. */
function inRun<T>(
  options: { actor?: string; runKind?: typeof RUN.kind },
  fn: () => T
): T {
  let result: T | undefined;
  runGraphWithScope({
    executor: {
      runGraph: () => {
        result = fn();
        return {
          stream: (async function* () {})(),
          final: Promise.resolve({ ok: true }),
        } as never;
      },
    } as never,
    req: { runId: RUN.id, graphId: "g", messages: [] } as never,
    ctx: options.actor ? ({ actorUserId: options.actor } as never) : undefined,
    billing: { billingAccountId: "b", virtualKeyId: "v" } as never,
    llmService: {} as never,
    usageSource: "litellm",
    ...(options.runKind ? { runKind: options.runKind } : {}),
  });
  return result as T;
}

describe("write attribution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a tool write records the actor and the run", () => {
    expect(inRun({ actor: ACTOR, runKind: RUN.kind }, runAttribution)).toEqual({
      actor: ACTOR,
      run: RUN,
    });
    expect(attributionLog.warn).not.toHaveBeenCalled();
  });

  it("a run with no kind still writes as the actor, with no run, and says so once", () => {
    expect(inRun({ actor: ACTOR }, runAttribution)).toEqual({ actor: ACTOR });
    expect(attributionLog.warn).toHaveBeenCalledTimes(1);
    expect(attributionLog.warn.mock.calls[0]?.[0]).toMatchObject({
      event: "work.items.attribution_run_missing",
      runId: RUN.id,
      hasRunKind: false,
    });
  });

  it("a scope with no actor writes nothing", () => {
    expect(() => inRun({ runKind: RUN.kind }, runAttribution)).toThrow(
      /actor required/
    );
    expect(() =>
      runInScope({} as never, () => runAttribution())
    ).toThrow(/actor required/);
  });

  it("a route write is the caller alone", () => {
    expect(routeAttribution("caller")).toEqual({ actor: "caller" });
  });

  it("the EDO tool binding attributes every write from the run at call time", async () => {
    const edo = {
      hypothesize: vi.fn(async () => ({})),
      decide: vi.fn(async () => ({})),
      recordOutcome: vi.fn(async () => ({})),
      getChain: vi.fn(async () => ({})),
    } as unknown as EdoCapability;
    const tool = bindEdoToolCapability(edo);
    const attribution = { actor: ACTOR, run: RUN };
    await inRun({ actor: ACTOR, runKind: RUN.kind }, async () => {
      await tool.hypothesize({ id: "h" } as never);
      await tool.decide({ id: "d" } as never);
      await tool.recordOutcome({ id: "o" } as never);
    });
    expect(edo.hypothesize).toHaveBeenCalledWith({ id: "h" }, attribution);
    expect(edo.decide).toHaveBeenCalledWith({ id: "d" }, attribution);
    expect(edo.recordOutcome).toHaveBeenCalledWith({ id: "o" }, attribution);
  });
});

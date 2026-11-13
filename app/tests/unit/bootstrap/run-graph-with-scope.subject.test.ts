// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/run-graph-with-scope.subject`
 * Purpose: The launcher's subject rule (task.5456): the authenticated caller is the run subject, bearer agents
 *   included; the system principal and a run with no caller have none.
 * Scope: `runGraphWithScope` only, with a recording executor. No graph runs.
 * Invariants: THREE_IDENTITIES, SUBJECT_ONLY_NARROWS
 * Side-effects: none
 */

import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import { describe, expect, it } from "vitest";

import { getExecutionScope } from "@/adapters/server/ai/execution-scope";
import { runGraphWithScope } from "@/bootstrap/graph-executor.factory";

function subjectFor(ctx: { actorUserId?: string } | undefined): string | undefined {
  let seen: string | undefined;
  runGraphWithScope({
    executor: {
      runGraph: () => {
        seen = getExecutionScope().subjectUserId;
        return { stream: (async function* () {})(), final: Promise.resolve({ ok: true }) } as never;
      },
    } as never,
    req: { runId: "r", graphId: "langgraph:brain", messages: [], modelRef: { providerKey: "platform", modelId: "m" } } as never,
    ...(ctx ? { ctx } : {}),
    billing: { billingAccountId: "b", virtualKeyId: "v" },
    llmService: {} as never,
    usageSource: "litellm",
  });
  return seen;
}

describe("runGraphWithScope subject", () => {
  it("is the authenticated caller, whether a human session or a bearer agent", () => {
    expect(subjectFor({ actorUserId: "human-1" })).toBe("human-1");
    expect(subjectFor({ actorUserId: "bearer-agent-1" })).toBe("bearer-agent-1");
  });
  it("is absent for a run with no caller and for the system principal", () => {
    expect(subjectFor(undefined)).toBeUndefined();
    expect(subjectFor({})).toBeUndefined();
    expect(subjectFor({ actorUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID })).toBeUndefined();
  });
});

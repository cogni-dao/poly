// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@/bootstrap/write-attribution`
 * Purpose: The only builders of a `WriteAttribution` (hub activity-attribution, task.0133): who acted, which run.
 * Scope: Host composition. Routes build one from the authenticated caller; graph tools build one from the run's execution scope.
 * Invariants:
 *   - HOST_BUILDS_IT: no request field, tool argument or model output feeds an attribution.
 *   - ACTOR_FAILS_CLOSED: a run write's actor is the run scope's `actorUserId` (this node's only run identity); a scope without one writes nothing.
 *   - UNKNOWN_RUN_NEVER_BLOCKS: a missing run id or kind omits the `Run:` line and logs one event; it never refuses the write.
 * Side-effects: none
 * @public
 */

import type {
  EdoCapability as EdoWriteCapability,
  EdoToolCapability,
} from "@cogni/knowledge-store";
import type { WriteAttribution } from "@cogni/work-items";
import {
  type ExecutionScope,
  getExecutionScope,
} from "@/adapters/server/ai/execution-scope";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

const log = makeLogger({ component: "write-attribution" });

/** A write made through a route: the authenticated caller (a signed-in person, or the outside AI that holds the key). No requester, no run. */
export function routeAttribution(callerUserId: string): WriteAttribution {
  return { actor: callerUserId };
}

/**
 * A write made by a graph tool: the run's actor and the run. The actor rule is fail closed: no actor, no write.
 * The run is not: when the host could not name it (no record, no kind, an unreadable ledger) the write still happens,
 * with no `Run:` line, and one `work.items.attribution_run_missing` event says so.
 */
export function runAttribution(
  scope: ExecutionScope = getExecutionScope()
): WriteAttribution {
  const actor = scope.actorUserId;
  if (!actor) throw new Error("Authenticated work-item actor required");
  const run =
    scope.runId && scope.runKind
      ? { id: scope.runId, kind: scope.runKind }
      : undefined;
  if (!run) {
    log.warn(
      {
        event: EVENT_NAMES.WORK_ITEMS_ATTRIBUTION_RUN_MISSING,
        ...(scope.runId ? { runId: scope.runId } : {}),
        hasRunKind: scope.runKind !== undefined,
      },
      EVENT_NAMES.WORK_ITEMS_ATTRIBUTION_RUN_MISSING
    );
  }
  return { actor, ...(run ? { run } : {}) };
}

/**
 * The EDO capability as a tool sees it: each write is attributed from the run's scope at call time, so a tool never names or
 * builds an attribution. The routes call the full capability with `routeAttribution`.
 */
export function bindEdoToolCapability(
  edo: EdoWriteCapability,
  attribution: () => WriteAttribution = runAttribution
): EdoToolCapability {
  return {
    hypothesize: async (params) => edo.hypothesize(params, attribution()),
    decide: async (params) => edo.decide(params, attribution()),
    recordOutcome: async (params) => edo.recordOutcome(params, attribution()),
    getChain: (params) => edo.getChain(params),
  };
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@/bootstrap/write-attribution`
 * Purpose: The only builders of a `WriteAttribution` (hub activity-attribution, task.0133): who acted, who asked, which run.
 * Scope: Host composition. Routes build one from the authenticated caller; graph tools build one from the run's execution scope.
 * Invariants:
 *   - HOST_BUILDS_IT: no request field, tool argument or model output feeds an attribution.
 *   - ACTOR_IS_THE_PRINCIPAL: a run write's actor is `actingPrincipal(scope)` and fails closed without one. It never falls back to the subject.
 *   - UNKNOWN_RUN_NEVER_BLOCKS: a missing run id or kind omits the `Run:` line and logs one event; it never refuses the write.
 *   - SUBJECT_IS_THE_REQUESTER: the run's subject is `requestedBy`, never the actor.
 *   - NO_SCOPE_USER_ID: a write module never imports `scopeUserId` (that is the owner and RLS identity); `tests/unit/bootstrap/write-attribution.test.ts` fails when one does.
 * Side-effects: none
 * @public
 */

import type {
  EdoCapability as EdoWriteCapability,
  EdoToolCapability,
} from "@cogni/knowledge-store";
import type { WriteAttribution } from "@cogni/work-items";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";
import {
  actingPrincipal,
  type ExecutionScope,
  getExecutionScope,
} from "@/adapters/server/ai/execution-scope";

const log = makeLogger({ component: "write-attribution" });

/** The fields every write's terminal event carries: who acted, who asked, which run. Ids only. */
export function attributionFields(attribution: WriteAttribution): {
  actor: string;
  requestedBy?: string;
  runId?: string;
  runKind?: string;
} {
  return {
    actor: attribution.actor,
    ...(attribution.requestedBy ? { requestedBy: attribution.requestedBy } : {}),
    ...(attribution.run
      ? { runId: attribution.run.id, runKind: attribution.run.kind }
      : {}),
  };
}

/** A write made through a route: the authenticated caller (a signed-in person, or the outside AI that holds the key). No requester, no run. */
export function routeAttribution(callerUserId: string): WriteAttribution {
  return { actor: callerUserId };
}

/**
 * A write made by a graph tool: the run's acting principal, the run's subject as requester (when it has one) and the run.
 * The actor rule is fail closed: no principal, no write, and the subject is never the actor. The run is not: when the host
 * could not name it (no record, no kind, an unreadable ledger) the write still happens as the principal, with no `Run:` line,
 * and one `work.items.attribution_run_missing` event says so.
 */
export function runAttribution(
  scope: ExecutionScope = getExecutionScope()
): WriteAttribution {
  const actor = actingPrincipal(scope);
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
  return {
    actor,
    ...(scope.subjectUserId ? { requestedBy: scope.subjectUserId } : {}),
    ...(run ? { run } : {}),
  };
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

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@/bootstrap/write-attribution`
 * Purpose: The only builders of a `WriteAttribution` (hub activity-attribution, task.0133): who acted, who asked, which run.
 * Scope: Host composition. Routes build one from the authenticated caller; graph tools build one from the run's execution scope.
 * Invariants:
 *   - HOST_BUILDS_IT: no request field, tool argument or model output feeds an attribution.
 *   - RUN_ACTOR_FAILS_CLOSED: a tool write's actor is the run's `actorUserId`; a run with none writes nothing.
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

/** A write made through a route: the authenticated caller. No requester, no run. */
export function routeAttribution(callerUserId: string): WriteAttribution {
	return { actor: callerUserId };
}

/** A write made by a graph tool: the actor of the run that called it. Fails closed when the run names none. */
export function runAttribution(
	scope: ExecutionScope = getExecutionScope(),
): WriteAttribution {
	if (!scope.actorUserId) {
		throw new Error("write denied: the run has no acting user");
	}
	return { actor: scope.actorUserId };
}

/** The EDO capability as a tool sees it: each write is attributed from the run's scope at call time. */
export function bindEdoToolCapability(
	edo: EdoWriteCapability,
	attribution: () => WriteAttribution = runAttribution,
): EdoToolCapability {
	return {
		hypothesize: async (params) => edo.hypothesize(params, attribution()),
		decide: async (params) => edo.decide(params, attribution()),
		recordOutcome: async (params) => edo.recordOutcome(params, attribution()),
		getChain: (params) => edo.getChain(params),
	};
}

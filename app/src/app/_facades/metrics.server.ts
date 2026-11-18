// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Thin binding of the published `@cogni-dao/metrics/http` route core to this
 * node's container (service, goal reader, knowledge store) and to Next.js
 * responses. All request parsing, contract validation and error mapping live
 * in the package; the routes keep only authentication and logging.
 */
import {
	createMetricHttpHandlers,
	METRIC_HTTP_HEADERS,
	type MetricHttpResult,
	metricErrorResult,
} from "@cogni-dao/metrics/http";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";

function reportUnexpected() {
	getContainer().log.error(
		{ errorCode: "metrics_unavailable" },
		"metric.operation_failed",
	);
}

export function metricHandlers() {
	const container = getContainer();
	return createMetricHttpHandlers({
		goalProgress: () => container.goalProgress(),
		service: () => container.goalMetrics,
		subject: async (id) => container.knowledgeStorePort?.getKnowledge(id),
		onUnexpectedError: reportUnexpected,
	});
}

export function metricResponse(result: MetricHttpResult): NextResponse {
	return NextResponse.json(result.body, {
		status: result.status,
		headers: METRIC_HTTP_HEADERS,
	});
}

/** For failures a route raises itself (for example a missing route context). */
export function metricHttpError(error: unknown): NextResponse {
	return metricResponse(metricErrorResult(error, reportUnexpected));
}

/** Same reader instance as core__goal_progress, for the Knowledge page seed. */
export async function loadGoalsProgress() {
	return getContainer().goalProgress();
}

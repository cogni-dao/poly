// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Trusted worker dispatch for the metrics refresh clock. The package core
 * (`handleRefreshTick`) answers idle ticks from memory and keeps one dispatch
 * receipt per working tick; this route keeps the scheduler bearer, the node's
 * receipt port, the grant-checked runner and logging.
 */
import { verifySchedulerBearer } from "@cogni/node-shared";
import { handleRefreshTick } from "@cogni-dao/metrics/http";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { runMetricsRefresh } from "@/bootstrap/jobs/metrics-refresh.job";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = wrapRouteHandlerWithLogging(
	{ routeId: "metrics.refresh.internal", auth: { mode: "none" } },
	async (ctx, request) => {
		// Getters: the container is touched only after the request is authorized.
		const result = await handleRefreshTick(
			{
				get service() {
					return getContainer().goalMetrics;
				},
				get receipts() {
					return getContainer().executionRequestPort;
				},
				run: runMetricsRefresh,
			},
			{
				authorized: verifySchedulerBearer(
					request.headers.get("authorization"),
					serverEnv().SCHEDULER_API_TOKEN,
				),
				idempotencyKey: request.headers.get("idempotency-key"),
				keyPrefix: `${getNodeId()}/metrics:${getNodeId()}:refresh/`,
				readBody: () => request.json(),
			},
		);
		if (result.event)
			logEvent(ctx.log, EVENT_NAMES.METRIC_REFRESH_COMPLETE, {
				reqId: ctx.reqId,
				routeId: ctx.routeId,
				...result.event,
			});
		return NextResponse.json(result.body, { status: result.status });
	},
);

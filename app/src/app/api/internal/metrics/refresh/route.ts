// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Trusted worker dispatch. Stable dispatch receipts and append-only measurement attempts are separate. */
import { createHash, randomUUID } from "node:crypto";
import { verifySchedulerBearer } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { z } from "zod";
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
		if (
			!verifySchedulerBearer(
				request.headers.get("authorization"),
				serverEnv().SCHEDULER_API_TOKEN,
			)
		)
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		const key = request.headers.get("idempotency-key");
		const prefix = `${getNodeId()}/metrics:${getNodeId()}:refresh/`;
		if (
			!key?.startsWith(prefix) ||
			!z.iso.datetime({ offset: true }).safeParse(key.slice(prefix.length))
				.success
		)
			return NextResponse.json(
				{ error: "invalid_dispatch_key" },
				{ status: 400 },
			);
		let input: unknown;
		try {
			input = await request.json();
		} catch {
			return NextResponse.json({ error: "invalid_json" }, { status: 400 });
		}
		const body = z
			.strictObject({ executionGrantId: z.uuid() })
			.safeParse(input);
		if (!body.success)
			return NextResponse.json({ error: "grant_required" }, { status: 400 });
		const requests = getContainer().executionRequestPort;
		const hash = createHash("sha256")
			.update(JSON.stringify(body.data))
			.digest("hex");
		const previous = await requests.checkIdempotency(key, hash);
		if (previous.status === "cached")
			return NextResponse.json({
				ok: previous.request.ok === true,
				replay: true,
			});
		if (previous.status === "pending" || previous.status === "stale")
			return NextResponse.json({ error: "dispatch_pending" }, { status: 409 });
		if (previous.status === "mismatch")
			return NextResponse.json(
				{ error: "dispatch_payload_mismatch" },
				{ status: 422 },
			);
		try {
			await requests.createPendingRequest(key, hash, randomUUID(), null);
		} catch (error) {
			const raced = await requests.checkIdempotency(key, hash);
			if (raced.status !== "new")
				return NextResponse.json(
					{ error: "dispatch_pending" },
					{ status: 409 },
				);
			throw error;
		}
		try {
			const result = await runMetricsRefresh(body.data.executionGrantId);
			await requests.finalizeRequest(key, { ok: true, errorCode: null });
			const failed = result.observations.filter(
				(x) => x.status === "error" || x.status === "unavailable",
			);
			logEvent(ctx.log, EVENT_NAMES.METRIC_REFRESH_COMPLETE, {
				reqId: ctx.reqId,
				routeId: ctx.routeId,
				scanned: result.scanned,
				measuredCount: result.observations.length,
				errorCount: failed.length,
				outcome: failed.length ? "error" : "success",
				errorCode: failed.length ? "metric_source_unavailable" : null,
			});
			return NextResponse.json({ ok: true, ...result });
		} catch (error) {
			await requests.finalizeRequest(key, { ok: false, errorCode: "internal" });
			throw error;
		}
	},
);

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** One bounded service-authenticated proof capability; no human-session or account wire input. */
import { type NextRequest, NextResponse } from "next/server";
import {
	authenticateQualification,
	qualifyDeployment,
} from "@/app/_facades/deploy-qualification.server";
import {
	assertQualificationLifetime,
	readQualificationBody,
	withinQualificationLifetime,
} from "@/app/_lib/qualification-body";
import { getCurrentTraceId, withRootSpan } from "@/bootstrap/otel";
import { qualificationOperation } from "@/contracts/deploy.qualification.v1.contract";
import { QualificationError } from "@/features/deploy-qualification/challenge";
import {
	createRequestContext,
	httpRequestDurationMs,
	httpRequestsTotal,
	logRequestEnd,
	logRequestStart,
	makeLogger,
	statusBucket,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
	// The exported boundary owns the original budget, including logging/admission
	// prelude. Logging must not initialize the trading container before auth.
	const deadlineAt = Date.now() + 19000;
	const start = performance.now();
	const routeId = "deploy.qualification";
	const ctx = createRequestContext(
		{
			baseLog: makeLogger({ component: "deploy.qualification" }),
			clock: { now: () => new Date().toISOString() },
		},
		request,
		{ routeId, traceId: getCurrentTraceId() },
	);
	logRequestStart(ctx.log);
	let responseStatus = 503;
	try {
		const result = await withinQualificationLifetime(
			request.signal,
			deadlineAt,
			(signal) =>
				withRootSpan(
					`${request.method} ${routeId}`,
					{ route_id: routeId },
					async ({ traceId, span }) => {
						assertQualificationLifetime(signal, deadlineAt);
						ctx.traceId = traceId;
						ctx.log = ctx.log.child({ traceId });
						span.setAttribute("request_id", ctx.reqId);
						const challenge = await authenticateQualification(
							request.headers.get("authorization"),
						);
						assertQualificationLifetime(signal, deadlineAt);
						const body = await readQualificationBody(request, signal);
						if (body.mode !== challenge.mode)
							throw new QualificationError("qualification_auth_invalid", 401);
						assertQualificationLifetime(signal, deadlineAt);
						return qualifyDeployment(challenge, signal, deadlineAt);
					},
				),
		);
		const response = NextResponse.json(
			qualificationOperation.output.parse(result),
			{
				headers: { "cache-control": "no-store" },
			},
		);
		// Serialization and required disposal have completed. No await separates
		// this final fence from publishing the success event and response.
		assertQualificationLifetime(request.signal, deadlineAt);
		ctx.log.info(
			{
				client_order_id: result.evidenceId,
				buildSha: result.sourceSha,
				bootId: result.helper?.bootId,
				env: result.env,
				releaseId: result.releaseId,
				attemptId: result.attemptId,
				allocation: result.allocation,
				evidenceId: result.evidenceId,
				helper: result.helper,
				sourceSha: result.sourceSha,
				status: result.status,
			},
			"deploy.qualification.observed",
		);
		responseStatus = response.status;
		return response;
	} catch (error) {
		if (!request.body?.locked) void request.body?.cancel().catch(() => {});
		const known = error instanceof QualificationError;
		ctx.log.warn(
			{ error: known ? error.code : "qualification_failed" },
			"deploy.qualification.failed",
		);
		responseStatus = known ? error.status : 503;
		return NextResponse.json(
			{ error: known ? error.code : "qualification_failed" },
			{ status: responseStatus },
		);
	} finally {
		// One envelope covers early auth failure, initialization timeout and output.
		const durationMs = performance.now() - start;
		logRequestEnd(ctx.log, { status: responseStatus, durationMs });
		httpRequestsTotal.inc({
			route: routeId,
			method: request.method,
			status: statusBucket(responseStatus),
		});
		httpRequestDurationMs.observe(
			{ route: routeId, method: request.method },
			durationMs,
		);
	}
}

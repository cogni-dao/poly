// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** One bounded service-authenticated proof capability; no human-session or account wire input. */
import { NextResponse } from "next/server";
import {
	authenticateQualification,
	qualifyDeployment,
} from "@/app/_facades/deploy-qualification.server";
import { readQualificationBody } from "@/app/_lib/qualification-body";
import {
	assertQualificationLifetime,
	withinQualificationLifetime,
} from "@/app/_lib/qualification-lifetime";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { qualificationOperation } from "@/contracts/deploy.qualification.v1.contract";
import { QualificationError } from "@/features/deploy-qualification/challenge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = wrapRouteHandlerWithLogging(
	{ routeId: "deploy.qualification", auth: { mode: "none" } },
	async (ctx, request) => {
		const deadlineAt = Date.now() + 19000;
		try {
			const result = await withinQualificationLifetime(
				request.signal,
				deadlineAt,
				async (signal) => {
					const challenge = await authenticateQualification(
						request.headers.get("authorization"),
					);
					signal.throwIfAborted();
					const body = await readQualificationBody(request, signal);
					if (body.mode !== challenge.mode)
						throw new QualificationError("qualification_auth_invalid", 401);
					signal.throwIfAborted();
					return qualifyDeployment(challenge, signal, deadlineAt);
				},
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
			return response;
		} catch (error) {
			if (!request.body?.locked) void request.body?.cancel().catch(() => {});
			const known = error instanceof QualificationError;
			ctx.log.warn(
				{ error: known ? error.code : "qualification_failed" },
				"deploy.qualification.failed",
			);
			return NextResponse.json(
				{ error: known ? error.code : "qualification_failed" },
				{ status: known ? error.status : 503 },
			);
		}
	},
);

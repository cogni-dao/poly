// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** One bounded service-authenticated proof capability; no human-session or account wire input. */
import { NextResponse } from "next/server";
import { qualifyDeployment } from "@/app/_facades/deploy-qualification.server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { qualificationOperation } from "@/contracts/deploy.qualification.v1.contract";
import { QualificationError } from "@/features/deploy-qualification/challenge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = wrapRouteHandlerWithLogging(
	{ routeId: "deploy.qualification", auth: { mode: "none" } },
	async (ctx, request) => {
		try {
			const parsed = qualificationOperation.input.safeParse(
				await request.json(),
			);
			if (!parsed.success)
				return NextResponse.json({ error: "invalid_request" }, { status: 400 });
			const result = await qualifyDeployment(
				request.headers.get("authorization"),
				parsed.data.mode,
			);
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
			return NextResponse.json(qualificationOperation.output.parse(result), {
				headers: { "cache-control": "no-store" },
			});
		} catch (error) {
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

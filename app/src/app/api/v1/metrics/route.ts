// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Authenticated metrics list. Auth and logging here; the handler is `@cogni-dao/metrics/http`. */
import { NextResponse } from "next/server";
import {
	metricHandlers,
	metricHttpError,
	metricResponse,
} from "@/app/_facades/metrics.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = wrapRouteHandlerWithLogging(
	{ routeId: "metrics.metricList", auth: { mode: "required", getSessionUser } },
	async (_ctx, request, user) => {
		if (!user)
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		try {
			return metricResponse(
				await metricHandlers().list(new URL(request.url).searchParams),
			);
		} catch (error) {
			return metricHttpError(error);
		}
	},
);

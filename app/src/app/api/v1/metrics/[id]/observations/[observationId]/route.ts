// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Authenticated immutable observation read. Auth and logging here; the handler is `@cogni-dao/metrics/http`. */
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
export const GET = wrapRouteHandlerWithLogging<{
	params: Promise<{ id: string; observationId: string }>;
}>(
	{
		routeId: "metrics.observationRead",
		auth: { mode: "required", getSessionUser },
	},
	async (_ctx, _request, user, context) => {
		if (!user)
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		try {
			if (!context) throw new Error("route_context_missing");
			const { id, observationId } = await context.params;
			return metricResponse(
				await metricHandlers().observation(id, observationId),
			);
		} catch (error) {
			return metricHttpError(error);
		}
	},
);

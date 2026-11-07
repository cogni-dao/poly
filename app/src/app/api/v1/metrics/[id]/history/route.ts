// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Ranged metric history: aligned half-open buckets, same authorization as metric read. */
import { NextResponse } from "next/server";
import { metricHistory, metricHttpError } from "@/app/_facades/metrics.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = wrapRouteHandlerWithLogging<{
	params: Promise<{ id: string }>;
}>(
	{
		routeId: "metrics.metricHistory",
		auth: { mode: "required", getSessionUser },
	},
	async (_ctx, request, user, context) => {
		if (!user)
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		try {
			if (!context) throw new Error("route_context_missing");
			const { id } = await context.params;
			const response = await metricHistory(id, request);
			response.headers.set("Cache-Control", "no-store");
			return response;
		} catch (error) {
			return metricHttpError(error);
		}
	},
);

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { NextResponse } from "next/server";
import {
	metricHttpError,
	metricObservation,
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
			if (
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
					observationId,
				)
			)
				return NextResponse.json(
					{ error: "invalid_observation_id" },
					{ status: 400 },
				);
			const response = await metricObservation(id, observationId);
			response.headers.set("Cache-Control", "no-store");
			return response;
		} catch (error) {
			return metricHttpError(error);
		}
	},
);

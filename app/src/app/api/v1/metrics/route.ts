// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Authenticated metrics endpoint. Typed package contracts, shared service. */
import { NextResponse } from "next/server";
import { MetricListInputSchema } from "@cogni-dao/metrics/contracts";
import { metricHttpError, metricList } from "@/app/_facades/metrics.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = wrapRouteHandlerWithLogging(
	{ routeId: "metrics.metricList", auth: { mode: "required", getSessionUser } },
	async (_ctx, request, user) => {
		if (!user)
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		const query = new URL(request.url).searchParams;
		const input = MetricListInputSchema.safeParse({
			...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}),
			...(query.has("after") ? { after: query.get("after") } : {}),
		});
		if (!input.success)
			return NextResponse.json({ error: "invalid_input" }, { status: 400 });
		try {
			const response = await metricList(input.data);
			response.headers.set("Cache-Control", "no-store");
			return response;
		} catch (error) {
			return metricHttpError(error);
		}
	},
);

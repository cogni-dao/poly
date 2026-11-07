// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Authenticated HTTP delegation and subject projection; computation stays in the package. */
import {
	KpiBindingsSchema,
	MetricComputeInputSchema,
	MetricError,
	MetricHistoryInputSchema,
	MetricHistorySchema,
	type MetricListInput,
	MetricListResponseSchema,
	MetricObservationSchema,
	MetricSnapshotSchema,
	MetricViewSchema,
} from "@cogni-dao/metrics";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
/** Same reader instance as core__goal_progress. */
export async function loadGoalsProgress() {
	return getContainer().goalProgress();
}
export function getGoalMetrics() {
	const service = getContainer().goalMetrics;
	if (!service) throw new MetricError("metrics_unavailable", 503);
	return service;
}
export function metricHttpError(error: unknown) {
	if (error instanceof MetricError)
		return NextResponse.json({ error: error.code }, { status: error.status });
	getContainer().log.error(
		{ errorCode: "metrics_unavailable" },
		"metric.operation_failed",
	);
	return NextResponse.json({ error: "metrics_unavailable" }, { status: 503 });
}
export async function metricList(input: MetricListInput = {}) {
	const service = getGoalMetrics();
	return NextResponse.json(
		MetricListResponseSchema.parse(
			await service.list(input.limit, input.after),
		),
	);
}
export async function metricRead(id: string) {
	const service = getGoalMetrics();
	const view = MetricViewSchema.parse(await service.read(id));
	return NextResponse.json({
		...view,
		history: (await service.history(id)).map((x) =>
			MetricObservationSchema.parse(x),
		),
	});
}
/** Same service function as core__metric_history. */
export async function metricHistory(id: string, request: Request) {
	const query = new URL(request.url).searchParams;
	const input = MetricHistoryInputSchema.safeParse({
		from: query.get("from") ?? undefined,
		to: query.get("to") ?? undefined,
		step: query.get("step") ?? undefined,
	});
	if (!input.success)
		return NextResponse.json(
			{ error: "invalid_input", issues: input.error.issues },
			{ status: 400 },
		);
	return NextResponse.json(
		MetricHistorySchema.parse(
			await getGoalMetrics().historyRange(id, input.data),
		),
	);
}
export async function metricObservation(id: string, observationId: string) {
	const saved = await getGoalMetrics().observation(id, observationId);
	return NextResponse.json(MetricSnapshotSchema.parse(saved));
}
export async function metricCompute(id: string, request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "invalid_json" }, { status: 400 });
	}
	const input = MetricComputeInputSchema.safeParse(body);
	if (!input.success)
		return NextResponse.json(
			{ error: "invalid_input", issues: input.error.issues },
			{ status: 400 },
		);
	const result = MetricObservationSchema.parse(
		await getGoalMetrics().compute(id, input.data),
	);
	return NextResponse.json(result, {
		status: result.status === "pending" ? 409 : 200,
	});
}
export async function metricSubject(id: string) {
	const row = await getContainer().knowledgeStorePort?.getKnowledge(id);
	if (!row || !["goal", "hypothesis"].includes(row.entryType ?? ""))
		throw new MetricError("subject_not_found", 404);
	const bindings = KpiBindingsSchema.parse(row.kpiBindings ?? []);
	return NextResponse.json({
		id: row.id,
		title: row.title,
		entryType: row.entryType,
		kpis: await getGoalMetrics().bindings(bindings, {
			hypothesis: row.entryType === "hypothesis",
			deadline: row.evaluateAt?.toISOString() ?? null,
		}),
	});
}

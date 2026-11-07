// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Goal progress parity (route reader == tool), fixed evidence reads and the convergence calculator. */
import type { KnowledgeStorePort } from "@cogni/knowledge-store";
import {
	bucketObservations,
	createMetricService,
	GoalsProgressSchema,
	type MetricDefinition,
	type MetricObservationsPort,
	MetricRegistry,
	type MetricSnapshot,
	metricHistoryRange,
	selectEvaluation,
} from "@cogni-dao/metrics";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	doltInstant,
	readWorkConvergence,
} from "@/adapters/server/metrics/sources";
import { createGoalMetricTools } from "@/bootstrap/capabilities/goal-metric-tools";
import {
	createGoalMetrics,
	createGoalProgressReader,
} from "@/bootstrap/capabilities/goal-metrics";

vi.mock("@/shared/config", () => ({ getNodeId: () => "test-node" }));

const NOW = new Date("2026-11-02T12:00:00Z");
function memoryObservations(): MetricObservationsPort & {
	saved: Map<string, MetricSnapshot>;
} {
	const saved = new Map<string, MetricSnapshot>();
	const series = (id: string, hash: string) =>
		[...saved.values()]
			.map((s) => s.observation)
			.filter((o) => o.metricId === id && o.definitionHash === hash)
			.sort((a, b) => b.window.end.localeCompare(a.window.end));
	return {
		saved,
		request: async () => null,
		async reserve(input) {
			saved.set(input.snapshot.observation.id, structuredClone(input.snapshot));
			return { snapshot: input.snapshot, leaseToken: "lease" };
		},
		async complete(id, _token, result) {
			const s = saved.get(id);
			if (s) s.observation = result;
			return result;
		},
		history: async (id, hash, limit) => series(id, hash).slice(0, limit),
		get: async (id) => saved.get(id)?.observation ?? null,
		lastGood: async (id, hash) =>
			series(id, hash).find((o) => o.status === "ok") ?? null,
		at: async (id, hash, at, maxAge) =>
			selectEvaluation(series(id, hash), at, maxAge),
		buckets: async (id, hash, range) =>
			bucketObservations(
				series(id, hash),
				metricHistoryRange(range, new Date(Date.parse(range.to))),
			),
		snapshot: async (id) => saved.get(id) ?? null,
		scheduledAttempts: async () => [],
		expireLeases: async () => {},
		cursor: async () => null,
		advanceCursor: async () => {},
	};
}

describe("goal progress parity", () => {
	it("returns identical assessments and observation IDs from the route reader and core__goal_progress", async () => {
		let now = new Date(NOW.getTime() - 3 * 3600000);
		const definition: MetricDefinition = {
			id: "convergence-ratio-7d",
			title: "Seven-day convergence ratio",
			revision: "r1",
			spec: {
				calculatorId: "work.convergence@1",
				params: { output: "ratio", days: 7 },
				cadenceSeconds: 3600,
				maxAgeSeconds: 7200,
			},
		};
		const registry = new MetricRegistry();
		let value = 0.5;
		registry.register({
			id: "work.convergence@1",
			unit: "ratio",
			historicalWindows: true,
			paramsSchema: z.object({}).passthrough(),
			budget: {
				timeoutMs: 100,
				maxSourceCalls: 1,
				maxRows: 1,
				maxResponseBytes: 100,
			},
			compute: async () => ({
				value,
				unit: "ratio",
				complete: true,
				sourceWatermarks: [{ source: "t", asOf: now.toISOString() }],
				evidenceRefs: [],
			}),
		});
		const observations = memoryObservations();
		const metrics = createMetricService({
			definitions: {
				get: async (id) => (id === definition.id ? definition : null),
				list: async () => ({ items: [definition], nextCursor: null }),
			},
			observations,
			registry,
			scope: { node: "n", environment: "test", dataScope: "members" },
			now: () => now,
			authorize: async () => true,
		});
		await metrics.compute(definition.id, { requestKey: "a" });
		now = new Date(NOW.getTime() - 3600000);
		value = 1.25;
		const current = await metrics.compute(definition.id, { requestKey: "b" });
		now = NOW;
		const goalRow = {
			id: "goal-ai-work-converges",
			title: "AI work converges faster than it sprawls",
			entryType: "goal",
			evaluateAt: new Date("2027-01-31T00:00:00Z"),
			kpiBindings: [
				{
					metricId: definition.id,
					comparator: "gte",
					target: { value: 1, unit: "ratio" },
				},
				{
					metricId: "validated-7d",
					comparator: "gte",
					target: { value: 1, unit: "items" },
				},
			],
		};
		const port = {
			listActiveGoals: async () => [
				{
					id: goalRow.id,
					title: goalRow.title,
					evaluateAt: goalRow.evaluateAt,
				},
			],
			getKnowledge: async (id: string) => (id === goalRow.id ? goalRow : null),
			listCitationsByCitedId: async () => [],
		} as unknown as KnowledgeStorePort;
		const read = createGoalProgressReader({
			metrics: () => metrics,
			knowledge: () => port,
			environment: "test",
		});
		const { tools, bindings } = createGoalMetricTools({
			metrics: () => metrics,
			goalProgress: read,
		});
		const tool = tools.find((t) => t.contract.name === "core__goal_progress");
		if (!tool || !bindings.core__goal_progress) throw new Error("tool missing");
		const viaRoute = await read();
		const viaTool = tool.contract.outputSchema.parse(
			await bindings.core__goal_progress.execute({}),
		);
		expect(viaTool).toEqual(viaRoute);
		expect(GoalsProgressSchema.parse(viaRoute)).toEqual(viaRoute);
		const [ratio, validated] = viaRoute.goals[0]?.kpis ?? [];
		expect(ratio?.assessment).toMatchObject({
			status: "on_track",
			reason: null,
			value: 1.25,
			observationId: current.id,
			deadline: "2027-01-31T00:00:00.000Z",
		});
		expect(ratio?.trend?.buckets).toHaveLength(30);
		expect(validated?.assessment).toMatchObject({
			status: "not_measured",
			reason: "metric_unavailable",
			value: null,
		});
		// No raw observation rows anywhere in the goal payload.
		expect(JSON.stringify(viaRoute)).not.toContain("sourceWatermarks");
		// The metric_read tool no longer ships 50-row history.
		const metricRead = tools.find(
			(t) => t.contract.name === "core__metric_read",
		);
		const out = await bindings.core__metric_read?.execute({
			id: definition.id,
		});
		expect(metricRead?.contract.outputSchema.parse(out)).not.toHaveProperty(
			"history",
		);
		const historyTool = bindings.core__metric_history;
		const range = {
			from: "2026-11-02T08:00:00Z",
			to: "2026-11-02T12:00:00Z",
			step: "1h",
		};
		expect(await historyTool?.execute({ id: definition.id, ...range })).toEqual(
			await metrics.historyRange(definition.id, { ...range, step: "1h" }),
		);
	});
});

type Row = Record<string, unknown>;
function fakeSql(answer: (text: string) => Row[]) {
	const queries: string[] = [];
	const sql = {
		unsafe(text: string) {
			queries.push(text);
			const p = Promise.resolve().then(() => answer(text));
			return Object.assign(p, { cancel: () => undefined });
		},
	} as unknown as Sql;
	return { sql, queries };
}
const window = {
	start: "2026-10-26T00:00:00.000Z",
	end: "2026-11-02T00:00:00.000Z",
};
const read = <T>(source: (signal: AbortSignal) => Promise<T>) =>
	source(new AbortController().signal);
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
/** First-parent walk rows, newest first (depth 0 = main HEAD). */
function answers(
	over: Partial<{ walk: Row[]; created: Row; validated: string }> = {},
) {
	return (text: string): Row[] => {
		if (text.includes("WITH RECURSIVE chain"))
			return (
				over.walk ?? [
					{ commit_hash: B, depth: 0, date: "2026-11-01 20:16:32.828" },
					{ commit_hash: C, depth: 1, date: "2026-10-28 10:00:00" },
					{ commit_hash: A, depth: 2, date: "2026-10-25 23:10:00.5" },
				]
			);
		if (text.includes("dolt_diff("))
			return [{ validated: over.validated ?? "3" }];
		return [
			{
				as_of: "2026-11-02T00:00:01.000Z",
				created_work: "4",
				created_contributions: "2",
				merged_contributions: "1",
				...over.created,
			},
		];
	};
}

describe("work.convergence@1 over Dolt main history", () => {
	it("counts validated transitions between first-parent edges of main, never dolt_log", async () => {
		const { sql, queries } = fakeSql(answers());
		const sample = await readWorkConvergence(sql, "ratio", window, read);
		expect(sample).toMatchObject({
			value: 4 / 6,
			unit: "ratio",
			complete: true,
		});
		expect(sample.evidenceRefs).toContain(
			"contributions:fixture-exclusion:none",
		);
		expect(sample.evidenceRefs).toContain(
			"window:[2026-10-26T00:00:00.000Z,2026-11-02T00:00:00.000Z)",
		);
		expect(sample.evidenceRefs).toContain(
			`dolt:main:${A}..${B}@2026-11-01T20:16:32.828Z`,
		);
		expect(sample.sourceWatermarks).toEqual([
			{ source: "node.doltgres.main", asOf: "2026-11-02T00:00:01.000Z" },
		]);
		// Edges come from a bounded first-parent walk; dolt_log('main') includes
		// back-dated commits merged in from contribution branches.
		const walk = queries.find((q) => q.includes("WITH RECURSIVE chain"));
		expect(walk).toContain("dolt_hashof('main')");
		expect(walk).toContain("a.parent_index = 0");
		expect(walk).toContain("chain.depth < 5000");
		expect(queries.join("\n")).not.toContain("dolt_log");
		expect(sample.evidenceRefs).toContain(
			"dolt:edge:first-parent:2;walk-cap=5000",
		);
		expect(queries.find((q) => q.includes("dolt_diff("))).toContain(
			`dolt_diff('${A}', '${B}', 'work_items')`,
		);
		expect(queries.find((q) => q.includes("dolt_diff("))).toContain(
			"from_status IS DISTINCT FROM 'done'",
		);
		expect(
			(
				await readWorkConvergence(
					fakeSql(answers()).sql,
					"validated",
					window,
					read,
				)
			).value,
		).toBe(4);
		const created = fakeSql(answers());
		expect(
			(await readWorkConvergence(created.sql, "created", window, read)).value,
		).toBe(6);
		expect(created.queries.some((q) => q.includes("WITH RECURSIVE"))).toBe(
			false,
		);
	});
	it("prefers main's reflog for edges and skips the walk when the reflog covers the window", async () => {
		const base = answers();
		const { sql, queries } = fakeSql((text) => {
			if (text.includes("dolt_reflog('main')"))
				return text.includes("2026-10-26 00:00:00.000")
					? [{ commit_hash: C, at: "2026-10-25 23:59:00" }]
					: [{ commit_hash: B, at: "2026-11-01 20:16:32.828" }];
			return base(text);
		});
		const sample = await readWorkConvergence(sql, "validated", window, read);
		expect(sample).toMatchObject({ value: 4, complete: true });
		expect(sample.evidenceRefs).toContain("dolt:edge:reflog;walk-cap=5000");
		expect(queries.some((q) => q.includes("WITH RECURSIVE"))).toBe(false);
		expect(queries.find((q) => q.includes("dolt_diff("))).toContain(
			`dolt_diff('${C}', '${B}', 'work_items')`,
		);
	});
	it("is unknown, never zero, when history does not cover the window or the ratio has no denominator", async () => {
		// The walk reached main's root before the window start: young history.
		const uncovered = await readWorkConvergence(
			fakeSql(
				answers({
					walk: [{ commit_hash: B, depth: 0, date: "2026-11-01 20:16:32.828" }],
				}),
			).sql,
			"ratio",
			window,
			read,
		);
		// Main history younger than the window is building, not a read failure.
		expect(uncovered).toMatchObject({
			complete: false,
			reason: "insufficient_history",
		});
		// The walk hit its cap before the window start: unbounded, not young.
		const capped = await readWorkConvergence(
			fakeSql(
				answers({
					walk: Array.from({ length: 5001 }, (_, depth) => ({
						commit_hash: B,
						depth,
						date: "2026-11-01 20:16:32.828",
					})),
				}),
			).sql,
			"validated",
			window,
			read,
		);
		expect(capped).toMatchObject({
			complete: false,
			reason: "history_unavailable",
		});
		const failing = await readWorkConvergence(
			fakeSql((t) => {
				if (t.includes("dolt_diff(")) throw new Error("table not found");
				return answers()(t);
			}).sql,
			"validated",
			window,
			read,
		);
		expect(failing).toMatchObject({
			complete: false,
			reason: "history_unavailable",
		});
		const empty = await readWorkConvergence(
			fakeSql(
				answers({ created: { created_work: "0", created_contributions: "0" } }),
			).sql,
			"ratio",
			window,
			read,
		);
		expect(empty).toMatchObject({
			complete: false,
			reason: "zero_denominator",
		});
	});
	it("skips a malformed metric row and keeps listing and refreshing the rest", async () => {
		const rows: Row[] = [
			{
				id: "a-bad",
				title: "Bad",
				metric_spec: '{"calculatorId":"nope"}',
				updated_at: "2026-11-01T00:00:00Z",
			},
			{
				id: "b-good",
				title: "Good",
				metric_spec: {
					calculatorId: "work.count@1",
					params: { mode: "open" },
					maxAgeSeconds: 120,
				},
				updated_at: "2026-11-01T00:00:00Z",
			},
		];
		const knowledge = fakeSql((text) => {
			const one = /WHERE id='([^']+)'/.exec(text)?.[1];
			if (one) return rows.filter((r) => r.id === one);
			const after = /AND id > '([^']+)'/.exec(text)?.[1];
			const limit = Number(/LIMIT (\d+)/.exec(text)?.[1] ?? 50);
			return rows.filter((r) => !after || String(r.id) > after).slice(0, limit);
		});
		const empty = Object.assign(async () => [], {
			unsafe: async () => [],
		}) as unknown as Sql;
		const events: object[] = [];
		const service = createGoalMetrics({
			knowledgeSql: knowledge.sql,
			observationsSql: empty,
			environment: "test",
			log: (event) => events.push(event),
		});
		const page = await service.list(1);
		expect(page.items.map((v) => v.definition.id)).toEqual(["b-good"]);
		expect(page.nextCursor).toBeNull();
		expect(events).toContainEqual({
			event: "metric.definition_invalid",
			metricId: "a-bad",
		});
	});
	it("reads Dolt commit dates in every UTC text form deployed Doltgres may return", () => {
		const want = "2026-11-04T21:44:01.123Z";
		for (const raw of [
			"2026-11-04 21:44:01.123",
			"2026-11-04 21:44:01.123Z",
			"2026-11-04 21:44:01.123+00",
			"2026-11-04 21:44:01.123 +0000",
			"2026-11-04 21:44:01.123+00:00",
			"2026-11-04 21:44:01.123 UTC",
			new Date(want),
		])
			expect(doltInstant(raw), String(raw)).toBe(want);
		expect(doltInstant("not a date")).toBeNull();
	});
	it("registers a strict historical-window calculator with output units", () => {
		const service = createGoalMetrics({
			knowledgeSql: fakeSql(() => []).sql,
			observationsSql: fakeSql(() => []).sql,
			environment: "test",
			log: () => undefined,
		});
		const calculator = service.registry.get("work.convergence@1");
		expect(calculator.historicalWindows).toBe(true);
		expect(calculator.unitFor?.({ output: "validated", days: 7 })).toBe(
			"items",
		);
		expect(calculator.unitFor?.({ output: "ratio", days: 7 })).toBe("ratio");
		expect(calculator.windowSeconds?.({ output: "ratio", days: 7 })).toBe(
			604800,
		);
		expect(
			calculator.paramsSchema.safeParse({ output: "ratio", days: 7, extra: 1 })
				.success,
		).toBe(false);
		const snapshot = service.registry.get("github.stars@1");
		expect(snapshot.historicalWindows).toBeFalsy();
	});
});

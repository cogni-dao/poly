// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Bounded planning-only diagnostics; never executes a projection or changes wallet truth. */
import { type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { safeErrorDimensions } from "@/shared/observability/safe-error-dimensions";

type Db = PostgresJsDatabase<Record<string, unknown>>;
type Plan = Record<string, unknown> & { Plans?: Plan[] };
const COOLDOWN_MS = 5 * 60_000;
const PLAN_TIMEOUT_MS = 1_000;
const CTE_NAMES = new Set([
	"wallet_identity",
	"eligible_wallet_identity",
	"observer_summary",
	"ledger_candidates",
	"origin_keys",
	"history_facts",
	"current_groups",
	"current_facts",
	"driven_keys",
	"target_correlated_keys",
	"driven_fill_identities",
	"fill_groups",
	"fill_conflicted_keys",
	"canonical_fills",
	"position_flows",
	"outcome_consensus",
	"economic_position_base",
	"generation_authority",
	"event_authority",
	"classified_raw",
	"classified",
	"windowed",
	"ranked",
	"preview",
]);
const metric = (value: unknown): number | null => {
	if (value === null || value === undefined) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
};
const label = (value: unknown): string | null =>
	typeof value === "string" && /^[A-Za-z][A-Za-z0-9_ .-]{0,119}$/.test(value)
		? value
		: null;
const rows = <T>(value: unknown): T[] =>
	Array.isArray(value)
		? value
		: value &&
				typeof value === "object" &&
				"rows" in value &&
				Array.isArray(value.rows)
			? value.rows
			: [];

/** Only estimates and static schema labels survive; predicates and SQL never do. */
export function summarizeEconomicProjectionPlan(
	detail: Record<string, unknown>,
) {
	if (!detail.Plan || typeof detail.Plan !== "object")
		throw new Error("Missing projection plan");
	const plan = detail.Plan as Plan;
	const nodes: Plan[] = [];
	const visit = (node: Plan): void => {
		nodes.push(node);
		for (const child of node.Plans ?? []) visit(child);
	};
	visit(plan);
	const selected = [...nodes].sort(
		(a, b) => (metric(b["Total Cost"]) ?? 0) - (metric(a["Total Cost"]) ?? 0),
	);
	const jit = detail.JIT as
		| { Functions?: unknown; Options?: Record<string, unknown> }
		| undefined;
	const option = (name: string): boolean | null =>
		typeof jit?.Options?.[name] === "boolean"
			? (jit.Options[name] as boolean)
			: null;
	return {
		estimatedCost: metric(plan["Total Cost"]),
		estimatedRows: metric(plan["Plan Rows"]),
		estimatedWidth: metric(plan["Plan Width"]),
		maxNodeCost: Math.max(
			0,
			...nodes.map((node) => metric(node["Total Cost"]) ?? 0),
		),
		maxEstimatedRows: Math.max(
			0,
			...nodes.map((node) => metric(node["Plan Rows"]) ?? 0),
		),
		estimatedJit: jit
			? {
					functions: metric(jit.Functions),
					inlining: option("Inlining"),
					optimization: option("Optimization"),
					expressions: option("Expressions"),
					deforming: option("Deforming"),
				}
			: null,
		totalNodeCount: nodes.length,
		selectedNodeCount: nodes.length,
		emittedNodeCount: Math.min(nodes.length, 24),
		truncated: nodes.length > 24,
		nodes: selected.slice(0, 24).map((node) => {
			const cte =
				label(node["CTE Name"]) ??
				label(node["Subplan Name"])?.replace(/^CTE /, "");
			return {
				node: label(node["Node Type"]),
				relation: label(node["Relation Name"]),
				index: label(node["Index Name"]),
				cte: cte && CTE_NAMES.has(cte) ? cte : null,
				startupCost: metric(node["Startup Cost"]),
				totalCost: metric(node["Total Cost"]),
				estimatedRows: metric(node["Plan Rows"]),
				estimatedWidth: metric(node["Plan Width"]),
			};
		}),
	};
}
export type EconomicProjectionPlanSummary = ReturnType<
	typeof summarizeEconomicProjectionPlan
>;
export type EconomicProjectionPlanProbe = {
	status: "captured" | "failed" | "skipped_cooldown" | "skipped_inflight";
	durationMs: number | null;
	plan?: EconomicProjectionPlanSummary;
	err_class?: string | undefined;
	err_code?: string | undefined;
	cause_class?: string | undefined;
	cause_code?: string | undefined;
};

/** One reservation per process/5 minutes, including failed probes; no fleet-wide claim. */
export function createEconomicProjectionPlanProbe(
	now: () => number = Date.now,
) {
	let nextAt = 0;
	let inFlight = false;
	return async (db: Db, query: SQL): Promise<EconomicProjectionPlanProbe> => {
		if (inFlight) return { status: "skipped_inflight", durationMs: null };
		if (now() < nextAt) return { status: "skipped_cooldown", durationMs: null };
		nextAt = now() + COOLDOWN_MS;
		inFlight = true;
		const startedAt = performance.now();
		try {
			// Caller owns the app-role READ ONLY REPEATABLE READ transaction. This
			// nested transaction is a savepoint after the original failed read rolled back.
			const plan = await db.transaction(async (tx) => {
				const previous = rows<{ value: string }>(
					await tx.execute(
						sql`SELECT current_setting('statement_timeout') AS value`,
					),
				)[0]?.value;
				if (!previous) throw new Error("Missing statement timeout");
				await tx.execute(
					sql.raw(`SET LOCAL statement_timeout = ${PLAN_TIMEOUT_MS}`),
				);
				const detail = rows<{ "QUERY PLAN": Array<Record<string, unknown>> }>(
					await tx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`),
				)[0]?.["QUERY PLAN"][0];
				if (!detail) throw new Error("Missing projection EXPLAIN detail");
				const summary = summarizeEconomicProjectionPlan(detail);
				await tx.execute(
					sql`SELECT set_config('statement_timeout', ${previous}, true)`,
				);
				return summary;
			});
			return {
				status: "captured",
				durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
				plan,
			};
		} catch (error) {
			// A failed savepoint rolls back the local 1s timeout, restoring the
			// caller's business-read budget before its next query.
			const { err_class, err_code, cause_class, cause_code } =
				safeErrorDimensions(error);
			return {
				status: "failed",
				durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
				err_class,
				err_code,
				cause_class,
				cause_code,
			};
		} finally {
			inFlight = false;
		}
	};
}

export const captureEconomicProjectionPlan =
	createEconomicProjectionPlanProbe();

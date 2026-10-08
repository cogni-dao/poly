// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Index and latency guard for the exact latest-run and action queries. */

import { randomUUID } from "node:crypto";
import { toUserId, userActor } from "@cogni/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import type { AgentGrantTransaction } from "@/features/agent-grants/authorization";
import {
	positionGapActionAggregateSelect,
	positionGapLatestRunsSelect,
} from "@/features/wallet-analysis/server/position-gap-runtime-read";
import { billingAccounts, users } from "@/shared/db/schema";

const ACTION_PLAN_ROWS = 20_000;
type ExplainNode = {
	"Node Type": string;
	"Relation Name"?: string;
	"Index Name"?: string;
	Plans?: ExplainNode[];
};
type ExplainDocument = { Plan: ExplainNode; "Execution Time": number };

const flatten = (node: ExplainNode): ExplainNode[] => [
	node,
	...(node.Plans ?? []).flatMap(flatten),
];
function documentOf(result: unknown): ExplainDocument {
	const rows = Array.isArray(result)
		? result
		: ((result as { rows?: unknown[] }).rows ?? []);
	const raw = (rows[0] as Record<string, unknown>)["QUERY PLAN"];
	return (
		typeof raw === "string" ? JSON.parse(raw) : (raw as ExplainDocument[])
	)[0];
}

describe("position-gap runtime query plan proof", () => {
	const appDb = getAppDb();
	const seedDb = getSeedDb();
	const userId = randomUUID();
	const accountId = randomUUID();
	const targetId = randomUUID();
	const oldRunId = randomUUID();
	const latestRunId = randomUUID();
	const cohortId = randomUUID();

	beforeAll(async () => {
		await seedDb.insert(users).values({
			id: userId,
			name: "position-gap-plan",
			walletAddress: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`,
		});
		await seedDb
			.insert(billingAccounts)
			.values({ id: accountId, ownerUserId: userId, balanceCredits: 0n });
		await seedDb.execute(sql`
			INSERT INTO poly_position_gap_runs (
				id, billing_account_id, created_by_user_id, target_id,
				budget_usdc, wallet_cash_usdc_at_start, status, started_at
			)
			SELECT gen_random_uuid(), ${accountId}, ${userId}, gen_random_uuid(),
				'24', '25', 'completed', TIMESTAMPTZ '2025-01-01' + n * INTERVAL '1 minute'
			FROM generate_series(1, 20000) AS n
		`);
		await seedDb.execute(sql`
			INSERT INTO poly_position_gap_runs (
				id, billing_account_id, created_by_user_id, target_id,
				budget_usdc, wallet_cash_usdc_at_start, status, started_at
			) VALUES
			(${oldRunId}::uuid, ${accountId}, ${userId}, ${targetId}::uuid, '24', '25', 'completed', TIMESTAMPTZ '2024-01-01'),
			(${latestRunId}::uuid, ${accountId}, ${userId}, ${targetId}::uuid, '24', '25', 'completed', TIMESTAMPTZ '2030-01-01')
		`);
		await seedDb.execute(sql`
			INSERT INTO poly_position_gap_cohorts (
				id, billing_account_id, created_by_user_id, target_id, cohort_key,
				source_kind, source_snapshot_id, source_snapshot_hash, source_snapshot_as_of,
				source_provenance, created_run_id, condition_id, token_id, market_id, outcome,
				target_delta_shares, scale_at_creation, allowed_mirror_shares,
				initial_allowed_mirror_shares,
				benchmark_target_vwap, remaining_shares
			) VALUES (
				${cohortId}::uuid, ${accountId}, ${userId}, ${targetId}::uuid, 'plan-cohort',
				'activation', 'snapshot', 'hash', NOW(), '{}'::jsonb, ${oldRunId}::uuid,
				'condition', 'token', 'market', 'Yes', '1', '1', '1', '1', '0.5', '1'
			)
		`);
		await seedDb.execute(sql`
			INSERT INTO poly_position_gap_actions (
				billing_account_id, created_by_user_id, target_id, run_id, cohort_id,
				cohort_key, action_key, kind, condition_id, token_id, market_id, outcome,
				desired_shares, notional_usdc, limit_price, filled_shares, filled_usdc,
				planner_action, client_order_id, status, submitted_at
			)
			SELECT ${accountId}, ${userId}, ${targetId}::uuid, ${oldRunId}::uuid, ${cohortId}::uuid,
				'plan-cohort', 'background-' || n, 'buy', 'condition', 'token', 'market', 'Yes',
				'1', '0.5', '0.5', '1', '0.5', '{}'::jsonb, 'background-client-' || n, 'filled', NOW()
			FROM generate_series(1, ${ACTION_PLAN_ROWS}) AS n
		`);
		await seedDb.execute(sql`
			INSERT INTO poly_position_gap_actions (
				billing_account_id, created_by_user_id, target_id, run_id, cohort_id,
				cohort_key, action_key, kind, condition_id, token_id, market_id, outcome,
				desired_shares, notional_usdc, limit_price, filled_shares, filled_usdc,
				planner_action, client_order_id, status, submitted_at
			)
			SELECT ${accountId}, ${userId}, ${targetId}::uuid, ${latestRunId}::uuid, ${cohortId}::uuid,
				'plan-cohort', 'latest-' || n, 'buy', 'condition', 'token', 'market', 'Yes',
				'1', '0.5', '0.5', '1', '0.5', '{}'::jsonb, 'latest-client-' || n, 'filled', NOW()
			FROM generate_series(1, 8) AS n
		`);
		await appDb.execute(sql`ANALYZE poly_position_gap_runs`);
		await appDb.execute(sql`ANALYZE poly_position_gap_actions`);
	}, 180_000);

	afterAll(async () => {
		await seedDb.execute(
			sql`DELETE FROM poly_position_gap_actions WHERE billing_account_id = ${accountId}`,
		);
		await seedDb.execute(
			sql`DELETE FROM poly_position_gap_cohorts WHERE billing_account_id = ${accountId}`,
		);
		await seedDb.execute(
			sql`DELETE FROM poly_position_gap_runs WHERE billing_account_id = ${accountId}`,
		);
		await seedDb
			.delete(billingAccounts)
			.where(eq(billingAccounts.id, accountId));
		await seedDb.delete(users).where(eq(users.id, userId));
	}, 180_000);

	it("uses bounded indexes below 200ms", async () => {
		await withTenantScope(appDb, userActor(toUserId(userId)), async (rawTx) => {
			const tx = rawTx as AgentGrantTransaction;
			const latest = documentOf(
				await tx.execute(
					sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${positionGapLatestRunsSelect(accountId, [targetId])}`,
				),
			);
			const actions = documentOf(
				await tx.execute(
					sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${positionGapActionAggregateSelect(tx, accountId, [latestRunId])}`,
				),
			);
			const latestNodes = flatten(latest.Plan);
			const actionNodes = flatten(actions.Plan);
			expect(
				latestNodes.some(
					(node) =>
						node["Index Name"] ===
						"poly_position_gap_runs_account_target_started_idx",
				),
			).toBe(true);
			expect(
				actionNodes.some(
					(node) => node["Index Name"] === "poly_position_gap_actions_run_idx",
				),
			).toBe(true);
			expect(
				latestNodes.some(
					(node) =>
						node["Node Type"] === "Seq Scan" &&
						node["Relation Name"] === "poly_position_gap_runs",
				),
			).toBe(false);
			expect(
				actionNodes.some(
					(node) =>
						node["Node Type"] === "Seq Scan" &&
						node["Relation Name"] === "poly_position_gap_actions",
				),
			).toBe(false);
			expect(latest["Execution Time"]).toBeLessThan(200);
			expect(actions["Execution Time"]).toBeLessThan(200);
		});
	}, 30_000);
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Saved-economics failure attribution without logging SQL or private values. */
import { describe, expect, it, vi } from "vitest";
import { portfolioSnapshotExtra } from "@/features/capability-plane/portfolio-snapshot";
import {
	type EconomicPositionReadDiagnostics,
	readEconomicPositionProjection,
} from "@/features/wallet-analysis/server/economic-position-read-model";
import { portfolioSnapshotFixture } from "../capability-plane/portfolio-snapshot.fixture";
import { summarizeEconomicProjectionPlan } from "@/features/wallet-analysis/server/economic-projection-plan";

const input = {
	billingAccountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	walletAddress: `0x${"ab".repeat(20)}`,
	connectionKind: "privy_live" as const,
	capturedAt: new Date("2026-10-21T08:00:00Z"),
	interval: "ALL" as const,
};
// A valid exact key ensures metadata executes its SQL rather than an empty fast path.
const projectionRows = [
	{
		condition_id: `0x${"cd".repeat(32)}`,
		token_id: "1",
		economic_bucket: null,
	},
];

describe("economic read diagnostics", () => {
  it("bounds estimated plans and omits predicates, functions and identities", () => {
    const summary = summarizeEconomicProjectionPlan({ Plan: {
      "Node Type": "Append", "Total Cost": 100, "Plan Rows": 30,
      Filter: "private_wallet", "Index Cond": "private_account", Output: ["private_function()"],
      Plans: Array.from({ length: 30 }, (_, index) => ({
        "Node Type": "Sort", "Total Cost": index, "Plan Rows": index,
        "Subplan Name": index === 29 ? "CTE history_facts" : "CTE private_wallet",
        Filter: "private_token",
      })),
    }, JIT: { Functions: 7, Options: { Inlining: true }, Timing: { Total: "private_runtime" } } });
    expect(summary).toMatchObject({ totalNodeCount: 31, emittedNodeCount: 24, truncated: true,
      maxNodeCost: 100, maxEstimatedRows: 30, estimatedJit: { functions: 7, inlining: true } });
    expect(summary.nodes[1]).toMatchObject({ totalCost: 29, cte: "history_facts" });
    expect(JSON.stringify(summary)).not.toMatch(/private|Filter|Index Cond|Output|Timing/);
  });
	it.each(["projection", "metadata"] as const)(
		"attributes a %s SQL failure safely",
		async (phase) => {
			const cause = Object.assign(
				new Error("private SQL params and bearer secret"),
				{
					code: "57014",
				},
			);
			const failure = new Error("Failed query SELECT private_wallet_value", {
				cause,
			});
			let calls = 0;
			const execute = vi.fn(async () => {
				calls += 1;
				if (phase === "projection" || calls === 2) throw failure;
				return projectionRows;
			});
			const diagnostics: EconomicPositionReadDiagnostics = {};
			await expect(
				readEconomicPositionProjection({
					...input,
					db: { execute },
					diagnostics,
				}),
			).rejects.toBe(failure);
			expect(execute).toHaveBeenCalledTimes(phase === "projection" ? 1 : 2);
			expect(diagnostics).toMatchObject({
				economicReadPhase: phase,
				economicErrorClass: "Error",
				economicCauseClass: "Error",
				economicCauseCode: "57014",
				economicProjectionMs: expect.any(Number),
				...(phase === "metadata"
					? { economicMetadataMs: expect.any(Number) }
					: {}),
			});
			const terminal = portfolioSnapshotExtra(
				{
					status: "ok",
					data: portfolioSnapshotFixture(),
				},
				"sha-test",
				diagnostics,
			);
			expect(terminal).toMatchObject({
				economicReadPhase: phase,
				economicErrorClass: "Error",
				economicCauseCode: "57014",
				economicProjectionMs: expect.any(Number),
			});
			expect(JSON.stringify({ diagnostics, terminal })).not.toMatch(
				/private|SELECT|bearer|secret/,
			);
		},
	);

	it("retains results when the diagnostics sink cannot be written", async () => {
		let calls = 0;
		const execute = vi.fn(async () => {
			calls += 1;
			return calls === 1 ? projectionRows : [];
		});
		const result = await readEconomicPositionProjection({
			...input,
			db: { execute },
			diagnostics: Object.freeze({}),
		});
		expect(execute).toHaveBeenCalledTimes(2);
		expect(result.livePositions).toEqual([]);
		expect(result.closedPositions).toEqual([]);
	});
});

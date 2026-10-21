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

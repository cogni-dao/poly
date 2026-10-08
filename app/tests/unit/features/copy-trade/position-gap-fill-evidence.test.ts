// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";

import {
	type PositionGapFillEvidencePort,
	reconcilePositionGapFillEvidence,
} from "@/features/copy-trade/position-gap-fill-evidence";

const wallet = "0x8ca45685c5827f7acfdd890214180c4ea9d0bf58" as const;
const conditionId =
	"0x1d5f7dd6b4b818dd9f3f5f5363204a0a6f98abe231365695bff9fb837b641c25";
const tokenId =
	"85247470555622608932511872159188003142174183325431695173475620640212510499800";
const transactionHash =
	"0xbef58f0739cc47a05235684b6b6e0116c7f5daa8bbfad1adad45d0ce66239f89";

function port(
	overrides: Partial<PositionGapFillEvidencePort> = {},
): PositionGapFillEvidencePort {
	return {
		getWalletAddress: vi.fn(async () => wallet),
		listActivity: vi.fn(async () => [
			{
				proxyWallet: wallet,
				type: "TRADE",
				timestamp: 1_791_434_872,
				conditionId,
				asset: tokenId,
				side: "BUY",
				size: 9.3,
				usdcSize: 0.00976,
				price: 0.001,
				transactionHash,
			},
		]),
		listPositions: vi.fn(async () => [
			{
				proxyWallet: wallet,
				conditionId,
				asset: tokenId,
				size: 9.3,
				totalBought: 9.3,
				grossInitialValue: 0.009755,
				entryFeesUsdc: 0.00046,
			},
		]),
		...overrides,
	};
}

const base = {
	conditionId,
	tokenId,
	expectedShares: 9.3,
	submitStartedAt: new Date("2026-10-08T04:47:47.865Z"),
	completedAt: new Date("2026-10-08T04:48:00.000Z"),
	hasOverlappingOrder: false,
};

describe("reconcilePositionGapFillEvidence", () => {
	it("verifies the exact pruned PGv3 production fill without limit-derived economics", async () => {
		await expect(
			reconcilePositionGapFillEvidence({ ...base, port: port() }),
		).resolves.toEqual({
			status: "verified",
			source: "data_api_activity_position",
			wallet,
			shares: 9.3,
			filledUsdc: 0.009295,
			grossCashUsdc: 0.00976,
			fillPrice: 0.009295 / 9.3,
			feesUsdc: 0.00046,
			transactionHashes: [transactionHash],
			evidenceStart: "2026-10-08T04:47:42.000Z",
			evidenceEnd: "2026-10-08T04:48:30.000Z",
		});
	});

	it("fails closed when another PGv3 order overlaps the evidence window", async () => {
		const evidence = port();
		await expect(
			reconcilePositionGapFillEvidence({
				...base,
				port: evidence,
				hasOverlappingOrder: true,
			}),
		).resolves.toMatchObject({
			status: "mismatch",
			reason: "overlapping_position_gap_order",
		});
		expect(evidence.listActivity).not.toHaveBeenCalled();
	});

	it("rejects cross-wallet activity even when token, shares, and economics match", async () => {
		const evidence = port({
			listActivity: vi.fn(async () => [
				{
					proxyWallet: "0x0000000000000000000000000000000000000001",
					type: "TRADE",
					timestamp: 1_791_434_872,
					conditionId,
					asset: tokenId,
					side: "BUY",
					size: 9.3,
					usdcSize: 0.00976,
					price: 0.001,
					transactionHash,
				},
			]),
		});
		await expect(
			reconcilePositionGapFillEvidence({ ...base, port: evidence }),
		).resolves.toMatchObject({
			status: "mismatch",
			reason: "missing_activity",
		});
	});

	it("rejects mixed same-token lifecycle evidence", async () => {
		const valid = await port().listActivity(wallet, {
			start: 0,
			end: 2_000_000_000,
			limit: 100,
			offset: 0,
		});
		const evidence = port({
			listActivity: vi.fn(async () => [
				...valid,
				{
					proxyWallet: wallet,
					type: "REDEEM",
					timestamp: 1_791_434_873,
					conditionId,
					asset: tokenId,
				},
			]),
		});
		await expect(
			reconcilePositionGapFillEvidence({ ...base, port: evidence }),
		).resolves.toMatchObject({
			status: "mismatch",
			reason: "ambiguous_activity",
		});
	});
});

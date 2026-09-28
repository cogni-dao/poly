// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import type { RedeemJob } from "@/core";
import { RedeemWorker } from "@/features/redeem";

const FUNDER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const TX_HASH = `0x${"ab".repeat(32)}` as `0x${string}`;

function claimedJob(): RedeemJob {
	const now = new Date();
	return {
		id: "job-1",
		funderAddress: FUNDER,
		conditionId: `0x${"12".repeat(32)}`,
		positionId: "123456789",
		outcomeIndex: 0,
		status: "claimed",
		flavor: "binary",
		indexSet: ["1", "2"],
		collateralToken: "0x2222222222222222222222222222222222222222",
		expectedShares: "1000000",
		expectedPayoutUsdc: "1000000",
		txHashes: [],
		attemptCount: 0,
		lastError: null,
		errorClass: null,
		lifecycleState: "winner",
		receiptBurnObserved: null,
		submittedAtBlock: null,
		enqueuedAt: now,
		submittedAt: null,
		confirmedAt: null,
		abandonedAt: null,
		updatedAt: now,
	};
}

describe("RedeemWorker V2 Deposit Wallet", () => {
	it("routes redemption through the injected gasless action", async () => {
		const job = claimedJob();
		const redeemPosition = vi.fn(async () => TX_HASH);
		const writeContract = vi.fn();
		const markSubmitted = vi.fn(async () => undefined);
		const markPositionLifecycleByAsset = vi.fn(async () => 1);

		const worker = new RedeemWorker({
			redeemJobs: {
				claimNextPending: vi.fn(async () => job),
				markSubmitted,
			} as never,
			orderLedger: { markPositionLifecycleByAsset },
			billingAccountId: "billing-1",
			publicClient: {
				waitForTransactionReceipt: vi.fn(async () => {
					throw new Error("receipt pending");
				}),
				getTransactionReceipt: vi.fn(async () => {
					throw new Error("receipt pending");
				}),
			} as never,
			walletClient: { writeContract } as never,
			funderAddress: FUNDER,
			account: {} as never,
			redeemPosition,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			finalityBlocks: 5n,
			tickIntervalMs: 5_000,
			reaperIntervalMs: Number.MAX_SAFE_INTEGER,
		});

		await worker.tick();

		expect(redeemPosition).toHaveBeenCalledWith(job.positionId);
		expect(writeContract).not.toHaveBeenCalled();
		expect(markSubmitted).toHaveBeenCalledWith({
			jobId: job.id,
			txHash: TX_HASH,
			submittedAtBlock: null,
			receiptBurnObserved: false,
		});
		expect(markPositionLifecycleByAsset).toHaveBeenCalledWith(
			expect.objectContaining({
				billing_account_id: "billing-1",
				token_id: job.positionId,
				lifecycle: "redeem_pending",
			}),
		);
	});
});

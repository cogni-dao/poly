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

	function workerFor(
		job: RedeemJob,
		redeemPosition: () => Promise<`0x${string}`>,
	) {
		const redeemJobs = {
			claimNextPending: vi.fn(async () => job),
			markAbandoned: vi.fn(async () => undefined),
			markTransientFailure: vi.fn(async () => undefined),
			markRpcDeferred: vi.fn(async () => undefined),
		};
		const worker = new RedeemWorker({
			redeemJobs: redeemJobs as never,
			orderLedger: { markPositionLifecycleByAsset: vi.fn(async () => 1) },
			billingAccountId: "billing-1",
			publicClient: {} as never,
			walletClient: { writeContract: vi.fn() } as never,
			funderAddress: FUNDER,
			account: {} as never,
			redeemPosition,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			finalityBlocks: 5n,
			tickIntervalMs: 5_000,
			reaperIntervalMs: Number.MAX_SAFE_INTEGER,
		});
		return { worker, redeemJobs };
	}

	it("parks a deterministic unsupported-module rejection instead of retrying (bug.5047)", async () => {
		const job = claimedJob();
		const err = new Error(
			"Position ID must use a supported protocol v2 module",
		);
		err.name = "UserInputError";
		const { worker, redeemJobs } = workerFor(job, async () => {
			throw err;
		});

		await worker.tick();

		expect(redeemJobs.markAbandoned).toHaveBeenCalledWith({
			jobId: job.id,
			errorClass: "malformed",
			error: `unsupported_position_module: ${err.message}`,
		});
		expect(redeemJobs.markRpcDeferred).not.toHaveBeenCalled();
		expect(redeemJobs.markTransientFailure).not.toHaveBeenCalled();
	});

	it("budgets an unclassified failure (attempt_count bumps) rather than deferring free", async () => {
		const job = claimedJob();
		const { worker, redeemJobs } = workerFor(job, async () => {
			throw new Error("something unexpected");
		});

		await worker.tick();

		expect(redeemJobs.markTransientFailure).toHaveBeenCalledTimes(1);
		expect(redeemJobs.markRpcDeferred).not.toHaveBeenCalled();
	});

	it("still defers genuine RPC transport failures without budget", async () => {
		const job = claimedJob();
		const { worker, redeemJobs } = workerFor(job, async () => {
			throw new Error("fetch failed");
		});

		await worker.tick();

		expect(redeemJobs.markRpcDeferred).toHaveBeenCalledTimes(1);
		expect(redeemJobs.markTransientFailure).not.toHaveBeenCalled();
	});
});

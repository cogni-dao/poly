// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
	POLYGON_NEG_RISK_ADAPTER,
	polymarketNegRiskAdapterAbi,
} from "@cogni/poly-market-provider/adapters/polymarket";
import {
	encodeAbiParameters,
	encodeEventTopics,
	parseAbiParameters,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { type RedeemJob, RedeemSubmissionError } from "@/core";
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

function fixture(job = claimedJob(), failure?: Error) {
	let current: RedeemJob | null = job;
	const redeemPosition = vi.fn(async () => {
		if (failure) throw failure;
		return TX_HASH;
	});
	const markSubmitted = vi.fn(async () => {
		current = null;
	});
	const markAbandoned = vi.fn(async () => {
		current = null;
	});
	const markTransientFailure = vi.fn(async () => {
		job.attemptCount++;
	});
	const markRpcDeferred = vi.fn(async () => undefined);
	const markConfirmed = vi.fn();
	const markPositionLifecycleByAsset = vi.fn(async () => 1);
	const publicClient = {
		readContract: vi.fn(async () => 7_000_000n),
		waitForTransactionReceipt: vi.fn(async () => {
			throw new Error("receipt pending");
		}),
		getTransactionReceipt: vi.fn(async () => {
			throw new Error("receipt pending");
		}),
		getBlockNumber: vi.fn(async () => 10n),
		getLogs: vi.fn(async () => [] as unknown[]),
	};
	const redeemJobs = {
		claimNextPending: vi.fn(async () => current),
		claimReaperCandidates: vi.fn(async () => [] as RedeemJob[]),
		markSubmitted,
		markAbandoned,
		markTransientFailure,
		markRpcDeferred,
		markConfirmed,
	};
	const writeContract = vi.fn();
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const worker = new RedeemWorker({
		redeemJobs: redeemJobs as never,
		orderLedger: { markPositionLifecycleByAsset },
		billingAccountId: "billing-1",
		publicClient: publicClient as never,
		walletClient: { writeContract } as never,
		funderAddress: FUNDER,
		account: {} as never,
		redeemPosition,
		logger,
		finalityBlocks: 5n,
		tickIntervalMs: 5_000,
		reaperIntervalMs: 0,
	});
	return {
		worker,
		redeemPosition,
		redeemJobs,
		publicClient,
		writeContract,
		logger,
		markPositionLifecycleByAsset,
	};
}

describe("RedeemWorker Deposit Wallet legacy dispatch", () => {
	it.each(["binary", "multi-outcome"] as const)(
		"preserves %s job and prepared index sets",
		async (flavor) => {
			const job = { ...claimedJob(), flavor, indexSet: ["1", "4", "8"] };
			const f = fixture(job);
			await f.worker.tick();
			expect(f.redeemPosition).toHaveBeenCalledWith(job, {
				kind: "ctf",
				indexSets: [1n, 4n, 8n],
			});
			expect(f.writeContract).not.toHaveBeenCalled();
			expect(f.redeemJobs.markSubmitted).toHaveBeenCalledWith({
				jobId: job.id,
				txHash: TX_HASH,
				submittedAtBlock: null,
				receiptBurnObserved: false,
			});
			expect(f.redeemJobs.markConfirmed).not.toHaveBeenCalled();
			expect(f.markPositionLifecycleByAsset).toHaveBeenCalledWith(
				expect.objectContaining({
					billing_account_id: "billing-1",
					token_id: job.positionId,
					lifecycle: "redeem_pending",
				}),
			);
		},
	);

	it.each([
		["neg-risk-parent", 0, [7_000_000n, 0n]],
		["neg-risk-parent", 1, [0n, 7_000_000n]],
		["neg-risk-adapter", 0, [7_000_000n, 0n]],
		["neg-risk-adapter", 1, [0n, 7_000_000n]],
	] as const)(
		"passes fresh %s outcome %s balances",
		async (flavor, outcomeIndex, amounts) => {
			const job = { ...claimedJob(), flavor, outcomeIndex };
			const f = fixture(job);
			await f.worker.tick();
			expect(f.publicClient.readContract).toHaveBeenCalledWith(
				expect.objectContaining({ args: [FUNDER, BigInt(job.positionId)] }),
			);
			expect(f.redeemPosition).toHaveBeenCalledWith(job, {
				kind: "neg-risk",
				amounts,
			});
			expect(f.writeContract).not.toHaveBeenCalled();
		},
	);

	it.each(["zero balance", "invalid outcome", "wrong funder"])(
		"never submits %s dispatch",
		async (kind) => {
			const job = { ...claimedJob(), flavor: "neg-risk-parent" as const };
			if (kind === "invalid outcome") job.outcomeIndex = 2;
			if (kind === "wrong funder")
				job.funderAddress = "0x3333333333333333333333333333333333333333";
			const f = fixture(job);
			if (kind === "zero balance")
				f.publicClient.readContract.mockResolvedValue(0n);
			await f.worker.tick();
			expect(f.redeemPosition).not.toHaveBeenCalled();
			expect(f.writeContract).not.toHaveBeenCalled();
			expect(f.redeemJobs.markAbandoned).toHaveBeenCalledWith(
				expect.objectContaining({ errorClass: "malformed" }),
			);
			expect(f.redeemJobs.markSubmitted).not.toHaveBeenCalled();
		},
	);

	it("typed local validation abandons once without RPC deferral or settlement", async () => {
		const f = fixture(
			claimedJob(),
			new RedeemSubmissionError("malformed", "unsupported dispatch"),
		);
		await f.worker.tick();
		await f.worker.tick();
		expect(f.redeemPosition).toHaveBeenCalledOnce();
		expect(f.redeemJobs.markAbandoned).toHaveBeenCalledWith(
			expect.objectContaining({ errorClass: "malformed" }),
		);
		expect(f.redeemJobs.markRpcDeferred).not.toHaveBeenCalled();
		expect(f.redeemJobs.markSubmitted).not.toHaveBeenCalled();
		expect(f.redeemJobs.markConfirmed).not.toHaveBeenCalled();
	});

	it("bounds explicit service rejection to the existing three failures", async () => {
		const f = fixture(
			claimedJob(),
			new RedeemSubmissionError("submission_rejected", "forbidden"),
		);
		for (let i = 0; i < 4; i++) await f.worker.tick();
		expect(f.redeemPosition).toHaveBeenCalledTimes(3);
		expect(f.redeemJobs.markTransientFailure).toHaveBeenCalledTimes(2);
		expect(f.redeemJobs.markAbandoned).toHaveBeenCalledWith(
			expect.objectContaining({ errorClass: "transient_exhausted" }),
		);
		expect(f.redeemJobs.markRpcDeferred).not.toHaveBeenCalled();
		expect(f.redeemJobs.markSubmitted).not.toHaveBeenCalled();
		expect(f.redeemJobs.markConfirmed).not.toHaveBeenCalled();
		expect(f.logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				error_class: "submission_rejected",
				consumed_retry_budget: true,
			}),
			expect.any(String),
		);
	});

	it("transport failures stay deferred without consuming attempts", async () => {
		const job = claimedJob();
		const f = fixture(job, new Error("transport timeout"));
		for (let i = 0; i < 4; i++) await f.worker.tick();
		expect(f.redeemJobs.markRpcDeferred).toHaveBeenCalledTimes(4);
		expect(job.attemptCount).toBe(0);
		expect(f.redeemJobs.markTransientFailure).not.toHaveBeenCalled();
		expect(f.redeemJobs.markAbandoned).not.toHaveBeenCalled();
		expect(f.redeemJobs.markSubmitted).not.toHaveBeenCalled();
	});

	it("foreign-funder adapter payout cannot confirm the held position", async () => {
		const job = {
			...claimedJob(),
			flavor: "neg-risk-adapter" as const,
			status: "submitted" as const,
			submittedAtBlock: 1n,
			txHashes: [TX_HASH],
		};
		const f = fixture(job);
		f.redeemJobs.claimNextPending.mockResolvedValue(null);
		f.redeemJobs.claimReaperCandidates.mockResolvedValue([job]);
		f.publicClient.getLogs.mockResolvedValue([
			{
				address: POLYGON_NEG_RISK_ADAPTER,
				topics: encodeEventTopics({
					abi: polymarketNegRiskAdapterAbi,
					eventName: "PayoutRedemption",
					args: {
						redeemer: "0x3333333333333333333333333333333333333333",
						conditionId: job.conditionId,
					},
				}),
				data: encodeAbiParameters(parseAbiParameters("uint256[], uint256"), [
					[7_000_000n, 0n],
					7_000_000n,
				]),
				transactionHash: TX_HASH,
				removed: false,
			},
		]);
		await f.worker.tick();
		expect(f.publicClient.getLogs).toHaveBeenCalledWith(
			expect.objectContaining({ args: { redeemer: FUNDER } }),
		);
		expect(f.redeemJobs.markConfirmed).not.toHaveBeenCalled();
		expect(f.redeemJobs.markAbandoned).toHaveBeenCalledWith(
			expect.objectContaining({ errorClass: "malformed" }),
		);
	});
});

describe("RedeemWorker tick persistence diagnostics", () => {
	it.each([
		{
			phase: "drain",
			code: "53300",
			event: "poly.ctf.redeem.worker_drain_error",
			message: "redeem-worker drain loop error",
		},
		{
			phase: "reap",
			code: "42501",
			event: "poly.ctf.redeem.worker_reap_error",
			message: "redeem-worker reaper loop error",
		},
	])(
		"retains bounded safe cause fields for a $phase failure",
		async ({ phase, code, event, message }) => {
			const databaseError = Object.assign(
				new Error(
					`database failure password=hidden-password Bearer hidden-bearer ${"diagnostic ".repeat(50)}`,
				),
				{ code },
			);
			const queryError = new Error(
				`Failed query: SELECT * FROM jobs WHERE id = 'hidden-job' token=hidden-token ${"query ".repeat(100)}`,
				{ cause: databaseError },
			);
			const claimNextPending = vi.fn(async () => {
				if (phase === "drain") throw queryError;
				return null;
			});
			const claimReaperCandidates = vi.fn(async () => {
				if (phase === "reap") throw queryError;
				return [];
			});
			const redeemPosition = vi.fn();
			const writeContract = vi.fn();
			const error = vi.fn();
			const worker = new RedeemWorker({
				redeemJobs: { claimNextPending, claimReaperCandidates } as never,
				orderLedger: { markPositionLifecycleByAsset: vi.fn() },
				billingAccountId: "billing-1",
				publicClient: { getBlockNumber: vi.fn(async () => 100n) } as never,
				walletClient: { writeContract } as never,
				funderAddress: FUNDER,
				account: {} as never,
				redeemPosition,
				logger: { info: vi.fn(), warn: vi.fn(), error },
				finalityBlocks: 5n,
				tickIntervalMs: 5_000,
				reaperIntervalMs: 0,
			});

			await expect(worker.tick()).resolves.toBeUndefined();

			expect(error).toHaveBeenCalledTimes(1);
			expect(error).toHaveBeenCalledWith(
				expect.objectContaining({
					event,
					err_class: "Error",
					err: expect.stringContaining("'<redacted>' token=<redacted>"),
					cause_class: "Error",
					cause_code: code,
					cause_message: expect.stringContaining(
						"password=<redacted> Bearer <redacted>",
					),
				}),
				message,
			);
			const fields = error.mock.calls[0]?.[0];
			expect(fields.err).toHaveLength(300);
			expect(fields.cause_message).toHaveLength(300);
			const serialized = JSON.stringify(fields);
			for (const secret of [
				"hidden-job",
				"hidden-token",
				"hidden-password",
				"hidden-bearer",
			]) {
				expect(serialized).not.toContain(secret);
			}
			expect(claimNextPending).toHaveBeenCalledWith(FUNDER);
			expect(claimReaperCandidates).toHaveBeenCalledWith(100n, 5n);
			expect(redeemPosition).not.toHaveBeenCalled();
			expect(writeContract).not.toHaveBeenCalled();
		},
	);
});

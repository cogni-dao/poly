// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Migrated PostgreSQL proof: durable redeem keys are claimed once, never revived. */
import { randomBytes } from "node:crypto";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { DrizzleRedeemJobsAdapter } from "@/adapters/server/redeem/drizzle-redeem-jobs.adapter";
import type { EnqueueRedeemJobInput } from "@/ports";
import { polyRedeemJobs } from "@/shared/db";

const hash = `0x${"ab".repeat(32)}` as const;
const funders: string[] = [];
const address = () => `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
const condition = () => `0x${randomBytes(32).toString("hex")}` as `0x${string}`;

function harness() {
	const db = getSeedDb();
	const funder = address();
	funders.push(funder);
	const input: EnqueueRedeemJobInput = {
		funderAddress: funder,
		conditionId: condition(),
		positionId: "1234",
		outcomeIndex: 0,
		flavor: "binary",
		indexSet: ["1"],
		collateralToken: address(),
		expectedShares: "1000000",
		expectedPayoutUsdc: "1000000",
		lifecycleState: "winner",
	};
	const restart = () => new DrizzleRedeemJobsAdapter(db);
	return { db, funder, input, adapter: restart(), restart };
}

afterEach(async () => {
	if (funders.length > 0) {
		await getSeedDb()
			.delete(polyRedeemJobs)
			.where(inArray(polyRedeemJobs.funderAddress, funders.splice(0)));
	}
});

describe("redeem durable claim holds (real PostgreSQL)", () => {
	it("two real adapters atomically claim one pending row once and isolate funders", async () => {
		const a = harness();
		const b = harness();
		const inserted = await a.adapter.enqueue(a.input);
		const foreign = await b.adapter.enqueue(b.input);
		const claims = await Promise.all([
			a.adapter.claimNextPending(a.funder),
			a.restart().claimNextPending(a.funder),
		]);
		expect(claims.filter((row) => row !== null)).toHaveLength(1);
		expect(claims.find((row) => row !== null)).toMatchObject({
			id: inserted.jobId,
			status: "claimed",
			funderAddress: a.funder,
		});
		expect(await a.restart().claimNextPending(a.funder)).toBeNull();
		expect(
			await b.adapter.findByKey(b.funder, b.input.conditionId),
		).toMatchObject({
			id: foreign.jobId,
			status: "pending",
		});
		expect(await b.restart().claimNextPending(b.funder)).toMatchObject({
			id: foreign.jobId,
			funderAddress: b.funder,
		});
	});

	it.each([0, 1, 2, 3, 99])(
		"holds failed_transient at attempt count %i across fresh adapters and winner re-enqueue",
		async (attemptCount) => {
			const h = harness();
			const { jobId } = await h.adapter.enqueue(h.input);
			expect(await h.adapter.claimNextPending(h.funder)).toMatchObject({
				id: jobId,
			});
			const audit =
				"wait timeout; Relayer transactionId=real-fixture-id; chain hash unknown";
			await h.adapter.markRpcDeferred({ jobId, error: audit });
			await h.db
				.update(polyRedeemJobs)
				.set({ attemptCount })
				.where(eq(polyRedeemJobs.id, jobId));
			const before = await h.adapter.findByKey(h.funder, h.input.conditionId);
			expect(before).toMatchObject({
				status: "failed_transient",
				attemptCount,
				lastError: audit,
				txHashes: [],
				lifecycleState: "winner",
			});
			for (let tick = 0; tick < 3; tick++) {
				const restarted = h.restart();
				expect(await restarted.claimNextPending(h.funder)).toBeNull();
				expect(
					await restarted.enqueue({ ...h.input, expectedShares: "9999999" }),
				).toEqual({ jobId, alreadyExisted: true });
				expect(
					await restarted.findByKey(h.funder, h.input.conditionId),
				).toEqual(before);
			}
		},
	);

	it.each(["old", "new"] as const)(
		"holds %s claimed timestamps without erasing evidence",
		async (age) => {
			const h = harness();
			const { jobId } = await h.adapter.enqueue(h.input);
			expect(await h.adapter.claimNextPending(h.funder)).toMatchObject({
				id: jobId,
			});
			await h.db
				.update(polyRedeemJobs)
				.set({
					updatedAt:
						age === "old" ? new Date("2000-01-01T00:00:00Z") : new Date(),
					lastError: "submission response unknown",
					txHashes: [hash],
				})
				.where(eq(polyRedeemJobs.id, jobId));
			const before = await h.adapter.findByKey(h.funder, h.input.conditionId);
			for (let tick = 0; tick < 3; tick++) {
				expect(await h.restart().claimNextPending(h.funder)).toBeNull();
				expect(await h.restart().enqueue(h.input)).toEqual({
					jobId,
					alreadyExisted: true,
				});
				expect(
					await h.adapter.findByKey(h.funder, h.input.conditionId),
				).toEqual(before);
			}
		},
	);

	it("submitted then confirmed stays confirmed after stale winner enqueue", async () => {
		const h = harness();
		const { jobId } = await h.adapter.enqueue(h.input);
		await h.adapter.claimNextPending(h.funder);
		await h.adapter.markSubmitted({
			jobId,
			txHash: hash,
			submittedAtBlock: 123n,
			receiptBurnObserved: true,
		});
		const submitted = await h.adapter.findByKey(h.funder, h.input.conditionId);
		await h.restart().enqueue(h.input);
		expect(await h.adapter.findByKey(h.funder, h.input.conditionId)).toEqual(
			submitted,
		);
		await h.adapter.markConfirmed({ jobId, txHash: hash });
		const confirmed = await h.adapter.findByKey(h.funder, h.input.conditionId);
		expect(confirmed).toMatchObject({
			status: "confirmed",
			txHashes: [hash],
			attemptCount: 1,
			submittedAtBlock: 123n,
		});
		await h.restart().enqueue(h.input);
		expect(await h.restart().claimNextPending(h.funder)).toBeNull();
		expect(await h.adapter.findByKey(h.funder, h.input.conditionId)).toEqual(
			confirmed,
		);
	});

	it("catch-up-like confirmation of a failed job cannot reopen its durable key", async () => {
		const h = harness();
		const { jobId } = await h.adapter.enqueue(h.input);
		await h.adapter.claimNextPending(h.funder);
		await h.adapter.markTransientFailure({
			jobId,
			error: "uncertain accepted handle",
		});
		// Existing catch-up can confirm a matching nonconfirmed job. No chain/finality proof is inferred.
		await h.restart().markConfirmed({ jobId, txHash: hash });
		const before = await h.adapter.findByKey(h.funder, h.input.conditionId);
		expect(before).toMatchObject({
			status: "confirmed",
			lastError: "uncertain accepted handle",
			attemptCount: 1,
		});
		await h.restart().enqueue(h.input);
		expect(await h.restart().claimNextPending(h.funder)).toBeNull();
		expect(await h.adapter.findByKey(h.funder, h.input.conditionId)).toEqual(
			before,
		);
	});

	it.each(["skipped", "abandoned"] as const)(
		"withholds %s recovery while allowing a genuinely unrelated key",
		async (status) => {
			const h = harness();
			const { jobId } = await h.adapter.enqueue({ ...h.input, status });
			await h.db
				.update(polyRedeemJobs)
				.set({
					lastError: "retained terminal diagnostic",
					txHashes: [hash],
					errorClass: "malformed",
				})
				.where(eq(polyRedeemJobs.id, jobId));
			const before = await h.adapter.findByKey(h.funder, h.input.conditionId);
			expect(await h.restart().enqueue(h.input)).toEqual({
				jobId,
				alreadyExisted: true,
			});
			expect(await h.restart().claimNextPending(h.funder)).toBeNull();
			expect(await h.adapter.findByKey(h.funder, h.input.conditionId)).toEqual(
				before,
			);
			const fresh = await h
				.restart()
				.enqueue({ ...h.input, conditionId: condition() });
			expect(fresh.alreadyExisted).toBe(false);
			expect(await h.restart().claimNextPending(h.funder)).toMatchObject({
				id: fresh.jobId,
				status: "claimed",
			});
			expect(await h.restart().claimNextPending(h.funder)).toBeNull();
		},
	);
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import type { PaperExecutorPosition } from "@/bootstrap/capabilities/poly-trade-executor";
import { readPaperAuthoritativeHoldings } from "@/bootstrap/poly-execution-venue";
import { PaperFactsUnavailableError } from "@/features/wallet-analysis/server/paper-fact-source";

const billingAccountId = "paper-holdings-test";
const conditionA = `0x${"a".repeat(64)}`;
const conditionB = `0x${"b".repeat(64)}`;
const hugeToken =
	"110616094455216194978699423493753093017667578376232016563683270718005271026032";
const book = [
	{
		conditionId: conditionA,
		tokenId: hugeToken,
		shares: 229.28,
		currentValueUsdc: 229.28,
		avgPrice: 0.21475,
	},
	{
		conditionId: conditionB,
		tokenId:
			"17007504028749979278098632250458904655913955646755634884054333765044785493477",
		shares: 67.41,
		currentValueUsdc: 28.3122,
		avgPrice: 0.4,
	},
] as const satisfies readonly PaperExecutorPosition[];
const requested = (count: number) => [
	{
		conditionId: conditionA.toUpperCase().replace("0X", "0x"),
		tokenId: hugeToken,
	},
	{ conditionId: conditionB, tokenId: book[1].tokenId },
	...Array.from({ length: count - 2 }, (_, i) => ({
		conditionId: conditionA,
		tokenId: String(i + 1),
	})),
];
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("paper authoritative holdings composition", () => {
	it.each([84, 840])(
		"reads one complete book for %i exact requests",
		async (count) => {
			const listOpenPositions = vi.fn(async () => book);
			// This existing executor seam must remain unused by the holdings helper.
			const getPositionShareBalance = vi.fn();
			const holdings = await readPaperAuthoritativeHoldings({
				source: Object.assign({ listOpenPositions }, { getPositionShareBalance }),
				billingAccountId,
				requested: requested(count),
			});
			expect(listOpenPositions).toHaveBeenCalledTimes(1);
			expect(listOpenPositions).toHaveBeenCalledWith(billingAccountId);
			expect(getPositionShareBalance).not.toHaveBeenCalled();
			expect(holdings).toHaveLength(count);
			expect(holdings.slice(0, 2)).toEqual([
				{ conditionId: conditionA, tokenId: hugeToken, shares: 229.28 },
				{ conditionId: conditionB, tokenId: book[1].tokenId, shares: 67.41 },
			]);
			expect(holdings.slice(2).every((holding) => holding.shares === 0)).toBe(
				true,
			);
		},
	);

	it.each([
		"no_paper_wallet",
		"never_projected",
		"projection_stale",
		"projection_incomplete",
	] as const)("propagates %s without zero substitution", async (reason) => {
		const failure = new PaperFactsUnavailableError(billingAccountId, reason);
		const source = { listOpenPositions: vi.fn().mockRejectedValue(failure) };
		await expect(
			readPaperAuthoritativeHoldings({
				source,
				billingAccountId,
				requested: requested(84),
			}),
		).rejects.toBe(failure);
		expect(source.listOpenPositions).toHaveBeenCalledTimes(1);
	});

	it.each([
		[{ conditionId: conditionB, tokenId: hugeToken }],
		[{ conditionId: conditionA, tokenId: "01" }],
		[{ conditionId: "0xshort", tokenId: "1" }],
		[{ conditionId: conditionA, tokenId: 1 }],
		[{ conditionId: conditionA, tokenId: hugeToken }, { conditionId: conditionA, tokenId: hugeToken }],
		[
			{ conditionId: conditionA, tokenId: hugeToken },
			{ conditionId: conditionB, tokenId: hugeToken },
		],
	])(
		"rejects malformed, duplicate, or conflicting requests %#",
		async (...legs) => {
			const source = { listOpenPositions: vi.fn(async () => book) };
			await expect(
				readPaperAuthoritativeHoldings({
					source,
					billingAccountId,
					requested: legs as { conditionId: string; tokenId: string }[],
				}),
			).rejects.toMatchObject({ reason: "projection_incomplete" });
		},
	);

	it.each([
		[...book, book[0]],
		[...book, { ...book[0], conditionId: conditionB }],
		[{ ...book[0], tokenId: "01" }],
		[{ ...book[0], shares: NaN }],
		[{ ...book[0], shares: 0 }],
		[{ ...book[0], currentValueUsdc: -1 }],
		[{ ...book[0], avgPrice: Infinity }],
	])("rejects corrupt complete-book facts %#", async (...positions) => {
		const source = { listOpenPositions: vi.fn(async () => positions) };
		await expect(
			readPaperAuthoritativeHoldings({
				source,
				billingAccountId,
				requested: requested(2),
			}),
		).rejects.toMatchObject({ reason: "projection_incomplete" });
	});

	it("keeps a deferred read pending without per-token reload or cancellation overlap", async () => {
		const result = deferred<readonly PaperExecutorPosition[]>();
		const source = { listOpenPositions: vi.fn(() => result.promise) };
		const controller = new AbortController();
		let settled = false;
		const run = readPaperAuthoritativeHoldings({
			source,
			billingAccountId,
			requested: requested(840),
			signal: controller.signal,
		});
		const observed = run.finally(() => {
			settled = true;
		});
		// Attach the rejection assertion before releasing the deferred operation.
		const rejected = expect(observed).rejects.toMatchObject({
			name: "AbortError",
		});
		controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(source.listOpenPositions).toHaveBeenCalledTimes(1);
		result.resolve(book);
		await rejected;
		expect(settled).toBe(true);
		expect(source.listOpenPositions).toHaveBeenCalledTimes(1);
	});

	it("does not dispatch an already canceled read", async () => {
		const controller = new AbortController();
		controller.abort();
		const source = { listOpenPositions: vi.fn(async () => book) };
		await expect(
			readPaperAuthoritativeHoldings({
				source,
				billingAccountId,
				requested: requested(2),
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(source.listOpenPositions).not.toHaveBeenCalled();
	});
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/tests/polymarket-clob-public-client`
 * Purpose: Prove that paper marks use a live midpoint while trading and the
 *   CLOB's unique winner fact after settlement.
 * Scope: Injected fetch mock only. No network, persistence, or credentials.
 * Invariants:
 *   - NO_FABRICATED_VALUES: a missing/contradictory settlement remains null.
 *   - SETTLEMENT_IS_AUTHORITATIVE: a closed market's winner is 1 and loser 0.
 * Side-effects: none.
 * Links: docs/spec/capability-plane.md, story.5016
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import { PolymarketClobPublicClient } from "../src/adapters/polymarket/index.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		statusText: ok ? "OK" : "ERR",
		json: async () => body,
	} as unknown as Response;
}

describe("PolymarketClobPublicClient.getMarkPrice", () => {
	const conditionId = "0xcondition";
	const winner = "111";
	const loser = "222";

	it("uses the live midpoint without requesting resolution", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ mid: "0.42" }));
		const client = new PolymarketClobPublicClient({ fetch: fetchImpl });

		await expect(client.getMarkPrice(conditionId, winner)).resolves.toBe(0.42);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl.mock.calls[0]?.[0]).toContain("/midpoint");
	});

	it.each([
		[winner, 1],
		[loser, 0],
	] as const)(
		"uses the closed market winner fact for token %s",
		async (tokenId, mark) => {
			const fetchImpl = vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({}, false, 404))
				.mockResolvedValueOnce(
					jsonResponse({
						closed: true,
						tokens: [
							{ token_id: winner, winner: true },
							{ token_id: loser, winner: false },
						],
					}),
				);
			const client = new PolymarketClobPublicClient({ fetch: fetchImpl });

			await expect(client.getMarkPrice(conditionId, tokenId)).resolves.toBe(
				mark,
			);
			expect(fetchImpl).toHaveBeenCalledTimes(2);
			expect(fetchImpl.mock.calls[1]?.[0]).toContain(`/markets/${conditionId}`);
		},
	);

	it.each([
		{
			closed: false,
			tokens: [{ token_id: winner, winner: true }],
		},
		{
			closed: true,
			tokens: [
				{ token_id: winner, winner: false },
				{ token_id: loser, winner: false },
			],
		},
		{
			closed: true,
			tokens: [
				{ token_id: winner, winner: true },
				{ token_id: loser, winner: true },
			],
		},
	])("refuses an unavailable or contradictory settlement", async (market) => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({}, false, 404))
			.mockResolvedValueOnce(jsonResponse(market));
		const client = new PolymarketClobPublicClient({ fetch: fetchImpl });

		await expect(client.getMarkPrice(conditionId, winner)).resolves.toBeNull();
	});
});

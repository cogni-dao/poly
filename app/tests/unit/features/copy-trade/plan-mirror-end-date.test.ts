// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * bug.5056 — `market_past_end_date` must not skip live in-play sports markets
 * whose Gamma full-ISO `endDate` equals kickoff. bug.5007 date-only semantics
 * are preserved.
 */

import type { Fill } from "@cogni/poly-market-provider";
import { describe, expect, it } from "vitest";
import { planMirrorFromFill } from "@/features/copy-trade/plan-mirror";
import type { MirrorTargetConfig } from "@/features/copy-trade/types";

const TARGET = "0x2005d16a00000000000000000000000000000000";
const COID =
	"0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const HOUR = 60 * 60 * 1000;
const KICKOFF = "2026-11-11T01:00:00Z";
const KICKOFF_MS = Date.parse(KICKOFF);

const config: MirrorTargetConfig = {
	target_id: "11111111-1111-4111-8111-111111111111",
	target_wallet: TARGET,
	billing_account_id: "billing-1",
	created_by_user_id: "user-1",
	sizing: { kind: "mirror_fill_exact" },
	placement: { kind: "mirror_limit" },
};

function plan(
	attributes: Record<string, unknown>,
	now_ms: number,
): ReturnType<typeof planMirrorFromFill> {
	const fill: Fill = {
		target_wallet: TARGET,
		fill_id: "chain:end-date",
		source: "chain",
		market_id: "prediction-market:polymarket:condition",
		outcome: "YES",
		side: "BUY",
		price: 0.5,
		size_usdc: 50,
		observed_at: "2026-11-11T02:00:00.000Z",
		attributes: { asset: "token-1", ...attributes },
	};
	return planMirrorFromFill({
		fill,
		config,
		state: { already_placed_ids: [], placed_fill_ids: [] },
		client_order_id: COID,
		min_shares: 1,
		min_usdc_notional: 1,
		now_ms,
	});
}

const skipped = (p: ReturnType<typeof plan>) =>
	p.kind === "skip" && p.reason === "market_past_end_date";

describe("market_past_end_date (bug.5056 + bug.5007)", () => {
	it("date-only end date: end-of-day grace (existing bug.5007)", () => {
		const day = Date.parse("2026-11-10");
		expect(skipped(plan({ end_date: "2026-11-10" }, day + 23 * HOUR))).toBe(
			false,
		);
		expect(skipped(plan({ end_date: "2026-11-10" }, day + 24 * HOUR))).toBe(
			true,
		);
	});

	it("full-ISO kickoff end date with accepting_orders=true is NOT skipped", () => {
		const p = plan(
			{
				end_date: KICKOFF,
				game_start_time: KICKOFF,
				accepting_orders: true,
				closed: false,
			},
			KICKOFF_MS + 48 * HOUR,
		);
		expect(skipped(p)).toBe(false);
	});

	it("closed market is skipped even inside the grace window", () => {
		expect(
			skipped(plan({ end_date: KICKOFF, closed: true }, KICKOFF_MS + HOUR)),
		).toBe(true);
	});

	it("not-accepting-orders market is skipped even before end date", () => {
		expect(
			skipped(
				plan({ end_date: KICKOFF, accepting_orders: false }, KICKOFF_MS - HOUR),
			),
		).toBe(true);
	});

	it("no liveness facts: within 6h grace of kickoff end date is not skipped", () => {
		expect(skipped(plan({ end_date: KICKOFF }, KICKOFF_MS + 2 * HOUR))).toBe(
			false,
		);
		expect(skipped(plan({ end_date: KICKOFF }, KICKOFF_MS + 5.9 * HOUR))).toBe(
			false,
		);
	});

	it("no liveness facts: beyond 6h grace is skipped", () => {
		expect(skipped(plan({ end_date: KICKOFF }, KICKOFF_MS + 6 * HOUR))).toBe(
			true,
		);
		expect(
			skipped(
				plan(
					{ end_date: KICKOFF, game_start_time: KICKOFF },
					KICKOFF_MS + 7 * HOUR,
				),
			),
		).toBe(true);
	});

	it("missing end_date never skips", () => {
		expect(skipped(plan({}, KICKOFF_MS + 100 * HOUR))).toBe(false);
	});
});

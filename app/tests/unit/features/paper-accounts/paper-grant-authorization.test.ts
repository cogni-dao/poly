// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/paper-accounts/paper-grant-authorization.test`
 * Purpose: Prove the paper venue runs a REAL authorization sequence. The build
 *   this replaces skipped `authorizeIntent` entirely and logged
 *   `authorize_bypassed: true`, so no grant cap was ever exercised on a paper
 *   deployment — the algorithm ran against caps that could not deny it.
 * Scope: Unit — the two pure evaluators. The DB wrapper around them is proven in
 *   `tests/component/db/execution-venue.int.test.ts`.
 * Invariants:
 *   - SAME_DECISION_SEQUENCE as the live adapter: approvals → grant → expiry →
 *     scope → per-order → daily → hourly
 *   - FAIL_CLOSED: every missing precondition denies
 * Side-effects: none
 * Links: src/features/paper-accounts/server/paper-venue.ts
 * @internal
 */

import type { OrderIntentSummary } from "@cogni/poly-wallet";
import { describe, expect, it } from "vitest";

import {
	evaluatePaperCapWindows,
	evaluatePaperGrantPreconditions,
	type PaperGrantFacts,
} from "@/features/paper-accounts";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const READY_AT = new Date("2026-10-01T00:00:00.000Z");

const buy: OrderIntentSummary = {
	side: "BUY",
	usdcAmount: 5,
	marketConditionId: "0xcondition",
};

function grant(overrides: Partial<PaperGrantFacts> = {}): PaperGrantFacts {
	return {
		id: "grant-1",
		scopes: ["poly:trade:buy", "poly:trade:sell"],
		perOrderUsdcCap: 10,
		dailyUsdcCap: 50,
		hourlyFillsCap: 10,
		expiresAt: null,
		...overrides,
	};
}

describe("paper grant preconditions", () => {
	it("authorizes an intent inside its grant", () => {
		expect(
			evaluatePaperGrantPreconditions({
				intent: buy,
				tradingApprovalsReadyAt: READY_AT,
				grant: grant(),
				now: NOW,
			}),
		).toEqual({ ok: true, grantId: "grant-1" });
	});

	it("denies when the approvals stamp is missing", () => {
		expect(
			evaluatePaperGrantPreconditions({
				intent: buy,
				tradingApprovalsReadyAt: null,
				grant: grant(),
				now: NOW,
			}),
		).toEqual({ ok: false, reason: "trading_not_ready" });
	});

	it("denies when the account has no active grant", () => {
		expect(
			evaluatePaperGrantPreconditions({
				intent: buy,
				tradingApprovalsReadyAt: READY_AT,
				grant: null,
				now: NOW,
			}),
		).toEqual({ ok: false, reason: "no_active_grant" });
	});

	it("denies an expired grant", () => {
		expect(
			evaluatePaperGrantPreconditions({
				intent: buy,
				tradingApprovalsReadyAt: READY_AT,
				grant: grant({ expiresAt: new Date(NOW.getTime() - 1) }),
				now: NOW,
			}),
		).toEqual({ ok: false, reason: "grant_expired" });
	});

	it("denies a side the grant does not scope", () => {
		expect(
			evaluatePaperGrantPreconditions({
				intent: { ...buy, side: "SELL" },
				tradingApprovalsReadyAt: READY_AT,
				grant: grant({ scopes: ["poly:trade:buy"] }),
				now: NOW,
			}),
		).toEqual({ ok: false, reason: "scope_missing" });
	});

	it("enforces the per-order cap — the cap paper never used to feel", () => {
		expect(
			evaluatePaperGrantPreconditions({
				intent: { ...buy, usdcAmount: 10.01 },
				tradingApprovalsReadyAt: READY_AT,
				grant: grant({ perOrderUsdcCap: 10 }),
				now: NOW,
			}),
		).toEqual({ ok: false, reason: "cap_exceeded_per_order" });
	});
});

describe("paper cap windows", () => {
	it("counts in-flight spend against the daily cap", () => {
		expect(
			evaluatePaperCapWindows({
				intent: buy,
				grant: grant({ dailyUsdcCap: 50 }),
				spent24hUsdc: 45.01,
				fillsLastHour: 0,
			}),
		).toEqual({ ok: false, reason: "cap_exceeded_daily" });
	});

	it("allows an intent that exactly reaches the daily cap", () => {
		expect(
			evaluatePaperCapWindows({
				intent: buy,
				grant: grant({ dailyUsdcCap: 50 }),
				spent24hUsdc: 45,
				fillsLastHour: 0,
			}),
		).toEqual({ ok: true, grantId: "grant-1" });
	});

	it("enforces the hourly fill-count cap", () => {
		expect(
			evaluatePaperCapWindows({
				intent: buy,
				grant: grant({ hourlyFillsCap: 3 }),
				spent24hUsdc: 0,
				fillsLastHour: 3,
			}),
		).toEqual({ ok: false, reason: "cap_exceeded_hourly_fills" });
	});
});

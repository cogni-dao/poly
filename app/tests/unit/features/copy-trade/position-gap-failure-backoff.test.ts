// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
	POSITION_GAP_FAILURE_BACKOFF_CAP_MS,
	PositionGapFailureBackoff,
	positionGapFailureBackoffMs,
} from "@/features/copy-trade/position-gap-failure-backoff";

describe("positionGapFailureBackoffMs", () => {
	it("doubles from 15s and caps at 5 minutes", () => {
		expect([1, 2, 3, 4, 5, 6, 7].map(positionGapFailureBackoffMs)).toEqual([
			15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
		]);
		expect(positionGapFailureBackoffMs(10_000)).toBe(
			POSITION_GAP_FAILURE_BACKOFF_CAP_MS,
		);
	});

	it("is zero without failures", () => {
		expect(positionGapFailureBackoffMs(0)).toBe(0);
	});
});

describe("PositionGapFailureBackoff", () => {
	it("opens a growing window per consecutive failure and resets on success", () => {
		const backoff = new PositionGapFailureBackoff();
		expect(backoff.remainingMs(0)).toBe(0);

		expect(backoff.recordFailure(1_000)).toEqual({
			consecutiveFailures: 1,
			backoffMs: 15_000,
		});
		expect(backoff.remainingMs(1_000)).toBe(15_000);
		expect(backoff.remainingMs(11_000)).toBe(5_000);
		expect(backoff.remainingMs(16_000)).toBe(0);

		expect(backoff.recordFailure(16_000)).toEqual({
			consecutiveFailures: 2,
			backoffMs: 30_000,
		});

		expect(backoff.recordSuccess()).toBe(2);
		expect(backoff.remainingMs(16_001)).toBe(0);
		expect(backoff.recordFailure(20_000).backoffMs).toBe(15_000);
		expect(new PositionGapFailureBackoff().recordSuccess()).toBe(0);
	});
});

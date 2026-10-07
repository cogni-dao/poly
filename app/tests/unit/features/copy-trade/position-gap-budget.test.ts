// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
	effectivePositionGapBudget,
	summarizePositionGapBudgetGroup,
} from "@/features/copy-trade/position-gap-budget";

describe("position-gap portfolio budgets", () => {
	it("gives one automatic target the full live NAV", () => {
		const group = summarizePositionGapBudgetGroup([null], 0);

		expect(
			effectivePositionGapBudget({
				configuredBudgetUsdc: null,
				mirrorNavUsdc: 500,
				group,
			}),
		).toEqual({
			effectiveBudgetUsdc: 500,
			allocationStatus: "full",
			overallocated: false,
		});
	});

	it("splits live NAV evenly across multiple automatic targets", () => {
		const group = summarizePositionGapBudgetGroup([null, null], 0);

		expect(
			effectivePositionGapBudget({
				configuredBudgetUsdc: null,
				mirrorNavUsdc: 500,
				group,
			}),
		).toEqual({
			effectiveBudgetUsdc: 250,
			allocationStatus: "shared_remainder",
			overallocated: false,
		});
	});

	it("reserves explicit dollars and splits only the remainder", () => {
		const group = summarizePositionGapBudgetGroup([200, null, null], 1);

		expect(
			effectivePositionGapBudget({
				configuredBudgetUsdc: 200,
				mirrorNavUsdc: 500,
				group,
			}),
		).toMatchObject({
			effectiveBudgetUsdc: 200,
			allocationStatus: "reserved",
		});
		expect(
			effectivePositionGapBudget({
				configuredBudgetUsdc: null,
				mirrorNavUsdc: 500,
				group,
			}),
		).toMatchObject({
			effectiveBudgetUsdc: 150,
			allocationStatus: "shared_remainder",
		});
	});

	it("prorates explicit over-allocation and leaves automatic targets zero", () => {
		const group = summarizePositionGapBudgetGroup([400, 200, null], 0);

		expect(
			effectivePositionGapBudget({
				configuredBudgetUsdc: 400,
				mirrorNavUsdc: 300,
				group,
			}),
		).toEqual({
			effectiveBudgetUsdc: 200,
			allocationStatus: "prorated",
			overallocated: true,
		});
		expect(
			effectivePositionGapBudget({
				configuredBudgetUsdc: null,
				mirrorNavUsdc: 300,
				group,
			}),
		).toEqual({
			effectiveBudgetUsdc: 0,
			allocationStatus: "shared_remainder",
			overallocated: true,
		});
	});

	it("rejects invalid configured or observed values", () => {
		const group = summarizePositionGapBudgetGroup([null], 0);
		expect(
			effectivePositionGapBudget({
				configuredBudgetUsdc: 0,
				mirrorNavUsdc: 25,
				group,
			}),
		).toBeUndefined();
		expect(
			effectivePositionGapBudget({
				configuredBudgetUsdc: null,
				mirrorNavUsdc: Number.NaN,
				group,
			}),
		).toBeUndefined();
	});
});

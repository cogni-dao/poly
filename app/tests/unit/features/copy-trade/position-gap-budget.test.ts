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

	it("reserves an explicit budget below live NAV", () => {
		const group = summarizePositionGapBudgetGroup([200], 1);

		expect(
			effectivePositionGapBudget({
				configuredBudgetUsdc: 200,
				mirrorNavUsdc: 500,
				group,
			}),
		).toEqual({
			effectiveBudgetUsdc: 200,
			allocationStatus: "reserved",
			overallocated: false,
		});
	});

	it("prorates one explicit budget to live NAV", () => {
		const group = summarizePositionGapBudgetGroup([600], 0);

		expect(
			effectivePositionGapBudget({
				configuredBudgetUsdc: 600,
				mirrorNavUsdc: 300,
				group,
			}),
		).toEqual({
			effectiveBudgetUsdc: 300,
			allocationStatus: "prorated",
			overallocated: true,
		});
	});

	it("fails closed when multiple position-gap targets share one wallet", () => {
		expect(
			effectivePositionGapBudget({
				configuredBudgetUsdc: null,
				mirrorNavUsdc: 500,
				group: summarizePositionGapBudgetGroup([null, null], 0),
			}),
		).toBeUndefined();
		expect(
			effectivePositionGapBudget({
				configuredBudgetUsdc: 200,
				mirrorNavUsdc: 500,
				group: summarizePositionGapBudgetGroup([200, null], 0),
			}),
		).toBeUndefined();
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

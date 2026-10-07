// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
	evaluateClobCollateralPreflight,
	requiredBuyCollateralAtomic,
} from "@/bootstrap/capabilities/poly-trade-executor";

describe("requiredBuyCollateralAtomic", () => {
	it("reserves 10% above the visible BUY intent", () => {
		expect(requiredBuyCollateralAtomic(5)).toBe(5_500_000n);
	});

	it("rounds fractional atomic units up", () => {
		expect(requiredBuyCollateralAtomic(0.0000011)).toBe(2n);
	});

	it("returns zero for invalid or non-positive input", () => {
		expect(requiredBuyCollateralAtomic(0)).toBe(0n);
		expect(requiredBuyCollateralAtomic(Number.NaN)).toBe(0n);
	});
});

describe("evaluateClobCollateralPreflight", () => {
	it("rejects balance before allowance", () => {
		expect(
			evaluateClobCollateralPreflight({
				requiredAtomic: 5_500_000n,
				balanceAtomic: 702_010n,
				allowanceAtomic: 0n,
			}),
		).toBe("insufficient_balance");
	});

	it("rejects an insufficient applicable allowance", () => {
		expect(
			evaluateClobCollateralPreflight({
				requiredAtomic: 5_500_000n,
				balanceAtomic: 6_000_000n,
				allowanceAtomic: 0n,
			}),
		).toBe("insufficient_allowance");
	});

	it("accepts only when both are sufficient", () => {
		expect(
			evaluateClobCollateralPreflight({
				requiredAtomic: 5_500_000n,
				balanceAtomic: 6_000_000n,
				allowanceAtomic: 6_000_000n,
			}),
		).toBeNull();
	});
});

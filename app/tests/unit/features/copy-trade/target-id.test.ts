// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { targetIdFromWallet as copyTradeTargetIdFromWallet } from "@/features/copy-trade/target-id";
import { targetIdFromWallet as sharedTargetIdFromWallet } from "@/shared/util/poly-target-id";

describe("copy-target identity authority", () => {
	it("keeps the public copy-trade export case-insensitive and pinned to the shared known vector", () => {
		const lower = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" as const;
		const upper = lower.toUpperCase() as `0x${string}`;
		const expected = "558c1991-c01c-5b00-8491-b536d35c553c";

		expect(sharedTargetIdFromWallet(lower)).toBe(expected);
		expect(sharedTargetIdFromWallet(upper)).toBe(expected);
		expect(copyTradeTargetIdFromWallet(lower)).toBe(expected);
		expect(copyTradeTargetIdFromWallet(upper)).toBe(expected);
	});
});

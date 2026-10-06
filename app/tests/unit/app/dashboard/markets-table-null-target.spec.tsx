// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** UI regression: unavailable target facts render an em dash, never $0.00. */
import { describe, expect, it } from "vitest";
import { formatMarketUsd } from "@/app/(app)/_components/markets-table/format";

describe("markets table unavailable target facts", () => {
	it("formats null as unavailable without fabricating zero", () => {
		expect(formatMarketUsd(null)).toBe("—");
		expect(formatMarketUsd(null)).not.toBe("$0.00");
		expect(formatMarketUsd(0)).toBe("$0.00");
	});
});

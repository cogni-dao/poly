// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
	envTargetSource,
	type SizingPolicyKind,
} from "@/features/copy-trade/target-source";

const WALLET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" as const;

describe("copy-trade assignment liveness", () => {
	it("requires the exact durable row, tenant, revision, and policy kind", async () => {
		const source = envTargetSource([WALLET]);
		const [target] = await source.listAllActive();
		expect(target).toBeDefined();
		if (!target) return;

		const current = {
			targetRowId: target.targetRowId,
			billingAccountId: target.billingAccountId,
			mirrorActivatedAt: target.mirrorActivatedAt,
			sizingPolicyKind: target.sizingPolicyKind,
		};
		expect(await source.isAssignmentCurrent(current)).toBe(true);

		const staleCases = [
			{ ...current, targetRowId: "different-row" },
			{ ...current, billingAccountId: "different-account" },
			{ ...current, mirrorActivatedAt: new Date(1) },
			{
				...current,
				sizingPolicyKind: "position_gap" as SizingPolicyKind,
			},
		];
		for (const stale of staleCases) {
			expect(await source.isAssignmentCurrent(stale)).toBe(false);
		}
	});
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
	classifyRedeemError,
	type DecodedRedeemError,
	permanentRedeemReason,
	REDEEM_MAX_TRANSIENT_ATTEMPTS,
	transition,
} from "@/core";

const base: DecodedRedeemError = {
	reason: null,
	data: null,
	shortMessage: "",
};

describe("classifyRedeemError (bug.5047)", () => {
	it("parks the deterministic unsupported-module rejection as permanent_input", () => {
		const err = {
			...base,
			shortMessage: "Position ID must use a supported protocol v2 module",
			errorName: "UserInputError",
		};
		expect(classifyRedeemError(err)).toBe("permanent_input");
		expect(permanentRedeemReason(err)).toBe("unsupported_position_module");
	});

	it("detects the rejection by message alone (no error name)", () => {
		const err = {
			...base,
			shortMessage: "x",
			message: "Position ID must use a supported protocol v2 module",
		};
		expect(classifyRedeemError(err)).toBe("permanent_input");
	});

	it.each([
		"Position ID must be a uint256 value",
		"Protocol v2 position ID must be a YES/NO position ID",
		"Position has no balance to redeem",
	])("treats SDK input validation %s as permanent", (message) => {
		const err = { ...base, shortMessage: message };
		expect(classifyRedeemError(err)).toBe("permanent_input");
		expect(permanentRedeemReason(err)).toBe("invalid_position_input");
	});

	it("treats any UserInputError as permanent", () => {
		expect(
			classifyRedeemError({
				...base,
				shortMessage: "something new",
				errorName: "UserInputError",
			}),
		).toBe("permanent_input");
	});

	it("keeps chain reverts on the budgeted chain_revert path", () => {
		expect(classifyRedeemError({ ...base, reason: "execution reverted" })).toBe(
			"chain_revert",
		);
		expect(classifyRedeemError({ ...base, data: "0x08c379a0" })).toBe(
			"chain_revert",
		);
		expect(
			classifyRedeemError({
				...base,
				shortMessage: 'The contract function "redeemPositions" reverted.',
			}),
		).toBe("chain_revert");
	});

	it.each([
		{ errorName: "HttpRequestError", shortMessage: "HTTP request failed." },
		{ errorName: "TimeoutError", shortMessage: "The request timed out." },
		{ shortMessage: "fetch failed" },
		{ shortMessage: "Too Many Requests 429" },
		{ shortMessage: "connect ECONNRESET 1.2.3.4:443" },
		{ shortMessage: "503 Service Unavailable" },
	])("keeps positive transport evidence free (rpc_transient): %o", (e) => {
		expect(classifyRedeemError({ ...base, ...e })).toBe("rpc_transient");
	});

	it("does NOT treat an unrecognised failure as free RPC flake", () => {
		expect(
			classifyRedeemError({ ...base, shortMessage: "something unexpected" }),
		).toBe("unclassified");
	});
});

describe("unclassified failures consume the retry budget (bug.5047)", () => {
	it("abandons after REDEEM_MAX_TRANSIENT_ATTEMPTS transient_failure events", () => {
		let attemptCount = 0;
		let status: string = "claimed";
		for (let i = 0; i < REDEEM_MAX_TRANSIENT_ATTEMPTS; i++) {
			const r = transition(
				{
					status: "claimed",
					attemptCount,
					receiptBurnObserved: null,
					txHashes: [],
				},
				{ kind: "transient_failure", error: "something unexpected" },
			);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.transition.incrementAttemptCount).toBe(true);
			attemptCount += 1;
			status = r.transition.nextStatus;
		}
		expect(status).toBe("abandoned");
	});

	it("rpc_transient_failure still does not bump attempt_count (bug.5041)", () => {
		const r = transition(
			{
				status: "claimed",
				attemptCount: 0,
				receiptBurnObserved: null,
				txHashes: [],
			},
			{ kind: "rpc_transient_failure", error: "fetch failed" },
		);
		expect(r.ok && r.transition.incrementAttemptCount).toBe(false);
	});
});

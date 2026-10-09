// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/copy-trade/local-live-canary`
 * Purpose: Prove the local live-money gate fails closed before any I/O.
 * Scope: Pure runtime gate and deterministic fixed-input identity only.
 * Invariants: local development, non-CI, live dispatch, explicit consent,
 *   known SHA, and explicit permitted egress are all mandatory.
 * Side-effects: none.
 * Links: task.1791070987
 * @internal
 */

import { POLY_LOCAL_LIVE_CONFIRMATION } from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";
import {
	assertLocalLiveCanaryRuntime,
	assertPersistedDecisionCorrelation,
	fixedInputId,
	LOCAL_LIVE_CANARY_ALGORITHM,
	LOCAL_LIVE_CANARY_HARD_CAP_USDC,
	type LocalLiveCanaryError,
	type LocalLiveCanaryRuntimeGate,
} from "@/features/copy-trade/local-live-canary";

const permittedGate: LocalLiveCanaryRuntimeGate = {
	nodeEnv: "development",
	appEnv: "production",
	ci: undefined,
	paperEnforceMode: undefined,
	localSha: "abcdef123456",
	confirmation: POLY_LOCAL_LIVE_CONFIRMATION,
	egress: {
		latched: false,
		lastVerdict: "permitted",
		egressCountry: "GB",
		egressRegion: null,
	},
};

function expectCode(
	mutate: (gate: LocalLiveCanaryRuntimeGate) => void,
	code: LocalLiveCanaryError["code"],
): void {
	const gate = structuredClone(permittedGate);
	mutate(gate);
	expect(() => assertLocalLiveCanaryRuntime(gate)).toThrowError(
		expect.objectContaining({ code }),
	);
}

describe("local live algorithm canary gate", () => {
	it("accepts only the explicit local non-CI live configuration", () => {
		expect(() => assertLocalLiveCanaryRuntime(permittedGate)).not.toThrow();
		expect(LOCAL_LIVE_CANARY_ALGORITHM.orderUsdc).toBeGreaterThan(0);
		expect(LOCAL_LIVE_CANARY_ALGORITHM.orderUsdc).toBeLessThanOrEqual(
			LOCAL_LIVE_CANARY_HARD_CAP_USDC,
		);
	});

	it("refuses missing consent, deployed runtimes, CI, and paper dispatch", () => {
		expectCode((gate) => {
			gate.confirmation = "yes";
		}, "confirmation_required");
		expectCode((gate) => {
			gate.nodeEnv = "production";
		}, "local_development_only");
		expectCode((gate) => {
			gate.ci = "true";
		}, "ci_forbidden");
		expectCode((gate) => {
			gate.paperEnforceMode = "paper";
		}, "live_dispatch_required");
	});

	it("refuses blocked, latched, unreachable, or unknown egress", () => {
		expectCode((gate) => {
			gate.egress.lastVerdict = "blocked";
		}, "egress_geoblocked");
		expectCode((gate) => {
			gate.egress.latched = true;
		}, "egress_geoblocked");
		expectCode((gate) => {
			gate.egress.lastVerdict = "unreachable";
		}, "egress_unproven");
		expectCode((gate) => {
			gate.egress.lastVerdict = null;
		}, "egress_unproven");
	});

	it("keeps fixed-input identity independent of algorithm version", () => {
		const fixedInput = {
			condition_id: `0x${"ab".repeat(32)}`,
			token_id: "123456789",
			outcome: "YES",
			price: 0.2,
		} as const;

		expect(fixedInputId(fixedInput)).toBe(fixedInputId({ ...fixedInput }));
		expect(fixedInputId(fixedInput)).toMatch(/^0x[a-f0-9]{64}$/);
	});

	it("accepts only persisted decision receipt correlation for this run", () => {
		expect(
			assertPersistedDecisionCorrelation({
				receipt: {
					correlation_id: "local-canary-abc",
					algorithm_version: "v1",
				},
				expectedCorrelationId: "local-canary-abc",
				expectedAlgorithmVersion: "v1",
			}),
		).toEqual({
			correlationId: "local-canary-abc",
			algorithmVersion: "v1",
		});
		expect(() =>
			assertPersistedDecisionCorrelation({
				receipt: {
					correlation_id: "local-canary-other",
					algorithm_version: "v1",
				},
				expectedCorrelationId: "local-canary-abc",
				expectedAlgorithmVersion: "v1",
			}),
		).toThrowError(
			expect.objectContaining({ code: "canary_execution_failed" }),
		);
	});
});

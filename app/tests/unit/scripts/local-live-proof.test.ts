// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Purpose: Pin the local real-money proof gate and before/after scorecard.
 * Scope: Pure proof tooling; no network, database, or order placement.
 * Invariants: development-only, never CI, exact confirmation, fail-closed geo,
 * authenticated/enabled tenant, <=$2, full correlation, same-SHA update <60s.
 */

import type { PolyLocalLiveCanaryOutput } from "@cogni/poly-node-contracts";
import { describe, expect, it, vi } from "vitest";
import {
	collectCorrelatedLogEvidence,
	evaluateLiveMoneyGate,
	evaluateProof,
	findLeakedSecretNames,
	HUMAN_PASTE_FIELDS,
	LIVE_CANARY_SCHEMA_VERSION,
	LIVE_PROOF_CONFIRMATION,
	LIVE_PROOF_SCHEMA_VERSION,
	type LiveMoneyGateInput,
	type LocalLiveProofEvidence,
	type ProofAttempt,
	REQUIRED_LIVE_PROOF_LOG_EVENTS,
	runGuardedLivePlacement,
} from "../../../../scripts/local-live-proof/proof-contract";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function gate(overrides: Partial<LiveMoneyGateInput> = {}): LiveMoneyGateInput {
	return {
		env: { NODE_ENV: "development", APP_ENV: "production" },
		confirmation: LIVE_PROOF_CONFIRMATION,
		algorithmUsdc: 1,
		authenticated: true,
		tradingEnabled: true,
		dbIsolationVerified: true,
		egress: { verdict: "permitted", country: "GB" },
		...overrides,
	};
}

function response(
	version: string,
	orderUsdc: number,
	correlation: string,
	orderId: string,
	decision: { outcome: "placed"; reason: string | null; size_usdc: number },
): PolyLocalLiveCanaryOutput {
	return {
		schema_version: LIVE_CANARY_SCHEMA_VERSION,
		local_sha: SHA,
		fixed_input_id: `0x${"a".repeat(64)}`,
		correlation_id: correlation,
		algorithm_version: version,
		algorithm_parameter: { order_usdc: orderUsdc },
		market_eligibility: {
			eligible: true,
			min_shares: 5,
			min_usdc_notional: 1,
			floor_usdc: 1,
			normalized_price: 0.5,
			tick_size: 0.01,
		},
		decision,
		ledger: {
			fill_id: `local-canary:${version}:sha256:fixed-input`,
			client_order_id: `0xclient${version}`,
			order_id: orderId,
			status: "open",
			correlation_id: correlation,
			algorithm_version: version,
		},
		clob: {
			order_id: orderId,
			status: "open",
			status_source: "placement_receipt",
		},
		cleanup: { attempted: true, status: "canceled", error: null },
		api: {
			request_id: `request-${version}`,
			route_id: "poly.dev.live_algorithm_canary",
			correlation_id: correlation,
		},
	};
}

function attempt(
	phase: "before" | "after",
	canary: PolyLocalLiveCanaryOutput,
	expected: ProofAttempt["expected_decision"],
	durationMs = 1_000,
): ProofAttempt {
	return {
		phase,
		started_at: "2026-10-09T00:00:00.000Z",
		completed_at: new Date(
			Date.parse("2026-10-09T00:00:00.000Z") + durationMs,
		).toISOString(),
		expected_decision: expected,
		response: canary,
		log_records: REQUIRED_LIVE_PROOF_LOG_EVENTS.map((event) => ({
			event,
			correlation_id: canary.correlation_id,
			algorithm_version: canary.algorithm_version,
			fixed_input_id: canary.fixed_input_id,
			decision_size_usdc: canary.decision.size_usdc,
			client_order_id: canary.ledger.client_order_id ?? "",
			order_id: canary.clob.order_id ?? "",
		})),
	};
}

function provenEvidence(): LocalLiveProofEvidence {
	const beforeDecision = {
		outcome: "placed" as const,
		reason: null,
		size_usdc: 1,
	};
	const afterDecision = {
		outcome: "placed" as const,
		reason: null,
		size_usdc: 1.5,
	};
	return {
		schema_version: LIVE_PROOF_SCHEMA_VERSION,
		status: "proven",
		local_sha: SHA,
		bootstrap: {
			app_healthy: true,
			db_healthy: true,
			db_isolation_verified: true,
			generated_state_mode: "0600",
			app_log_mode: "0600",
			generated_secrets_persisted_across_restart: true,
			generated_secret_values_printed: false,
			human_paste_fields: [...HUMAN_PASTE_FIELDS],
		},
		safety: {
			ci: false,
			node_env: "development",
			app_env: "production",
			explicit_confirmation: true,
			authenticated: true,
			trading_enabled: true,
			hard_cap_usdc: 2,
			egress: { verdict: "permitted", country: "GB" },
		},
		attempts: [
			attempt(
				"before",
				response(
					"local-canary-v1",
					1,
					`local-canary-${"a".repeat(32)}`,
					"order-before",
					beforeDecision,
				),
				beforeDecision,
			),
			attempt(
				"after",
				response(
					"local-canary-v2",
					1.5,
					`local-canary-${"b".repeat(32)}`,
					"order-after",
					afterDecision,
				),
				afterDecision,
				59_999,
			),
		],
	};
}

describe("evaluateLiveMoneyGate", () => {
	it.each([
		[
			{ env: { NODE_ENV: "production", APP_ENV: "production" } },
			"development_only",
		],
		[
			{ env: { NODE_ENV: "development", APP_ENV: "production", CI: "true" } },
			"ci_refused",
		],
		[
			{ env: { NODE_ENV: "development", APP_ENV: "test" } },
			"live_dispatch_required",
		],
		[{ confirmation: "yes" }, "explicit_opt_in_required"],
		[{ egress: { verdict: "blocked" as const, country: "US" } }, "geo_refused"],
		[{ egress: { verdict: "unknown" as const, country: null } }, "geo_refused"],
		[
			{ egress: { verdict: "unreachable" as const, country: null } },
			"geo_refused",
		],
		[{ authenticated: false }, "authentication_required"],
		[{ tradingEnabled: false }, "trading_not_enabled"],
		[{ dbIsolationVerified: false }, "db_isolation_unproven"],
		[{ algorithmUsdc: 0 }, "invalid_order_size"],
		[{ algorithmUsdc: 2.01 }, "order_cap_exceeded"],
	] as const)("refuses %j with %s", (override, code) => {
		expect(evaluateLiveMoneyGate(gate(override))).toMatchObject({
			ok: false,
			code,
		});
	});

	it("allows exactly $2 only after every safety boundary passes", () => {
		expect(evaluateLiveMoneyGate(gate({ algorithmUsdc: 2 }))).toEqual({
			ok: true,
		});
	});

	it("never calls placement when auth, geo, cap, or CI refuses", async () => {
		const place = vi.fn(async () => ({ orderId: "must-not-exist" }));
		for (const input of [
			gate({ authenticated: false }),
			gate({ egress: { verdict: "blocked", country: "US" } }),
			gate({ algorithmUsdc: 2.01 }),
			gate({
				env: { NODE_ENV: "development", APP_ENV: "production", CI: "1" },
			}),
		]) {
			const result = await runGuardedLivePlacement(input, place);
			expect(result.placed).toBe(false);
		}
		expect(place).not.toHaveBeenCalled();
	});

	it("calls placement once only after authorization succeeds", async () => {
		const place = vi.fn(async () => ({ orderId: "order-1" }));
		const result = await runGuardedLivePlacement(gate(), place);
		expect(result).toEqual({ placed: true, receipt: { orderId: "order-1" } });
		expect(place).toHaveBeenCalledTimes(1);
	});
});

describe("evaluateProof", () => {
	it("passes a correlated same-SHA before/after algorithm change under 60 seconds", () => {
		const result = evaluateProof(provenEvidence());
		expect(result.status).toBe("PASS");
		expect(result.issues).toEqual([]);
		expect(result.lines).toContain("correlation PASS");
	});

	it("fails mismatched correlation, order identity, and algorithm version", () => {
		const evidence = provenEvidence();
		const after = evidence.attempts[1];
		if (!after) throw new Error("missing after fixture");
		after.response.api.correlation_id = "wrong-correlation";
		after.response.clob.order_id = "wrong-order";
		after.response.ledger.algorithm_version = "wrong-version";
		const completion = after.log_records[0];
		if (!completion) throw new Error("missing completion log fixture");
		completion.correlation_id = "wrong-correlation";
		const result = evaluateProof(evidence);
		expect(result.status).toBe("FAIL");
		expect(result.issues).toEqual(
			expect.arrayContaining([
				"after.api correlation does not match the response",
				"after.ledger algorithm version does not match the response",
				"after.ledger order id does not match the CLOB order id",
				"after.poly.local_live_canary.complete correlation does not match the response",
			]),
		);
	});

	it("requires both concrete log events with API, ledger, and CLOB field agreement", () => {
		const evidence = provenEvidence();
		const after = evidence.attempts[1];
		if (!after) throw new Error("missing after fixture");
		after.log_records = after.log_records.filter(
			(record) => record.event !== "poly.local_live_canary.api_complete",
		);
		const result = evaluateProof(evidence);
		expect(result.status).toBe("FAIL");
		expect(result.issues).toContain(
			"after.logs is missing required event poly.local_live_canary.api_complete",
		);
	});

	it("fails restart, five-field, cap, fixed-input, version, decision, and latency drift", () => {
		const evidence = provenEvidence();
		evidence.bootstrap.generated_secrets_persisted_across_restart = false;
		evidence.bootstrap.human_paste_fields.push("SIXTH_SECRET");
		evidence.safety.hard_cap_usdc = 5;
		const before = evidence.attempts[0];
		const after = evidence.attempts[1];
		if (!before || !after) throw new Error("missing proof fixtures");
		after.response.fixed_input_id = "different-input";
		after.response.algorithm_version = before.response.algorithm_version;
		after.response.ledger.algorithm_version = before.response.algorithm_version;
		after.response.algorithm_parameter.order_usdc =
			before.response.algorithm_parameter.order_usdc;
		after.response.decision.size_usdc = before.response.decision.size_usdc;
		after.response.ledger.client_order_id =
			before.response.ledger.client_order_id;
		after.response.decision = { ...before.response.decision };
		after.expected_decision = { ...before.response.decision };
		after.completed_at = "2026-10-09T00:01:00.001Z";
		const result = evaluateProof(evidence);
		expect(result.status).toBe("FAIL");
		expect(result.issues).toEqual(
			expect.arrayContaining([
				"generated secrets did not persist across restart",
				"human paste fields are not the exact five-field contract",
				"hard cap must equal $2.00",
				"before/after did not use the same fixed input",
				"algorithm version did not change",
				"the versioned algorithm parameter did not change",
				"the persisted decision size did not change",
				"algorithm version change did not produce a distinct client_order_id",
				"after attempt took 60001ms (>60000ms)",
			]),
		);
	});

	it("reports US geographic refusal as safe BLOCKED with zero attempts", () => {
		const evidence = provenEvidence();
		evidence.status = "geo_blocked";
		evidence.safety.egress = { verdict: "blocked", country: "US" };
		evidence.safety.explicit_confirmation = false;
		evidence.safety.authenticated = false;
		evidence.safety.trading_enabled = false;
		evidence.attempts = [];
		const result = evaluateProof(evidence);
		expect(result.status).toBe("BLOCKED");
		expect(result.issues).toEqual([]);
		expect(result.lines).toContain("safety GEO_BLOCKED country=US placed=0");
	});

	it("fails a geo-blocked artifact that contains a placement attempt", () => {
		const evidence = provenEvidence();
		evidence.status = "geo_blocked";
		evidence.safety.egress = { verdict: "blocked", country: "US" };
		const result = evaluateProof(evidence);
		expect(result.status).toBe("FAIL");
		expect(result.issues).toContain(
			"geo refusal must occur before every placement attempt",
		);
	});
});

describe("evidence secrecy", () => {
	it("collects only allowlisted correlated fields from NDJSON app logs", () => {
		const correlation = `local-canary-${"c".repeat(32)}`;
		const common = {
			correlation_id: correlation,
			algorithm_version: "local-canary-v2",
			fixed_input_id: `0x${"d".repeat(64)}`,
			decision_size_usdc: 1.5,
			client_order_id: "0xclient-v2",
			order_id: "order-v2",
			accidental_secret: "must-not-escape",
		};
		const logs = [
			"not-json",
			JSON.stringify({ ...common, event: "unrelated.event" }),
			JSON.stringify({
				...common,
				correlation_id: "other-correlation",
				event: "poly.local_live_canary.complete",
			}),
			...REQUIRED_LIVE_PROOF_LOG_EVENTS.map((event) =>
				JSON.stringify({ ...common, event }),
			),
		].join("\n");

		const records = collectCorrelatedLogEvidence(logs, correlation);
		expect(records.map((record) => record.event)).toEqual(
			REQUIRED_LIVE_PROOF_LOG_EVENTS,
		);
		expect(JSON.stringify(records)).not.toContain("must-not-escape");
	});

	it("detects configured human secret values without printing them", () => {
		const env = {
			POLYGON_RPC_URL: "https://rpc.example/secret-token",
			PRIVY_USER_WALLETS_APP_SECRET: "privy-super-secret",
		};
		const artifact = JSON.stringify({ accidental: env.POLYGON_RPC_URL });
		expect(findLeakedSecretNames(artifact, env)).toEqual(["POLYGON_RPC_URL"]);
	});

	it("does not mistake field names or short placeholders for leaked values", () => {
		expect(
			findLeakedSecretNames(JSON.stringify({ fields: HUMAN_PASTE_FIELDS }), {
				POLYGON_RPC_URL: "short",
			}),
		).toEqual([]);
	});
});

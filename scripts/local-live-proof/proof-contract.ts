// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Pure validation contract for the local live-trade proof lane.
 *
 * This module never places an order by itself. The guarded callback is the
 * sole hand-off to the live probe, and the scorecard validates its evidence.
 */

import type { PolyLocalLiveCanaryOutput } from "@cogni/poly-node-contracts";

export const LIVE_PROOF_SCHEMA_VERSION = "poly.local-live-proof.v1" as const;
export const LIVE_CANARY_SCHEMA_VERSION = "poly.local-live-canary.v1" as const;
export const LIVE_PROOF_MAX_USDC = 2;
export const LIVE_PROOF_CONFIRMATION = "PLACE_REAL_ORDER_UP_TO_2_USDC" as const;
export const REQUIRED_LIVE_PROOF_LOG_EVENTS = [
	"poly.local_live_canary.complete",
	"poly.local_live_canary.api_complete",
] as const;

export const HUMAN_PASTE_FIELDS = [
	"POLYGON_RPC_URL",
	"POLYGON_RPC_WSS_URL",
	"PRIVY_USER_WALLETS_APP_ID",
	"PRIVY_USER_WALLETS_APP_SECRET",
	"PRIVY_USER_WALLETS_SIGNING_KEY",
] as const;

export type EgressVerdict = "permitted" | "blocked" | "unknown" | "unreachable";

export interface ProofAttempt {
	phase: "before" | "after";
	started_at: string;
	completed_at: string;
	expected_decision: {
		outcome: string;
		reason: string | null;
		size_usdc: number;
	};
	response: PolyLocalLiveCanaryOutput;
	/** Sanitized, allowlisted log records selected by response correlation id. */
	log_records: ProofLogRecord[];
}

export interface ProofLogRecord {
	event: (typeof REQUIRED_LIVE_PROOF_LOG_EVENTS)[number];
	correlation_id: string;
	algorithm_version: string;
	fixed_input_id: string;
	decision_size_usdc: number;
	client_order_id: string;
	order_id: string;
}

export interface LocalLiveProofEvidence {
	schema_version: typeof LIVE_PROOF_SCHEMA_VERSION;
	status: "proven" | "geo_blocked";
	local_sha: string;
	bootstrap: {
		app_healthy: boolean;
		db_healthy: boolean;
		db_isolation_verified: boolean;
		generated_state_mode: "0600";
		app_log_mode: "0600";
		generated_secrets_persisted_across_restart: boolean;
		generated_secret_values_printed: boolean;
		human_paste_fields: string[];
	};
	safety: {
		ci: boolean;
		node_env: string;
		app_env: string;
		explicit_confirmation: boolean;
		authenticated: boolean;
		trading_enabled: boolean;
		hard_cap_usdc: number;
		egress: {
			verdict: EgressVerdict;
			country: string | null;
		};
	};
	attempts: ProofAttempt[];
}

export interface ProofEvaluation {
	status: "PASS" | "BLOCKED" | "FAIL";
	issues: string[];
	lines: string[];
}

/** Build a cookie header using RFC domain boundaries, never suffix lookalikes. */
export function cookieHeaderForHost(
	cookies: ReadonlyArray<{ name: string; value: string; domain: string }>,
	host: string,
): string {
	const normalizedHost = host.toLowerCase();
	return cookies
		.filter((entry) => {
			const domain = entry.domain.replace(/^\./, "").toLowerCase();
			return (
				normalizedHost === domain ||
				(entry.domain.startsWith(".") && normalizedHost.endsWith(`.${domain}`))
			);
		})
		.map((entry) => `${entry.name}=${entry.value}`)
		.join("; ");
}

function isSha(value: string): boolean {
	return /^[0-9a-f]{7,40}$/i.test(value);
}

function elapsedMs(attempt: ProofAttempt): number {
	return Date.parse(attempt.completed_at) - Date.parse(attempt.started_at);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
	const sortedLeft = [...left].sort();
	const sortedRight = [...right].sort();
	return (
		sortedLeft.length === sortedRight.length &&
		sortedLeft.every((value, index) => value === sortedRight[index])
	);
}

function decisionFingerprint(attempt: ProofAttempt): string {
	return `${attempt.response.decision.outcome}:${attempt.response.decision.reason ?? ""}:$${attempt.response.decision.size_usdc.toFixed(2)}`;
}

function validateAttempt(
	attempt: ProofAttempt,
	expectedSha: string,
	issues: string[],
): void {
	const { response } = attempt;
	const prefix = attempt.phase;
	if (response.schema_version !== LIVE_CANARY_SCHEMA_VERSION) {
		issues.push(`${prefix}.response has an unsupported schema version`);
	}
	if (response.local_sha !== expectedSha) {
		issues.push(`${prefix}.response.local_sha differs from the proof SHA`);
	}
	if (response.ledger.correlation_id !== response.correlation_id) {
		issues.push(`${prefix}.ledger correlation does not match the response`);
	}
	if (response.api.correlation_id !== response.correlation_id) {
		issues.push(`${prefix}.api correlation does not match the response`);
	}
	if (response.ledger.algorithm_version !== response.algorithm_version) {
		issues.push(
			`${prefix}.ledger algorithm version does not match the response`,
		);
	}
	if (!response.ledger.order_id || !response.clob.order_id) {
		issues.push(`${prefix}.placed proof is missing a CLOB order id`);
	} else if (response.ledger.order_id !== response.clob.order_id) {
		issues.push(`${prefix}.ledger order id does not match the CLOB order id`);
	}
	if (!response.ledger.status || !response.clob.status) {
		issues.push(`${prefix}.ledger/CLOB status evidence is incomplete`);
	}
	if (!response.ledger.client_order_id) {
		issues.push(`${prefix}.ledger client_order_id is missing`);
	}
	if (!response.ledger.fill_id)
		issues.push(`${prefix}.ledger fill_id is missing`);
	if (!response.api.request_id || !response.api.route_id) {
		issues.push(`${prefix}.api request/route correlation is incomplete`);
	}
	if (response.algorithm_parameter.order_usdc <= 0) {
		issues.push(`${prefix}.algorithm order_usdc must be positive`);
	}
	if (response.algorithm_parameter.order_usdc > LIVE_PROOF_MAX_USDC) {
		issues.push(`${prefix}.algorithm order_usdc violates the live cap`);
	}
	if (response.decision.size_usdc !== response.algorithm_parameter.order_usdc) {
		issues.push(
			`${prefix}.decision size does not match the algorithm parameter`,
		);
	}
	if (response.decision.correlation_id !== response.correlation_id) {
		issues.push(`${prefix}.decision correlation does not match the response`);
	}
	if (response.decision.algorithm_version !== response.algorithm_version) {
		issues.push(
			`${prefix}.decision algorithm version does not match the response`,
		);
	}
	if (
		response.decision.outcome !== attempt.expected_decision.outcome ||
		response.decision.reason !== attempt.expected_decision.reason ||
		response.decision.size_usdc !== attempt.expected_decision.size_usdc
	) {
		issues.push(`${prefix}.decision differs from the prediction`);
	}
	const duration = elapsedMs(attempt);
	if (!Number.isFinite(duration) || duration < 0) {
		issues.push(`${prefix} has invalid timestamps`);
	}
	for (const event of REQUIRED_LIVE_PROOF_LOG_EVENTS) {
		const record = attempt.log_records.find(
			(candidate) => candidate.event === event,
		);
		if (!record) {
			issues.push(`${prefix}.logs is missing required event ${event}`);
			continue;
		}
		if (record.correlation_id !== response.correlation_id) {
			issues.push(`${prefix}.${event} correlation does not match the response`);
		}
		if (record.algorithm_version !== response.algorithm_version) {
			issues.push(
				`${prefix}.${event} algorithm version does not match the response`,
			);
		}
		if (record.fixed_input_id !== response.fixed_input_id) {
			issues.push(`${prefix}.${event} fixed input does not match the response`);
		}
		if (record.decision_size_usdc !== response.decision.size_usdc) {
			issues.push(
				`${prefix}.${event} decision size does not match the response`,
			);
		}
		if (record.client_order_id !== response.ledger.client_order_id) {
			issues.push(
				`${prefix}.${event} client_order_id does not match the ledger`,
			);
		}
		if (record.order_id !== response.clob.order_id) {
			issues.push(
				`${prefix}.${event} order id does not match the CLOB order id`,
			);
		}
	}
}

/**
 * Select only the two required, non-secret evidence records from a Pino NDJSON
 * app log. Malformed/unrelated lines are ignored and no unallowlisted fields
 * can escape into the proof artifact.
 */
export function collectCorrelatedLogEvidence(
	serializedLogs: string,
	correlationId: string,
): ProofLogRecord[] {
	const records: ProofLogRecord[] = [];
	for (const line of serializedLogs.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (parsed.correlation_id !== correlationId) continue;
		if (
			!REQUIRED_LIVE_PROOF_LOG_EVENTS.includes(
				parsed.event as (typeof REQUIRED_LIVE_PROOF_LOG_EVENTS)[number],
			)
		) {
			continue;
		}
		if (
			typeof parsed.algorithm_version !== "string" ||
			typeof parsed.fixed_input_id !== "string" ||
			typeof parsed.decision_size_usdc !== "number" ||
			typeof parsed.client_order_id !== "string" ||
			typeof parsed.order_id !== "string"
		) {
			continue;
		}
		records.push({
			event: parsed.event as ProofLogRecord["event"],
			correlation_id: correlationId,
			algorithm_version: parsed.algorithm_version,
			fixed_input_id: parsed.fixed_input_id,
			decision_size_usdc: parsed.decision_size_usdc,
			client_order_id: parsed.client_order_id,
			order_id: parsed.order_id,
		});
	}
	return records;
}

/**
 * Validate a complete before/after artifact or an expected geographic refusal.
 * GEO_BLOCKED is intentionally distinct from failure: it proves the safety
 * boundary worked, while making clear that live acceptance remains pending.
 */
export function evaluateProof(
	evidence: LocalLiveProofEvidence,
): ProofEvaluation {
	const issues: string[] = [];
	if (evidence.schema_version !== LIVE_PROOF_SCHEMA_VERSION) {
		issues.push(
			`unsupported schema_version=${String(evidence.schema_version)}`,
		);
	}
	if (!isSha(evidence.local_sha)) issues.push("local_sha is not a git SHA");
	if (!evidence.bootstrap.app_healthy) issues.push("app health is not proven");
	if (!evidence.bootstrap.db_healthy)
		issues.push("database health is not proven");
	if (!evidence.bootstrap.db_isolation_verified) {
		issues.push("database tenant isolation is not proven");
	}
	if (evidence.bootstrap.generated_state_mode !== "0600") {
		issues.push("generated secret state must use mode 0600");
	}
	if (evidence.bootstrap.app_log_mode !== "0600") {
		issues.push("local app log must use mode 0600");
	}
	if (!evidence.bootstrap.generated_secrets_persisted_across_restart) {
		issues.push("generated secrets did not persist across restart");
	}
	if (evidence.bootstrap.generated_secret_values_printed) {
		issues.push("generated secret values were printed");
	}
	if (!sameSet(evidence.bootstrap.human_paste_fields, HUMAN_PASTE_FIELDS)) {
		issues.push("human paste fields are not the exact five-field contract");
	}
	if (evidence.safety.ci) issues.push("real-money proof ran in CI");
	if (evidence.safety.node_env !== "development") {
		issues.push("real-money proof was not development-only");
	}
	if (evidence.safety.app_env !== "production") {
		issues.push("proof did not use the live dispatcher");
	}
	if (evidence.safety.hard_cap_usdc !== LIVE_PROOF_MAX_USDC) {
		issues.push(`hard cap must equal $${LIVE_PROOF_MAX_USDC.toFixed(2)}`);
	}

	if (evidence.status === "geo_blocked") {
		if (evidence.safety.egress.verdict !== "blocked") {
			issues.push("geo_blocked evidence must contain a blocked egress verdict");
		}
		if (evidence.attempts.length !== 0) {
			issues.push("geo refusal must occur before every placement attempt");
		}
		return {
			status: issues.length === 0 ? "BLOCKED" : "FAIL",
			issues,
			lines: [
				`local live proof ${issues.length === 0 ? "BLOCKED" : "FAIL"}`,
				`sha ${evidence.local_sha}`,
				`bootstrap ${issues.length === 0 ? "PASS" : "FAIL"}`,
				`safety GEO_BLOCKED country=${evidence.safety.egress.country ?? "unknown"} placed=0`,
				"next rerun unchanged from a physically permitted location",
			],
		};
	}

	if (!evidence.safety.explicit_confirmation) {
		issues.push("explicit request confirmation missing");
	}
	if (!evidence.safety.authenticated) issues.push("authenticated user missing");
	if (!evidence.safety.trading_enabled)
		issues.push("trading grant not enabled");
	if (evidence.safety.egress.verdict !== "permitted") {
		issues.push("live placement ran without a permitted egress verdict");
	}
	if (evidence.attempts.length !== 2) {
		issues.push("proof requires exactly one before and one after attempt");
	}

	const before = evidence.attempts.find(
		(attempt) => attempt.phase === "before",
	);
	const after = evidence.attempts.find((attempt) => attempt.phase === "after");
	if (!before || !after) {
		issues.push("before/after attempts are incomplete");
	} else {
		validateAttempt(before, evidence.local_sha, issues);
		validateAttempt(after, evidence.local_sha, issues);
		if (before.response.fixed_input_id !== after.response.fixed_input_id) {
			issues.push("before/after did not use the same fixed input");
		}
		if (
			before.response.algorithm_version === after.response.algorithm_version
		) {
			issues.push("algorithm version did not change");
		}
		if (
			before.response.algorithm_parameter.order_usdc ===
			after.response.algorithm_parameter.order_usdc
		) {
			issues.push("the versioned algorithm parameter did not change");
		}
		if (
			before.response.decision.size_usdc === after.response.decision.size_usdc
		) {
			issues.push("the persisted decision size did not change");
		}
		if (
			before.response.ledger.client_order_id ===
			after.response.ledger.client_order_id
		) {
			issues.push(
				"algorithm version change did not produce a distinct client_order_id",
			);
		}
		const afterDuration = elapsedMs(after);
		if (Number.isFinite(afterDuration) && afterDuration > 60_000) {
			issues.push(`after attempt took ${afterDuration}ms (>60000ms)`);
		}
	}

	const afterDuration = after ? elapsedMs(after) : NaN;
	return {
		status: issues.length === 0 ? "PASS" : "FAIL",
		issues,
		lines: [
			`local live proof ${issues.length === 0 ? "PASS" : "FAIL"}`,
			`sha ${evidence.local_sha}`,
			`bootstrap ${issues.length === 0 ? "PASS" : "FAIL"}`,
			`before ${before?.response.algorithm_version ?? "missing"} ${before ? decisionFingerprint(before) : "missing"} $${before ? before.response.algorithm_parameter.order_usdc.toFixed(2) : "missing"}`,
			`after ${after?.response.algorithm_version ?? "missing"} ${after ? decisionFingerprint(after) : "missing"} $${after ? after.response.algorithm_parameter.order_usdc.toFixed(2) : "missing"} ${Number.isFinite(afterDuration) ? `${afterDuration}ms` : "invalid-time"}`,
			`correlation ${issues.length === 0 ? "PASS" : "FAIL"}`,
			`safety cap=$${evidence.safety.hard_cap_usdc.toFixed(2)} geo=permitted auth=enabled`,
		],
	};
}

/** Refuse to publish an evidence artifact containing any configured secret value. */
export function findLeakedSecretNames(
	serializedEvidence: string,
	env: Readonly<Record<string, string | undefined>>,
): string[] {
	return HUMAN_PASTE_FIELDS.filter((name) => {
		const value = env[name];
		return Boolean(
			value && value.length >= 8 && serializedEvidence.includes(value),
		);
	});
}

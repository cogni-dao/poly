// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Purpose: Exercise one real, bounded local canary through the authenticated
 * HTTP route and validate its cross-surface evidence.
 * Scope: Opt-in local-only external-money lane; never included in CI/defaults.
 * Invariants: Exact per-invocation confirmation, session auth, <=$2, fail-closed
 * geoblock, and correlated API/ledger/CLOB identity.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	POLY_LOCAL_LIVE_CONFIRMATION,
	polyLocalLiveCanaryErrorSchema,
	polyLocalLiveCanaryOperation,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";
import { cookieHeaderForHost } from "../../../../scripts/local-live-proof/proof-contract";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const explicitlyConfirmed =
	process.env.POLY_LOCAL_LIVE_CONFIRM === POLY_LOCAL_LIVE_CONFIRMATION;

interface StorageState {
	cookies: Array<{ name: string; value: string; domain: string }>;
}

describe.skipIf(!explicitlyConfirmed)("local live algorithm canary", () => {
	it("places at most $2 or proves geographic refusal before placement", async () => {
		expect(/^(1|true|yes|on)$/i.test(process.env.CI ?? "")).toBe(false);

		const port = process.env.CONDUCTOR_PORT;
		const baseUrl =
			process.env.POLY_LOCAL_LIVE_BASE_URL ??
			(port ? `http://127.0.0.1:${port}` : undefined);
		if (!baseUrl) {
			throw new Error(
				"POLY_LOCAL_LIVE_BASE_URL or CONDUCTOR_PORT is required for the opted-in lane",
			);
		}

		const statePath =
			process.env.POLY_LOCAL_LIVE_STORAGE_STATE ??
			path.join(repoRoot, ".local-auth/local.storageState.json");
		const inputPath =
			process.env.POLY_LOCAL_LIVE_INPUT_PATH ??
			path.join(repoRoot, ".context/local-live-proof/input.json");
		const [stateText, inputText] = await Promise.all([
			readFile(statePath, "utf8"),
			readFile(inputPath, "utf8"),
		]);
		const state = JSON.parse(stateText) as StorageState;
		const fixedInput = JSON.parse(inputText) as unknown;
		const requestBody = polyLocalLiveCanaryOperation.input.parse({
			confirmation: POLY_LOCAL_LIVE_CONFIRMATION,
			fixed_input: fixedInput,
		});

		const host = new URL(baseUrl).hostname;
		const cookie = cookieHeaderForHost(state.cookies, host);
		if (!cookie) throw new Error(`no authenticated cookies found for ${host}`);

		const response = await fetch(
			new URL("/api/v1/poly/dev/live-algorithm-canary", baseUrl),
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie,
				},
				body: JSON.stringify(requestBody),
			},
		);
		const body = (await response.json()) as unknown;

		if (!response.ok) {
			const refusal = polyLocalLiveCanaryErrorSchema.parse(body);
			if (
				refusal.error !== "egress_geoblocked" &&
				refusal.error !== "egress_unproven"
			) {
				throw new Error(
					`live canary refused unexpectedly: ${refusal.error}: ${refusal.reason}`,
				);
			}
			expect(refusal.egress?.verdict).not.toBe("permitted");
			process.stdout.write(
				`local live proof BLOCKED safety=GEO_${refusal.egress?.verdict?.toUpperCase() ?? "UNPROVEN"} country=${refusal.egress?.country ?? "unknown"} placed=0\n`,
			);
			return;
		}

		const proof = polyLocalLiveCanaryOperation.output.parse(body);
		expect(proof.algorithm_parameter.order_usdc).toBeGreaterThan(0);
		expect(proof.algorithm_parameter.order_usdc).toBeLessThanOrEqual(2);
		expect(proof.decision.outcome).toBe("placed");
		expect(proof.decision.size_usdc).toBe(proof.algorithm_parameter.order_usdc);
		expect(proof.decision.correlation_id).toBe(proof.correlation_id);
		expect(proof.decision.algorithm_version).toBe(proof.algorithm_version);
		expect(proof.ledger.client_order_id).not.toBeNull();
		expect(proof.ledger.order_id).not.toBeNull();
		expect(proof.ledger.order_id).toBe(proof.clob.order_id);
		expect(proof.ledger.correlation_id).toBe(proof.correlation_id);
		expect(proof.api.correlation_id).toBe(proof.correlation_id);
		expect(proof.ledger.algorithm_version).toBe(proof.algorithm_version);
		expect(proof.cleanup.attempted).toBe(true);
		expect(["canceled", "already_terminal"]).toContain(proof.cleanup.status);

		process.stdout.write(
			`local live canary PASS sha=${proof.local_sha} version=${proof.algorithm_version} correlation=${proof.correlation_id} order=${proof.clob.order_id}\n`,
		);
	});
});

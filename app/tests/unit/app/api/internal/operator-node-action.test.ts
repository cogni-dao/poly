// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { createHash } from "node:crypto";
import {
	NODE_ACTION_V1_PROTOCOL_SHA256,
	nodeActionAudience,
} from "@cogni/node-contracts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ISSUER = "https://test.cognidao.org";
const NODE_ID = "22222222-2222-4222-8222-222222222222";
const TARGET = "/api/internal/node-actions/poly/egress-check";
const JTI = "44444444-4444-4444-8444-444444444444";
const consume = vi.fn();

vi.mock("@/shared/env/server", () => ({
	serverEnv: () => ({
		DOMAIN: "test.cognidao.org",
		DEPLOY_ENVIRONMENT: "candidate-a",
	}),
}));
vi.mock("@/shared/config", () => ({ getNodeId: () => NODE_ID }));
vi.mock("@/bootstrap/container", () => ({
	getContainer: () => ({ nodeActionReplay: { consume } }),
}));

import {
	resetNodeActionJwksCacheForTests,
	verifyOperatorNodeAction,
} from "@/app/_lib/auth/operator-node-action";

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const publicJwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA" };
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

async function token(body: string, overrides: Record<string, unknown> = {}) {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({
		type: "node.action.v1",
		protocol: NODE_ACTION_V1_PROTOCOL_SHA256,
		nodeId: NODE_ID,
		environment: "candidate-a",
		actorId: "user:operator-1",
		action: "poly.egress.read",
		target: TARGET,
		bodyHash: createHash("sha256").update(body, "utf8").digest("hex"),
		...overrides,
	})
		.setProtectedHeader({ alg: "EdDSA", kid: "k1" })
		.setIssuer(ISSUER)
		.setAudience(nodeActionAudience(NODE_ID))
		.setIssuedAt(now)
		.setExpirationTime(now + 60)
		.setJti(JTI)
		.sign(privateKey);
}

async function request(body = "{}", overrides: Record<string, unknown> = {}) {
	return new Request(`https://poly.test.cognidao.org${TARGET}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${await token(body, overrides)}`,
			"content-type": "application/json",
		},
		body,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	resetNodeActionJwksCacheForTests();
	fetchMock.mockResolvedValue(
		new Response(JSON.stringify({ keys: [publicJwk] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	);
	consume.mockResolvedValue(true);
});

describe("operator node action verifier", () => {
	it("accepts exact claims/body and consumes the jti before returning", async () => {
		const result = await verifyOperatorNodeAction(await request(), {
			action: "poly.egress.read",
			target: TARGET,
		});
		expect(result.ok).toBe(true);
		expect(consume).toHaveBeenCalledWith(JTI, expect.any(Number));
	});

	it("rejects a body not covered by the assertion", async () => {
		const signedForEmpty = await token("{}");
		const req = new Request(`https://poly.test.cognidao.org${TARGET}`, {
			method: "POST",
			headers: { authorization: `Bearer ${signedForEmpty}` },
			body: '{"changed":true}',
		});
		await expect(
			verifyOperatorNodeAction(req, {
				action: "poly.egress.read",
				target: TARGET,
			}),
		).resolves.toEqual({ ok: false, errorCode: "invalid_assertion" });
		expect(consume).not.toHaveBeenCalled();
	});

	it("rejects action substitution", async () => {
		await expect(
			verifyOperatorNodeAction(
				await request("{}", { action: "poly.wallet.recover_funds" }),
				{ action: "poly.egress.read", target: TARGET },
			),
		).resolves.toEqual({ ok: false, errorCode: "invalid_assertion" });
	});

	it("rejects a consumed jti", async () => {
		consume.mockResolvedValue(false);
		await expect(
			verifyOperatorNodeAction(await request(), {
				action: "poly.egress.read",
				target: TARGET,
			}),
		).resolves.toEqual({ ok: false, errorCode: "replayed_assertion" });
	});
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/identity/bindings-import.route`
 * Purpose: Negative-matrix unit tests for POST /api/v1/identity/bindings/import
 *   (task.5024) — real EdDSA verification against a mocked remote JWKS.
 * Scope: Tests the route handler + operator-attestation verifier together;
 *   session, DB import, and observability are mocked. Does not hit a network
 *   or database.
 * Invariants:
 *   - tampered/expired/wrong-issuer token → 401 invalid_token
 *   - the live node-local session must own the consume-once nonce
 *   - github id bound to different user → 409 already_linked (NO_AUTO_MERGE)
 *   - JWKS unreachable → 503 jwks_unavailable (fail closed)
 *   - happy path → 201 {bound:true, githubLogin}; repeat → 200 already_bound
 * Side-effects: none (global fetch stubbed)
 * Links: src/app/api/v1/identity/bindings/import/route.ts, src/app/_lib/auth/operator-attestation.ts
 * @internal
 */

import { IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256 } from "@cogni/node-contracts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must precede imports of modules under test) ---

const ISSUER = "https://test.cognidao.org";
const SESSION_WALLET = "0xAbCd000000000000000000000000000000001234"; // mixed case on purpose
const USER_ID = "11111111-1111-4111-8111-111111111111";
const NODE_ID = "22222222-2222-4222-8222-222222222222";
const NONCE = "33333333-3333-4333-8333-333333333333";
const JTI = "44444444-4444-4444-8444-444444444444";

const mockGetSessionUser = vi.fn();
const mockRedeemBinding = vi.fn();
const mockCreateNonce = vi.fn();
let mockDomain: string | undefined = "test.cognidao.org";
let mockNodeOrigin = "https://node.test.example";

// Keep the verifier's env read isolated from full server env validation
vi.mock("@/shared/env/server", () => ({
	serverEnv: () => ({
		DOMAIN: mockDomain,
		APP_BASE_URL: mockNodeOrigin,
	}),
}));

vi.mock("@/lib/auth/server", () => ({
	getServerSessionUser: (...args: unknown[]) => mockGetSessionUser(...args),
}));

vi.mock("@/shared/config", () => ({ getNodeId: () => NODE_ID }));

vi.mock("@/app/_facades/identity/operator-attested-binding.server", () => ({
	createIdentityAttestationNonce: (...args: unknown[]) => mockCreateNonce(...args),
	redeemAttestedGithubBinding: (...args: unknown[]) =>
		mockRedeemBinding(...args),
}));

// wrapRouteHandlerWithLogging deps — keep this a true unit (no pino/prom-client)
vi.mock("@/shared/observability", () => {
	const noopLog = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};
	return {
		createRequestContext: () => ({ log: noopLog, reqId: "req-1" }),
		httpRequestDurationMs: { observe: vi.fn() },
		httpRequestsTotal: { inc: vi.fn() },
		logRequestEnd: vi.fn(),
		logRequestError: vi.fn(),
		logRequestStart: vi.fn(),
		makeLogger: () => noopLog,
		statusBucket: (status: number) => String(status),
	};
});

vi.mock("@/bootstrap/otel", () => ({
	withRootSpan: (
		_name: string,
		_attrs: Record<string, unknown>,
		fn: (args: {
			traceId: string;
			span: { setAttribute: () => void };
		}) => Promise<unknown>,
	) => fn({ traceId: "trace-1", span: { setAttribute: vi.fn() } }),
}));

vi.mock("@/bootstrap/container", () => ({
	getContainer: () => ({
		config: { unhandledErrorPolicy: "rethrow" },
		log: { child: vi.fn().mockReturnThis() },
		clock: { now: () => new Date() },
	}),
}));

// Import after mocks
import {
	resetOperatorAttestationJwksCacheForTests,
	resolveOperatorIssuerUrl,
} from "@/app/_lib/auth/operator-attestation";
import { POST as IMPORT_POST } from "@/app/api/v1/identity/bindings/import/route";
import { POST as START_POST } from "@/app/api/v1/identity/bindings/import/start/route";

// --- Key + token helpers ---

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const { publicKey: previousPublicKey, privateKey: previousPrivateKey } =
	await generateKeyPair("EdDSA");
const { privateKey: attackerKey } = await generateKeyPair("EdDSA");
const publicJwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA" };
const previousPublicJwk = {
	...(await exportJWK(previousPublicKey)),
	kid: "k0",
	alg: "EdDSA",
};

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jwksOk(): Response {
	return new Response(JSON.stringify({ keys: [publicJwk, previousPublicJwk] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function mintToken(opts?: {
	issuer?: string;
	expiredBy?: number;
	key?: typeof privateKey;
	kid?: string;
	audience?: string;
	nodeId?: string;
	nonce?: string;
	targetOrigin?: string;
	githubLogin?: string | null;
	protocol?: string;
}): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const exp = opts?.expiredBy ? now - opts.expiredBy : now + 600;
	return await new SignJWT({
		type: "identity.attestation.v1",
		protocol: opts?.protocol ?? IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
		nodeId: opts?.nodeId ?? NODE_ID,
		nonce: opts?.nonce ?? NONCE,
		targetOrigin: opts?.targetOrigin ?? "https://node.test.example",
		github: {
			id: "12345",
			login: opts && "githubLogin" in opts ? opts.githubLogin : "octocat",
		},
	})
		.setProtectedHeader({ alg: "EdDSA", kid: opts?.kid ?? "k1" })
		.setIssuer(opts?.issuer ?? ISSUER)
		.setAudience(opts?.audience ?? `urn:cogni:node:${NODE_ID}`)
		.setJti(JTI)
		.setIssuedAt(opts?.expiredBy ? now - opts.expiredBy - 600 : now)
		.setExpirationTime(exp)
		.sign(opts?.key ?? privateKey);
}

function makeRequest(body: unknown): NextRequest {
	return new NextRequest(
		"http://localhost:3200/api/v1/identity/bindings/import",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDomain = "test.cognidao.org";
	mockNodeOrigin = "https://node.test.example";
	resetOperatorAttestationJwksCacheForTests();
	fetchMock.mockImplementation(async () => jwksOk());
	mockGetSessionUser.mockResolvedValue({
		id: USER_ID,
		walletAddress: SESSION_WALLET,
		displayName: null,
		avatarColor: null,
	});
	mockRedeemBinding.mockResolvedValue("created");
	mockCreateNonce.mockResolvedValue(NONCE);
});

describe("POST /api/v1/identity/bindings/import", () => {
	it("201 {bound:true} on happy path; passes attested claims to import", async () => {
		const res = await IMPORT_POST(makeRequest({ token: await mintToken() }));

		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({
			bound: true,
			githubLogin: "octocat",
		});
		expect(mockRedeemBinding).toHaveBeenCalledWith({
			userId: USER_ID,
			nonce: NONCE,
			githubId: "12345",
			githubLogin: "octocat",
			issuer: ISSUER,
			jti: JTI,
			iat: expect.any(Number),
		});
	});

	it("accepts the previous published JWKS key during rotation", async () => {
		const res = await IMPORT_POST(
			makeRequest({
				token: await mintToken({ key: previousPrivateKey, kid: "k0" }),
			}),
		);
		expect(res.status).toBe(201);
	});

	it("accepts a nullable GitHub login from the exact contract", async () => {
		const res = await IMPORT_POST(
			makeRequest({ token: await mintToken({ githubLogin: null }) }),
		);
		expect(res.status).toBe(201);
		expect(mockRedeemBinding).toHaveBeenCalledWith(
			expect.objectContaining({ githubLogin: null }),
		);
	});

	it("401 when audience is not this node", async () => {
		const res = await IMPORT_POST(
			makeRequest({ token: await mintToken({ audience: "urn:cogni:node:99999999-9999-4999-8999-999999999999" }) }),
		);
		expect(res.status).toBe(401);
		expect(mockRedeemBinding).not.toHaveBeenCalled();
	});

	it("401 when the operator signs a different protocol fingerprint", async () => {
		const res = await IMPORT_POST(
			makeRequest({ token: await mintToken({ protocol: "0".repeat(64) }) }),
		);
		expect(res.status).toBe(401);
		expect(mockRedeemBinding).not.toHaveBeenCalled();
	});

	it("401 when the signed nodeId disagrees with the exact audience", async () => {
		const res = await IMPORT_POST(
			makeRequest({ token: await mintToken({ nodeId: "99999999-9999-4999-8999-999999999999" }) }),
		);
		expect(res.status).toBe(401);
	});

	it("401 when the token targets a different deployment origin", async () => {
		const res = await IMPORT_POST(
			makeRequest({
				token: await mintToken({ targetOrigin: "https://node.example" }),
			}),
		);
		expect(res.status).toBe(401);
		expect(mockRedeemBinding).not.toHaveBeenCalled();
	});

	it("consumes nonce once and rejects a replay before binding", async () => {
		mockRedeemBinding.mockResolvedValue("invalid_nonce");
		const res = await IMPORT_POST(makeRequest({ token: await mintToken() }));
		expect(res.status).toBe(401);
		expect(mockRedeemBinding).toHaveBeenCalledWith(
			expect.objectContaining({ nonce: NONCE, userId: USER_ID }),
		);
	});

	it("200 already_bound when the same binding already exists (idempotent)", async () => {
		mockRedeemBinding.mockResolvedValue("already_bound");

		const res = await IMPORT_POST(makeRequest({ token: await mintToken() }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			bound: true,
			code: "already_bound",
			githubLogin: "octocat",
		});
	});

	it("409 already_linked when the github id is bound to a different user (NO_AUTO_MERGE)", async () => {
		mockRedeemBinding.mockResolvedValue("already_linked");

		const res = await IMPORT_POST(makeRequest({ token: await mintToken() }));

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ errorCode: "already_linked" });
	});

	it("401 invalid_token for a tampered token (signed by the wrong key)", async () => {
		const res = await IMPORT_POST(
			makeRequest({ token: await mintToken({ key: attackerKey }) }),
		);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ errorCode: "invalid_token" });
		expect(mockRedeemBinding).not.toHaveBeenCalled();
	});

	it("401 invalid_token for an expired token", async () => {
		const res = await IMPORT_POST(
			makeRequest({ token: await mintToken({ expiredBy: 3600 }) }),
		);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ errorCode: "invalid_token" });
	});

	it("401 invalid_token when iss is not the pinned issuer", async () => {
		const res = await IMPORT_POST(
			makeRequest({
				token: await mintToken({ issuer: "https://evil.example" }),
			}),
		);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ errorCode: "invalid_token" });
	});

	it("401 invalid_token when a production attestation is replayed in candidate-a", async () => {
		const res = await IMPORT_POST(
			makeRequest({
				token: await mintToken({ issuer: "https://cognidao.org" }),
			}),
		);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ errorCode: "invalid_token" });
		expect(mockRedeemBinding).not.toHaveBeenCalled();
	});

	it("503 jwks_unavailable when DOMAIN is not a bare host", async () => {
		mockDomain = "test.cognidao.org/unexpected-path";

		const res = await IMPORT_POST(makeRequest({ token: await mintToken() }));

		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ errorCode: "jwks_unavailable" });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(mockRedeemBinding).not.toHaveBeenCalled();
	});

	it("binds to the nonce-owning local account without requiring a wallet", async () => {
		mockGetSessionUser.mockResolvedValue({
			id: USER_ID,
			walletAddress: null,
			displayName: null,
			avatarColor: null,
		});

		const res = await IMPORT_POST(makeRequest({ token: await mintToken() }));

		expect(res.status).toBe(201);
		expect(mockRedeemBinding).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER_ID, nonce: NONCE }),
		);
	});

	it("503 jwks_unavailable when the issuer JWKS is unreachable (fail closed)", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));

		const res = await IMPORT_POST(makeRequest({ token: await mintToken() }));

		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ errorCode: "jwks_unavailable" });
		expect(mockRedeemBinding).not.toHaveBeenCalled();
	});

	it("401 Session required without a session", async () => {
		mockGetSessionUser.mockResolvedValue(null);

		const res = await IMPORT_POST(makeRequest({ token: await mintToken() }));

		expect(res.status).toBe(401);
	});

	it("400 on a body without a token", async () => {
		const res = await IMPORT_POST(makeRequest({ nope: true }));

		expect(res.status).toBe(400);
	});
});

describe("POST /api/v1/identity/bindings/import/start", () => {
	it.each([
		["test.cognidao.org", "https://test.cognidao.org"],
		["staging.example.org", "https://staging.example.org"],
		["dao.example.org", "https://dao.example.org"],
	])(
		"uses the configured base domain %s",
		async (domain, expectedIssuer) => {
			mockDomain = domain;
			const res = await START_POST(
				new NextRequest(
					"http://localhost:3200/api/v1/identity/bindings/import/start",
					{ method: "POST" },
				),
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as { authorizeUrl: string };
			expect(new URL(body.authorizeUrl).origin).toBe(expectedIssuer);
		},
	);

	it("mints a user-owned nonce and binds broker parameters server-side", async () => {
		const res = await START_POST(
			new NextRequest(
				"http://localhost:3200/api/v1/identity/bindings/import/start",
				{ method: "POST" },
			),
		);
		expect(res.status).toBe(200);
		expect(mockCreateNonce).toHaveBeenCalledWith(USER_ID);
		const body = (await res.json()) as { authorizeUrl: string };
		const authorizeUrl = new URL(body.authorizeUrl);
		expect(authorizeUrl.origin).toBe(ISSUER);
		expect(authorizeUrl.pathname).toBe("/identity/attest");
		expect(authorizeUrl.searchParams.get("protocol")).toBe(
			IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
		);
		expect(authorizeUrl.searchParams.get("node_id")).toBe(NODE_ID);
		expect(authorizeUrl.searchParams.get("nonce")).toBe(NONCE);
		expect(authorizeUrl.searchParams.get("target_origin")).toBe(
			"https://node.test.example",
		);
		expect(authorizeUrl.searchParams.get("return_to")).toBe(
			"https://node.test.example/profile",
		);
	});

	it.each([undefined, "https://test.cognidao.org", "test.cognidao.org/path"])(
		"rejects missing or invalid DOMAIN %s before minting a nonce",
		async (domain) => {
			mockDomain = domain;
			const res = await START_POST(
				new NextRequest(
					"http://localhost:3200/api/v1/identity/bindings/import/start",
					{ method: "POST" },
				),
			);

			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({
				errorCode: "operator_issuer_unavailable",
			});
			expect(mockCreateNonce).not.toHaveBeenCalled();
		},
	);

	it.each([
		"http://node.test.example",
		"https://user:pass@node.test.example",
	])("rejects unsafe node origin %s before minting a nonce", async (origin) => {
		mockNodeOrigin = origin;
		const res = await START_POST(
			new NextRequest(
				"http://localhost:3200/api/v1/identity/bindings/import/start",
				{ method: "POST" },
			),
		);
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ errorCode: "node_origin_unavailable" });
		expect(mockCreateNonce).not.toHaveBeenCalled();
	});
});

describe("resolveOperatorIssuerUrl", () => {
	it.each([
		["test.cognidao.org", "https://test.cognidao.org"],
		["staging.example.org", "https://staging.example.org"],
		["dao.example.org", "https://dao.example.org"],
	])("maps %s to %s", (domain, issuer) => {
		expect(resolveOperatorIssuerUrl(domain)).toBe(issuer);
	});

	it.each([undefined, "https://example.org", "example.org/path"])(
		"rejects missing or non-host DOMAIN %s",
		(domain) => {
			expect(() => resolveOperatorIssuerUrl(domain)).toThrow();
		},
	);
});

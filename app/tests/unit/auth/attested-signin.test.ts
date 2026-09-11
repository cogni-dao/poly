// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/auth/attested-signin`
 * Purpose: Unit tests for the operator-attested GitHub sign-in provider (task.5042).
 * Scope: authorize() decision branches. Verification, DB, and logging are mocked.
 * Invariants: SIGNIN_NONCE_IS_COOKIE_BOUND and ATTESTATION_ONE_TIME are enforced BEFORE any user is minted.
 * Side-effects: none
 * Links: src/auth.ts, src/shared/identity/signin-challenge.ts
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/adapters/server/db/drizzle.service-client", () => ({
	getServiceDb: vi.fn(),
}));
vi.mock("@/adapters/server/identity/create-binding", () => ({
	createBinding: vi.fn(),
}));
vi.mock("@/shared/observability", () => {
	const noop = () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: vi.fn().mockReturnThis(),
	});
	return { makeLogger: noop, makeNoopLogger: noop };
});
vi.mock("next-auth/react", () => ({ getCsrfToken: vi.fn() }));
vi.mock("@/shared/config", () => ({
	getNodeId: () => "11111111-2222-3333-4444-555555555555",
}));

const verifyOperatorAttestation = vi.fn();
vi.mock("@/app/_lib/auth/operator-attestation", () => ({
	verifyOperatorAttestation: (...a: unknown[]) =>
		verifyOperatorAttestation(...a),
}));

const consumeSigninChallenge = vi.fn();
const resolveAttestedGithubUser = vi.fn();
vi.mock("@/app/_facades/identity/operator-attested-binding.server", () => ({
	consumeSigninChallenge: (...a: unknown[]) => consumeSigninChallenge(...a),
	resolveAttestedGithubUser: (...a: unknown[]) =>
		resolveAttestedGithubUser(...a),
	createIdentityAttestationNonce: vi.fn(),
	createSigninChallenge: vi.fn(),
	redeemAttestedGithubBinding: vi.fn(),
}));

import { authOptions } from "@/auth";
import { SIGNIN_CHALLENGE_COOKIE } from "@/shared/identity/signin-challenge";
import { OPERATOR_ATTESTED_PROVIDER_ID } from "@/shared/identity/signin-paths";

const NONCE = "nonce-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// next-auth's `Credentials()` factory returns `{id:"credentials", ..., options}` and
// nests the caller's config under `options`; `parseProviders` merges it (and picks up
// our `id`) at request time. So BOTH credentials providers read as id "credentials"
// here, and the real config — including `id` and `authorize` — lives one level down.
// biome-ignore lint/suspicious/noExplicitAny: reaching into the provider under test
const provider = (authOptions.providers as any[])
	.map((p) => p.options)
	.find((o) => o?.id === OPERATOR_ATTESTED_PROVIDER_ID);

function req(cookie?: string) {
	return { headers: cookie ? { cookie } : {} } as never;
}

function okAttestation(nonce = NONCE) {
	return {
		ok: true,
		claims: {
			issuer: "https://cognidao.org",
			github: { id: "9001", login: "octocat" },
			nodeId: "11111111-2222-3333-4444-555555555555",
			targetOrigin: "https://levelup.cognidao.org",
			nonce,
			jti: "jti-1",
			iat: 1,
		},
	};
}

describe("operator-attested GitHub sign-in (task.5042)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		verifyOperatorAttestation.mockResolvedValue(okAttestation());
		consumeSigninChallenge.mockResolvedValue(true);
		resolveAttestedGithubUser.mockResolvedValue({ id: "user-1", isNew: true });
	});

	it("is registered — a node offers GitHub without holding an OAuth client", () => {
		expect(provider).toBeDefined();
		expect(provider.id).toBe(OPERATOR_ATTESTED_PROVIDER_ID);
	});

	it("signs in a WALLET-LESS user when token and cookie agree", async () => {
		const user = await provider.authorize(
			{ token: "jwt" },
			req(`${SIGNIN_CHALLENGE_COOKIE}=${NONCE}`),
		);
		expect(user).toEqual({ id: "user-1", walletAddress: null });
	});

	it("REJECTS a valid attestation presented without the challenge cookie", async () => {
		// The stolen-token case. The nonce is inside the JWT, so DB one-time-ness alone
		// would not stop a thief who races the victim — the cookie is the real binding.
		const user = await provider.authorize({ token: "jwt" }, req());
		expect(user).toBeNull();
		expect(consumeSigninChallenge).not.toHaveBeenCalled();
		expect(resolveAttestedGithubUser).not.toHaveBeenCalled();
	});

	it("REJECTS when the cookie names a different nonce than the attestation", async () => {
		const user = await provider.authorize(
			{ token: "jwt" },
			req(`${SIGNIN_CHALLENGE_COOKIE}=nonce-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`),
		);
		expect(user).toBeNull();
		expect(resolveAttestedGithubUser).not.toHaveBeenCalled();
	});

	it("REJECTS a replayed challenge and mints nothing", async () => {
		consumeSigninChallenge.mockResolvedValue(false);
		const user = await provider.authorize(
			{ token: "jwt" },
			req(`${SIGNIN_CHALLENGE_COOKIE}=${NONCE}`),
		);
		expect(user).toBeNull();
		expect(resolveAttestedGithubUser).not.toHaveBeenCalled();
	});

	it("REJECTS an unverifiable attestation before touching the challenge", async () => {
		verifyOperatorAttestation.mockResolvedValue({
			ok: false,
			errorCode: "invalid_token",
		});
		const user = await provider.authorize(
			{ token: "jwt" },
			req(`${SIGNIN_CHALLENGE_COOKIE}=${NONCE}`),
		);
		expect(user).toBeNull();
		expect(consumeSigninChallenge).not.toHaveBeenCalled();
	});

	it("REJECTS a missing token without calling the verifier", async () => {
		expect(await provider.authorize({}, req())).toBeNull();
		expect(verifyOperatorAttestation).not.toHaveBeenCalled();
	});
});

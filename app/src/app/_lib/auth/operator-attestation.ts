// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_lib/auth/operator-attestation`
 * Purpose: Verifies operator-signed GitHub OAuth attestations against the issuer's remote JWKS.
 * Scope: Signature/exp/issuer verification + claim shape validation only. Does
 *   NOT decide which local user owns the binding (the consume-once nonce does)
 *   or write bindings (identity feature service's job).
 * Invariants:
 *   - FAIL_CLOSED: any error that is not provably a bad token maps to
 *     `jwks_unavailable` (503 at the route) — never silently accepts.
 *   - PINNED_ISSUER: the deployment's DOMAIN selects the canonical operator
 *     host, and the token `iss` claim must equal that resolved URL.
 *   - EDDSA_ONLY: `alg` restricted to EdDSA (Ed25519) — no HS/none downgrade.
 *   - EXACT_DEPLOYMENT_ORIGIN: signed targetOrigin must equal this node's
 *     canonical APP_BASE_URL, preventing candidate/preview/production replay.
 * Side-effects: IO (remote JWKS fetch, cached per issuer by jose)
 * Links: docs task.5024 fleet-identity design, src/app/api/v1/identity/bindings/import/route.ts
 * @public
 */

import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import {
	IdentityAttestationClaimsSchema,
	IdentityAttestationOriginSchema,
	identityAttestationAudience,
} from "@cogni/node-contracts";

import { serverEnv } from "@/shared/env/server";

/** Claims carried by a verified operator attestation. */
export interface OperatorAttestationClaims {
	/** Pinned issuer URL the token was verified against. */
	issuer: string;
	github: { id: string; login: string | null };
	nodeId: string;
	targetOrigin: string;
	nonce: string;
	jti: string;
	iat: number;
}

export type OperatorAttestationResult =
	| { ok: true; claims: OperatorAttestationClaims }
	| { ok: false; errorCode: "invalid_token" | "jwks_unavailable" };

/** Require a bare origin so issuer/JWKS trust cannot drift by URL path. */
function configuredOrigin(url: string): string {
	return IdentityAttestationOriginSchema.parse(url);
}

/** Resolve the environment-local issuer from the same base domain that routes the operator. */
export function resolveOperatorIssuerUrl(
	domain: string | undefined,
): string {
	if (!domain) {
		throw new Error("DOMAIN is required for operator attestations");
	}
	return configuredOrigin(`https://${domain}`);
}

/** Issuer URL for operator attestations, pinned to this deployment environment. */
export function getOperatorIssuerUrl(): string {
	return resolveOperatorIssuerUrl(serverEnv().DOMAIN);
}

/** Exact relying-node origin used for deployment-bound attestation checks. */
export function getNodeOriginUrl(): string {
	const configured = serverEnv().APP_BASE_URL;
	if (!configured) throw new Error("APP_BASE_URL is required");
	return configuredOrigin(configured);
}

// Remote JWKS is cached per issuer URL; jose handles key caching + refetch on
// unknown kid with a cooldown.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(issuerUrl: string): ReturnType<typeof createRemoteJWKSet> {
	let jwks = jwksCache.get(issuerUrl);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(`${issuerUrl}/.well-known/jwks.json`), {
			timeoutDuration: 5_000,
			cooldownDuration: 30_000,
		});
		jwksCache.set(issuerUrl, jwks);
	}
	return jwks;
}

/** Test-only: drop cached remote JWKS instances (forces refetch). */
export function resetOperatorAttestationJwksCacheForTests(): void {
	jwksCache.clear();
}

// Errors that prove the TOKEN is bad (tampered/expired/wrong key/claims).
// Everything else (network failure, timeout, malformed JWKS document) is an
// issuer availability problem → fail closed as jwks_unavailable.
function isTokenError(error: unknown): boolean {
	return (
		error instanceof errors.JWTExpired ||
		error instanceof errors.JWTClaimValidationFailed ||
		error instanceof errors.JWTInvalid ||
		error instanceof errors.JWSInvalid ||
		error instanceof errors.JWSSignatureVerificationFailed ||
		error instanceof errors.JWKSNoMatchingKey ||
		error instanceof errors.JOSEAlgNotAllowed ||
		error instanceof errors.JOSENotSupported
	);
}

/**
 * Verifies an operator attestation JWT: EdDSA signature against the issuer
 * JWKS, exp/iss claims, and payload shape. Never throws.
 */
export async function verifyOperatorAttestation(
	token: string,
	expectedNodeId: string,
): Promise<OperatorAttestationResult> {
	try {
		const issuerUrl = getOperatorIssuerUrl();
		const expectedAudience = identityAttestationAudience(expectedNodeId);
		const { payload } = await jwtVerify(token, getJwks(issuerUrl), {
			issuer: issuerUrl,
			audience: expectedAudience,
			algorithms: ["EdDSA"],
		});

		const parsed = IdentityAttestationClaimsSchema.safeParse(payload);
		if (
			!parsed.success ||
			parsed.data.nodeId !== expectedNodeId ||
			parsed.data.targetOrigin !== getNodeOriginUrl()
		) {
			return { ok: false, errorCode: "invalid_token" };
		}

		return {
			ok: true,
			claims: {
				issuer: issuerUrl,
				github: parsed.data.github,
				nodeId: parsed.data.nodeId,
				targetOrigin: parsed.data.targetOrigin,
				nonce: parsed.data.nonce,
				jti: parsed.data.jti,
				iat: parsed.data.iat,
			},
		};
	} catch (error) {
		if (isTokenError(error)) {
			return { ok: false, errorCode: "invalid_token" };
		}
		// FAIL_CLOSED: JWKS unreachable/undecodable or unknown failure → 503.
		return { ok: false, errorCode: "jwks_unavailable" };
	}
}

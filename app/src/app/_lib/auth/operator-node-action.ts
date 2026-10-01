// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Verify, bind, and consume one operator-signed node.action.v1 assertion. */

import { createHash } from "node:crypto";
import {
	NodeActionClaimsSchema,
	nodeActionAudience,
} from "@cogni/node-contracts";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { getContainer } from "@/bootstrap/container";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env/server";
import { resolveOperatorIssuerUrl } from "./operator-attestation";

export type NodeActionVerificationResult =
	| { ok: true; claims: ReturnType<typeof NodeActionClaimsSchema.parse> }
	| {
			ok: false;
			errorCode:
				| "invalid_assertion"
				| "verification_unavailable"
				| "replayed_assertion";
	  };

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function resetNodeActionJwksCacheForTests(): void {
	jwksCache.clear();
}

function getJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
	let jwks = jwksCache.get(issuer);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
			timeoutDuration: 5_000,
			cooldownDuration: 30_000,
		});
		jwksCache.set(issuer, jwks);
	}
	return jwks;
}

function bearerToken(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header || header.length > 4096) return null;
	return /^Bearer\s+([^\s]+)$/i.exec(header.trim())?.[1] ?? null;
}

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

export async function verifyOperatorNodeAction(
	request: Request,
	expected: { readonly action: string; readonly target: string },
): Promise<NodeActionVerificationResult> {
	const token = bearerToken(request);
	if (!token) return { ok: false, errorCode: "invalid_assertion" };

	try {
		const env = serverEnv();
		if (!env.DEPLOY_ENVIRONMENT) {
			return { ok: false, errorCode: "invalid_assertion" };
		}
		const nodeId = getNodeId();
		const issuer = resolveOperatorIssuerUrl(env.DOMAIN);
		const { payload } = await jwtVerify(token, getJwks(issuer), {
			issuer,
			audience: nodeActionAudience(nodeId),
			algorithms: ["EdDSA"],
		});
		const parsed = NodeActionClaimsSchema.safeParse(payload);
		if (!parsed.success) {
			return { ok: false, errorCode: "invalid_assertion" };
		}
		const claims = parsed.data;
		const body = Buffer.from(await request.clone().arrayBuffer());
		const bodyHash = createHash("sha256").update(body).digest("hex");
		if (
			claims.nodeId !== nodeId ||
			claims.environment !== env.DEPLOY_ENVIRONMENT ||
			claims.action !== expected.action ||
			claims.target !== expected.target ||
			new URL(request.url).pathname !== expected.target ||
			claims.bodyHash !== bodyHash
		) {
			return { ok: false, errorCode: "invalid_assertion" };
		}

		const ttl = claims.exp - Math.floor(Date.now() / 1000);
		const consumed = await getContainer().nodeActionReplay.consume(claims.jti, ttl);
		return consumed
			? { ok: true, claims }
			: { ok: false, errorCode: "replayed_assertion" };
	} catch (error) {
		return {
			ok: false,
			errorCode: isTokenError(error)
				? "invalid_assertion"
				: "verification_unavailable",
		};
	}
}

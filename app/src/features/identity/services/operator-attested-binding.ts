// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Use-case policy for nonce creation and operator-attested GitHub imports. */

import { IDENTITY_ATTESTATION_TTL_SECONDS } from "@cogni/node-contracts";

import type { Clock, IdentityBindingRepositoryPort } from "@/ports";

export const ATTESTATION_NONCE_TTL_MS =
	(IDENTITY_ATTESTATION_TTL_SECONDS + 5 * 60) * 1000;

export type RedeemAttestedBindingResult =
	| "created"
	| "already_bound"
	| "already_linked"
	| "invalid_nonce";

export interface IdentityBindingService {
	createNonce(userId: string): Promise<string>;
	redeemGithubBinding(params: {
		userId: string;
		nonce: string;
		githubId: string;
		githubLogin: string | null;
		issuer: string;
		jti: string;
		iat: number;
	}): Promise<RedeemAttestedBindingResult>;
}

export function createIdentityBindingService(deps: {
	repository: IdentityBindingRepositoryPort;
	clock: Clock;
	createNonceId: () => string;
}): IdentityBindingService {
	return {
		async createNonce(userId) {
			const nonce = deps.createNonceId();
			const now = new Date(deps.clock.now());
			await deps.repository.insertNonce({
				nonce,
				userId,
				expiresAt: new Date(now.getTime() + ATTESTATION_NONCE_TTL_MS),
			});
			return nonce;
		},

		async redeemGithubBinding(params) {
			return deps.repository.transaction(async (tx) => {
				const consumed = await tx.consumeNonce({
					nonce: params.nonce,
					userId: params.userId,
					now: new Date(deps.clock.now()),
				});
				if (!consumed) return "invalid_nonce";

				const existing = await tx.findGithubBinding(params.githubId);
				if (existing) {
					if (existing.userId !== params.userId) return "already_linked";
					await tx.updateGithubLogin(existing.id, params.githubLogin);
					return "already_bound";
				}

				const created = await tx.createGithubBinding({
					userId: params.userId,
					githubId: params.githubId,
					evidence: {
						issuer: params.issuer,
						jti: params.jti,
						login: params.githubLogin,
						iat: params.iat,
					},
				});

				const bound = await tx.findGithubBinding(params.githubId);
				if (!bound || bound.userId !== params.userId) {
					return "already_linked";
				}
				await tx.updateGithubLogin(bound.id, params.githubLogin);
				return created ? "created" : "already_bound";
			});
		},
	};
}

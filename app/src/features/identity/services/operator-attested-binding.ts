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

/** A wallet challenge is a short-lived SIWE nonce: long enough to sign on a phone, short enough to stay single-use. */
export const WALLET_NONCE_TTL_MS = 10 * 60 * 1000;

export type BindWalletResult =
	| "created"
	| "already_bound"
	| "already_linked"
	| "invalid_nonce";

export interface IdentityBindingService {
	createNonce(userId: string): Promise<string>;
	/** A single-use SIWE nonce owned by this principal (a session user or an AI bearer key). */
	createWalletNonce(
		userId: string,
	): Promise<{ nonce: string; expiresAt: Date }>;
	/**
	 * Bind a wallet whose signature the caller already verified (`address` is its lowercase wallet key). The nonce is consumed first, in the same transaction,
	 * so a replayed signed message binds nothing. A wallet another principal holds is never re-pointed (NO_AUTO_MERGE).
	 */
	bindWallet(params: {
		userId: string;
		address: string;
		nonce: string;
		evidence: Record<string, unknown>;
	}): Promise<BindWalletResult>;
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

		async createWalletNonce(userId) {
			// SIWE nonces are alphanumeric, so no dashes.
			const nonce = deps.createNonceId().replaceAll("-", "");
			const expiresAt = new Date(
				new Date(deps.clock.now()).getTime() + WALLET_NONCE_TTL_MS,
			);
			await deps.repository.insertNonce({
				nonce,
				userId,
				expiresAt,
				provider: "wallet",
			});
			return { nonce, expiresAt };
		},

		async bindWallet(params) {
			return deps.repository.transaction(async (tx) => {
				const consumed = await tx.consumeNonce({
					nonce: params.nonce,
					userId: params.userId,
					now: new Date(deps.clock.now()),
					provider: "wallet",
				});
				if (!consumed) return "invalid_nonce";

				const existing = await tx.findWalletBinding(params.address);
				if (existing) {
					return existing.userId === params.userId
						? "already_bound"
						: "already_linked";
				}
				const created = await tx.createWalletBinding({
					userId: params.userId,
					address: params.address,
					evidence: params.evidence,
				});
				return created ? "created" : "already_linked";
			});
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

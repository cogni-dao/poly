// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Persistence boundary for operator-attested GitHub binding imports. */

export interface GithubBindingOwner {
	readonly id: string;
	readonly userId: string;
}

export interface AttestedGithubBindingEvidence {
	readonly issuer: string;
	readonly jti: string;
	readonly login: string | null;
	readonly iat: number;
}

/** Which flow a nonce row belongs to; one nonce can never redeem the other flow's binding. */
export type IdentityNonceProvider = "github" | "wallet";

export interface IdentityBindingTransactionPort {
	consumeNonce(params: {
		nonce: string;
		userId: string;
		now: Date;
		/** Defaults to `github`. */
		provider?: IdentityNonceProvider;
	}): Promise<boolean>;
	/** The owner of this wallet address, matched case-insensitively (login writes EIP-55 casing, the bind route lowercase). */
	findWalletBinding(address: string): Promise<GithubBindingOwner | null>;
	createWalletBinding(params: {
		userId: string;
		/** Lowercased address. */
		address: string;
		evidence: Record<string, unknown>;
	}): Promise<boolean>;
	findGithubBinding(githubId: string): Promise<GithubBindingOwner | null>;
	updateGithubLogin(bindingId: string, login: string | null): Promise<void>;
	createGithubBinding(params: {
		userId: string;
		githubId: string;
		evidence: AttestedGithubBindingEvidence;
	}): Promise<boolean>;
}

export interface IdentityBindingRepositoryPort {
	insertNonce(params: {
		nonce: string;
		userId: string;
		expiresAt: Date;
		/** Defaults to `github`. */
		provider?: IdentityNonceProvider;
	}): Promise<void>;
	transaction<T>(
		run: (tx: IdentityBindingTransactionPort) => Promise<T>,
	): Promise<T>;
}

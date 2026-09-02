// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Thin app wiring for the operator-attested identity binding feature. */

import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { resolveIdentityBindingDependencies } from "@/bootstrap/identity";
import {
	createIdentityBindingService,
	type RedeemAttestedBindingResult,
} from "@/features/identity/services/operator-attested-binding";
import {
	identityEvents,
	identitySigninChallenges,
	userBindings,
	userProfiles,
	users,
} from "@/shared/db/schema";
import {
	hashSigninNonce,
	SIGNIN_CHALLENGE_TTL_SECONDS,
} from "@/shared/identity/signin-challenge";

function service() {
	return createIdentityBindingService(resolveIdentityBindingDependencies());
}

export function createIdentityAttestationNonce(
	userId: string,
): Promise<string> {
	return service().createNonce(userId);
}

export function redeemAttestedGithubBinding(params: {
	userId: string;
	nonce: string;
	githubId: string;
	githubLogin: string | null;
	issuer: string;
	jti: string;
	iat: number;
}): Promise<RedeemAttestedBindingResult> {
	return service().redeemGithubBinding(params);
}

export type { RedeemAttestedBindingResult };

/**
 * Mint a pre-session challenge for attested SIGN-IN. Returns the plaintext nonce for the
 * URL + cookie; only its hash is persisted (HASH_AT_REST).
 */
export async function createSigninChallenge(): Promise<{ nonce: string }> {
	const nonce = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
	await getServiceDb()
		.insert(identitySigninChallenges)
		.values({
			id: randomUUID(),
			nonceHash: hashSigninNonce(nonce),
			expiresAt: new Date(Date.now() + SIGNIN_CHALLENGE_TTL_SECONDS * 1000),
		});
	return { nonce };
}

/**
 * Consume a sign-in challenge exactly once (ATTESTATION_ONE_TIME). A single conditional
 * UPDATE is the whole mechanism — no read-then-write, so two racing redemptions cannot
 * both win. Returns false when the challenge is unknown, already consumed, or expired.
 */
export async function consumeSigninChallenge(nonce: string): Promise<boolean> {
	const [consumed] = await getServiceDb()
		.update(identitySigninChallenges)
		.set({ consumedAt: new Date() })
		.where(
			and(
				eq(identitySigninChallenges.nonceHash, hashSigninNonce(nonce)),
				isNull(identitySigninChallenges.consumedAt),
				gt(identitySigninChallenges.expiresAt, new Date()),
			),
		)
		.returning({ id: identitySigninChallenges.id });
	return Boolean(consumed);
}

/**
 * Resolve the local user for an attested GitHub identity, creating a WALLET-LESS one on
 * first contact. This is what makes USER_ID_AT_CREATION true for someone who arrives
 * without a wallet — previously the only door onto a node.
 *
 * ATTESTATION_ACCOUNTS_INDEPENDENT: only the GitHub id crosses the seam. No operator
 * user id, wallet, or binding is imported; this node mints its own surrogate.
 *
 * The create path mirrors the OAuth new-user transaction in `auth.ts`: user + binding +
 * event commit together, and `onConflictDoNothing` on the binding makes a concurrent
 * first login roll back rather than commit an orphaned user row.
 */
export async function resolveAttestedGithubUser(params: {
	githubId: string;
	githubLogin: string | null;
	issuer: string;
	jti: string;
}): Promise<{ id: string; isNew: boolean }> {
	const db = getServiceDb();

	const existing = await db.query.userBindings.findFirst({
		where: and(
			eq(userBindings.provider, "github"),
			eq(userBindings.externalId, params.githubId),
		),
	});
	if (existing) {
		if (params.githubLogin) {
			try {
				await db
					.update(userBindings)
					.set({ providerLogin: params.githubLogin })
					.where(eq(userBindings.id, existing.id));
			} catch {
				// Display metadata only — never fail a sign-in over it.
			}
		}
		return { id: existing.userId, isNew: false };
	}

	const BINDING_RACE = "BINDING_RACE";
	const userId = randomUUID();
	try {
		await db.transaction(async (tx) => {
			await tx.insert(users).values({
				id: userId,
				name: params.githubLogin,
				walletAddress: null,
			});
			const [inserted] = await tx
				.insert(userBindings)
				.values({
					id: randomUUID(),
					userId,
					provider: "github",
					externalId: params.githubId,
					providerLogin: params.githubLogin,
				})
				.onConflictDoNothing({
					target: [userBindings.provider, userBindings.externalId],
				})
				.returning({ id: userBindings.id });
			if (!inserted) throw new Error(BINDING_RACE);
			await tx.insert(identityEvents).values({
				id: randomUUID(),
				userId,
				eventType: "bind",
				payload: {
					provider: "github",
					external_id: params.githubId,
					method: "operator_attestation",
					login: params.githubLogin,
					issuer: params.issuer,
					jti: params.jti,
				},
			});
			await tx.insert(userProfiles).values({ userId }).onConflictDoNothing();
		});
	} catch (error) {
		if (!(error instanceof Error) || error.message !== BINDING_RACE)
			throw error;
		const winner = await db.query.userBindings.findFirst({
			where: and(
				eq(userBindings.provider, "github"),
				eq(userBindings.externalId, params.githubId),
			),
		});
		if (!winner) throw error;
		return { id: winner.userId, isNew: false };
	}
	return { id: userId, isNew: true };
}

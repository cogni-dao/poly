// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/auth/siwe-verify`
 * Purpose: The one server-side SIWE verification. NextAuth login (`@/auth`) and the wallet bind route both call it, so a signature
 *   means the same thing on every door.
 * Scope: Parses the message and checks the domain, the signature and (when given) the nonce. No database, no session, no nonce store:
 *   whoever calls it decides where the nonce came from and consumes it.
 * Invariants:
 *   - ONE_SIWE_VERIFY: no other module constructs a `SiweMessage` to verify a login or a bind.
 *   - NEVER_THROWS: a malformed message or bad signature is `{ ok: false }`, never an exception.
 * Side-effects: none
 * @public
 */

import { CHAIN_ID, normalizeWalletAddress } from "@cogni/node-shared";
import { SiweMessage } from "siwe";

export type SiweVerifyResult =
	| {
			readonly ok: true;
			/** The address as signed (EIP-55, an input checksum). Display only: users.wallet_address keeps this form. */
			readonly address: string;
			/** The canonical wallet key: lowercase. Every binding write and comparison uses this. */
			readonly walletKey: string;
			/** The nonce inside the signed message. */
			readonly nonce: string;
	  }
	| { readonly ok: false; readonly error: string };

function nodeUrl(): URL {
	return new URL(process.env.NEXTAUTH_URL ?? "http://localhost:3000");
}

/** The host this node signs for: the same value NextAuth login has always verified against. */
export function siweDomain(): string {
	return nodeUrl().host;
}

/** The origin a challenge names as the message `uri`. */
export function siweOrigin(): string {
	return nodeUrl().origin;
}

/**
 * ISSUED_VALUES_ARE_PINNED: the only domain, uri and chain a wallet-bind message may carry, and no `resources`. The challenge route issues
 * these and the bind route verifies them (`pinned`), from this one helper; a signer (the node AI's) refuses anything else.
 */
export function siweIssued(): {
	readonly domain: string;
	readonly uri: string;
	readonly chainId: number;
} {
	return { domain: siweDomain(), uri: siweOrigin(), chainId: CHAIN_ID };
}

/** The address a message claims, for logs before verification; null when the message does not parse. */
export function siweMessageAddress(message: string): string | null {
	try {
		return new SiweMessage(message).address;
	} catch {
		return null;
	}
}

/**
 * Verify a SIWE message and signature. Pass `nonce` to require an exact match (login: the CSRF token); omit it when the
 * caller redeems the nonce from its own store afterwards (wallet bind). `pinned` ties the message to what this node issued
 * (`siweIssued()`: chain, uri origin, no resources); login does not pass it, so it verifies exactly as before.
 */
export async function verifySiwe(input: {
	message: string;
	signature: string;
	domain: string;
	nonce?: string;
	pinned?: { readonly chainId: number; readonly uri: string };
}): Promise<SiweVerifyResult> {
	try {
		const siwe = new SiweMessage(input.message);
		const result = await siwe.verify(
			{
				signature: input.signature,
				domain: input.domain,
				...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
			},
			{ suppressExceptions: true },
		);
		if (!result.success) {
			return {
				ok: false,
				error: String(result.error?.type ?? "verification_failed"),
			};
		}
		if (input.pinned) {
			if (siwe.chainId !== input.pinned.chainId) {
				return { ok: false, error: "chain_id_mismatch" };
			}
			if (new URL(siwe.uri).origin !== new URL(input.pinned.uri).origin) {
				return { ok: false, error: "uri_mismatch" };
			}
			if ((siwe.resources?.length ?? 0) > 0) {
				return { ok: false, error: "resources_not_allowed" };
			}
		}
		const { address, nonce } = result.data;
		return {
			ok: true,
			address,
			walletKey: normalizeWalletAddress(address),
			nonce,
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "invalid_message",
		};
	}
}

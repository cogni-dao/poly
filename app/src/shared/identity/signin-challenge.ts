// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/identity/signin-challenge`
 * Purpose: Cookie + hashing primitives binding an operator attestation to the browser that asked for it.
 * Scope: Pure constants and hashing. No IO, no DB, no framework.
 * Invariants:
 *   - SIGNIN_NONCE_IS_COOKIE_BOUND: the nonce travels in the URL and inside the operator's
 *     signed attestation, so possession of the token alone must never be sufficient. The
 *     browser additionally holds the nonce in an HttpOnly cookie and `authorize()` requires
 *     cookie === claims.nonce. This is the property OAuth `state` provides. Without it,
 *     dropping LOCAL_SESSION_REQUIRED would let a leaked attestation mint a session on its
 *     own, and one-time consumption in the DB would not stop a thief who races the victim.
 *   - HASH_AT_REST: only the SHA-256 of the nonce is stored, so a database read cannot
 *     reconstruct a replayable challenge.
 * Side-effects: none
 * Links: task.5042, src/auth.ts, src/app/api/v1/identity/bindings/import/start/route.ts
 * @public
 */

import { createHash } from "node:crypto";

/** Scoped to the completion path rather than the whole origin, so it is sent once. */
export const SIGNIN_CHALLENGE_COOKIE = "cogni.attest.signin";

/**
 * Must cover the operator round trip: the human reads a confirmation screen naming the
 * resolved @login before anything is signed. Deliberately longer than the attestation's
 * own 10-minute life, so the token expires first and the failure is legible.
 */
export const SIGNIN_CHALLENGE_TTL_SECONDS = 15 * 60;

export function hashSigninNonce(nonce: string): string {
	return createHash("sha256").update(nonce).digest("hex");
}

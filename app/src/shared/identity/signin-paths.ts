// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/identity/signin-paths`
 * Purpose: The one place the attestation sign-in return path is spelled.
 * Scope: Constants. No IO.
 * Invariants: REGISTER_THE_EXACT_PATH — the operator validates `return_to` against a
 *   closed set of exact paths, so this string must match the operator's allowlist
 *   entry byte for byte. Drift on either side fails closed as `invalid_return_to`.
 * Side-effects: none
 * Links: task.5042
 * @public
 */

/** Public, session-free: a signing-in user has no session yet by definition. */
export const SIGNIN_COMPLETE_PATH = "/auth/attest/complete";

/** NextAuth provider id for "GitHub, vouched for by this environment's operator". */
export const OPERATOR_ATTESTED_PROVIDER_ID = "operator-github";

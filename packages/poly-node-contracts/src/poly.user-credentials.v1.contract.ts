// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-node-contracts/poly.user-credentials.v1.contract`
 * Purpose: Self-serve credentials surface for logged-in humans — mint own agent bearer + read own billing_account_id.
 *   Powers the Profile page "API access" section so a session-authed user can
 *   bootstrap to a bearer + tenant id without an admin in the loop.
 * Scope: Two operations; does not list, name, revoke, or persist keys.
 *   `agent-keys.create.v1` (POST /api/v1/agent/keys) — session-only mint of an HMAC JWT.
 *   `users-me-account.v1` (GET /api/v1/users/me/account) — read own user + billing_account_id.
 * Invariants: HUMAN_ONLY_MINT — keys-create rejects requests carrying any Authorization
 *   Bearer header; session cookie is the only acceptable auth path;
 *   SESSION_USER_ID_IS_KEY_SUB — the issued JWT's `sub` equals the session user's id; no
 *   override accepted;
 *   OWN_ACCOUNT_ONLY — users-me-account returns billing_account_id resolved from the
 *   session/bearer's userId only.
 * Side-effects: none
 * Links: docs/spec/security-auth.md · docs/spec/poly-tenant-and-collateral.md
 * @public
 */

import { z } from "zod";

// --- agent-keys.create ---

// Body is empty in v0 — no labels, no overrides. issued JWT's displayName
// derives from sessionUser. If labels become valuable later, add then.
export const PolyAgentKeysCreateRequestSchema = z.object({}).strict();
export type PolyAgentKeysCreateRequest = z.infer<
  typeof PolyAgentKeysCreateRequestSchema
>;

export const PolyAgentKeysCreateResponseSchema = z.object({
  apiKey: z.string().min(1),
  userId: z.string().uuid(),
  displayName: z.string().nullable(),
  issuedAt: z.string(),
});
export type PolyAgentKeysCreateResponse = z.infer<
  typeof PolyAgentKeysCreateResponseSchema
>;

export const polyAgentKeysCreateOperation = {
  id: "poly.agent-keys.create.v1",
  summary: "Mint a Cogni-poly agent bearer for the calling session user",
  description:
    "Session-cookie-only mint. Rejects Bearer-authed requests with 403. The returned apiKey is shown once; rotation = mint a new key + stop using the old. Multiple keys may coexist until exp (90d). No server-side registry, no revoke (v0 limitation).",
  input: PolyAgentKeysCreateRequestSchema,
  output: PolyAgentKeysCreateResponseSchema,
} as const;

// --- users-me-account ---

export const PolyUsersMeAccountResponseSchema = z.object({
  userId: z.string().uuid(),
  billingAccountId: z.string().uuid(),
  displayName: z.string().nullable(),
});
export type PolyUsersMeAccountResponse = z.infer<
  typeof PolyUsersMeAccountResponseSchema
>;

export const polyUsersMeAccountOperation = {
  id: "poly.users-me-account.v1",
  summary: "Return the calling user's userId + billingAccountId + displayName",
  description:
    "Self-only lookup. Used by the Profile UI to display these ids and by CLI scripts to learn the tenant id without an out-of-band lookup. Accepts bearer or session cookie — both are scoped to the same own-account result.",
  input: z.object({}).strict(),
  output: PolyUsersMeAccountResponseSchema,
} as const;

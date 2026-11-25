// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/identity/wallet/challenge`
 * Purpose: Step one of binding a wallet to the calling principal: mint a single-use SIWE nonce and the message fields to sign.
 * Scope: POST-only, any authenticated principal (a session or an AI bearer key). Writes one short-lived nonce row owned by the caller.
 * Invariants:
 *   - ONE_DOOR_ANY_PRINCIPAL: resolved by `getSessionUser`, so a human session and an agent bearer take the same path.
 *   - NONCE_OWNED_AND_SINGLE_USE: the nonce belongs to the caller and expires; `/wallet/bind` consumes it exactly once.
 *   - OWN_DATA_ONLY: declared `bearerWrite`; the route reads and writes nothing but the caller's own nonce.
 * Side-effects: IO (nonce insert)
 * Links: https://node-template.cognidao.org/knowledge/identity-north-star-design
 * @public
 */

import { NextResponse } from "next/server";

import { createWalletChallenge } from "@/app/_facades/identity/operator-attested-binding.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { siweIssued } from "@/app/_lib/auth/siwe-verify";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
	{
		routeId: "identity.wallet.challenge",
		bearerWrite:
			"mints a nonce owned by the caller and touches no one else's data; binding it still needs the wallet's own signature",
		auth: { mode: "required", getSessionUser },
	},
	async (_ctx, _request, sessionUser) => {
		const { nonce, expiresAt } = await createWalletChallenge(sessionUser.id);
		return NextResponse.json(
			{
				nonce,
				expiresAt: expiresAt.toISOString(),
				// The fields of the EIP-4361 message to sign; the caller adds its own `address`.
				message: {
					...siweIssued(),
					version: "1",
					nonce,
					statement: "Bind this wallet to my account on this node.",
					issuedAt: new Date().toISOString(),
					expirationTime: expiresAt.toISOString(),
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	},
);

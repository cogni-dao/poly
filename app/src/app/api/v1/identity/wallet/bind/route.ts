// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/identity/wallet/bind`
 * Purpose: Step two of binding a wallet: the caller proves control of an address by signing the challenge, and this node records
 *   a `user_bindings` wallet row for the calling principal, so the one admin check can see it.
 * Scope: POST-only, any authenticated principal (a session or an AI bearer key). Verifies with the shared SIWE verify, redeems the nonce, writes the binding.
 * Invariants:
 *   - ONE_SIWE_VERIFY: `verifySiwe`, the same function NextAuth login uses. The message is pinned to what the challenge issued (`siweIssued()`:
 *     this node's domain, uri and chain, no resources).
 *   - ONE_WALLET_ONE_KEY: the binding is keyed by the lowercase address (`walletKey`); EIP-55 is only the input checksum.
 *   - NONCE_CONSUMED_BEFORE_BINDING: a replayed signed message is refused (400 `invalid_nonce`) and binds nothing.
 *   - NO_AUTO_MERGE: an address another principal holds is 409 `already_linked`, never re-pointed.
 *   - AGENT_WALLET_IS_NOT_A_PAYEE: an agent may bind a wallet (it makes the agent an admin when the DAO lists it); payout and claimant
 *     resolution skip agent-owned wallets, and the database refuses a payout leaf for one.
 *   - OWN_DATA_ONLY: declared `bearerWrite`; the only row written is the caller's own binding.
 * Side-effects: IO (nonce redemption, binding and evidence rows)
 * Links: https://node-template.cognidao.org/knowledge/identity-north-star-design
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { bindVerifiedWallet } from "@/app/_facades/identity/operator-attested-binding.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { siweIssued, verifySiwe } from "@/app/_lib/auth/siwe-verify";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z
	.object({ message: z.string().min(1), signature: z.string().min(1) })
	.strict();

export const POST = wrapRouteHandlerWithLogging(
	{
		routeId: "identity.wallet.bind",
		bearerWrite:
			"binds a wallet to the caller's own principal after the wallet signs for it; touches no one else's data",
		auth: { mode: "required", getSessionUser },
	},
	async (ctx, request, sessionUser) => {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
		}
		const parsed = bodySchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Invalid request body", details: parsed.error.issues },
				{ status: 400 },
			);
		}

		const issued = siweIssued();
		const verified = await verifySiwe({
			...parsed.data,
			domain: issued.domain,
			pinned: issued,
		});
		if (!verified.ok) {
			ctx.log.warn({ error: verified.error }, "[wallet-bind] signature refused");
			return NextResponse.json({ errorCode: "invalid_signature" }, { status: 401 });
		}

		const result = await bindVerifiedWallet({
			userId: sessionUser.id,
			address: verified.walletKey,
			nonce: verified.nonce,
			evidence: { domain: issued.domain, via: sessionUser.via ?? "session" },
		});
		if (result === "invalid_nonce") {
			return NextResponse.json({ errorCode: "invalid_nonce" }, { status: 400 });
		}
		if (result === "already_linked") {
			return NextResponse.json({ errorCode: "already_linked" }, { status: 409 });
		}
		ctx.log.info(
			{ userId: sessionUser.id, via: sessionUser.via, created: result === "created" },
			"[wallet-bind] wallet bound",
		);
		return NextResponse.json(
			{ address: verified.walletKey, bound: true, created: result === "created" },
			{ headers: { "cache-control": "no-store" } },
		);
	},
);

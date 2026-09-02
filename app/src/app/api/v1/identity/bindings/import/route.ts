// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/identity/bindings/import`
 * Purpose: Imports an operator-attested GitHub binding — lets a contributor who
 *   proved GitHub on the operator hub become claimable on this node without
 *   node-local OAuth (task.5024, fixes bug.5039 class of unresolved claimants).
 * Scope: POST-only. Verifies the attestation JWT (delegated to
 *   operator-attestation verifier), then writes THIS node's own user_bindings
 *   row for the local user who owns the one-time nonce.
 *   Does not issue attestations (operator's job) or run identity resolution.
 * Invariants:
 *   - LOCAL_SESSION_REQUIRED: token alone is useless — a live local session
 *     must own and consume the one-time nonce.
 *   - FAIL_CLOSED: JWKS unreachable → 503 jwks_unavailable, never a silent bind.
 *   - NO_AUTO_MERGE: github id owned by a different user → 409 already_linked.
 *   - NODE_WRITES_OWN_LEDGER: binding + evidence rows are written locally with
 *     provenance {method: operator_attestation, issuer, jti}.
 *   - ECHO_THE_BOUND_LOGIN: the response names the GitHub login actually bound, so
 *     the UI can prove WHICH account was recorded rather than saying "verified".
 * Side-effects: IO (remote JWKS fetch, service-role database writes)
 * Links: src/app/_lib/auth/operator-attestation.ts, src/features/identity/services/operator-attested-binding.ts, task.5024
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { redeemAttestedGithubBinding } from "@/app/_facades/identity/operator-attested-binding.server";
import { verifyOperatorAttestation } from "@/app/_lib/auth/operator-attestation";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";
import { getNodeId } from "@/shared/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const importBindingBodySchema = z.object({
	token: z.string().min(1),
}).strict();

export const POST = wrapRouteHandlerWithLogging(
	{
		routeId: "identity.bindings.import",
		auth: { mode: "required", getSessionUser: getServerSessionUser },
	},
	async (ctx, request, sessionUser) => {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
		}

		const parsed = importBindingBodySchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Invalid request body", details: parsed.error.issues },
				{ status: 400 },
			);
		}

		const nodeId = getNodeId();
		const verified = await verifyOperatorAttestation(parsed.data.token, nodeId);
		if (!verified.ok) {
			const status = verified.errorCode === "jwks_unavailable" ? 503 : 401;
			ctx.log.warn(
				{ errorCode: verified.errorCode },
				"Attestation verification failed",
			);
			return NextResponse.json({ errorCode: verified.errorCode }, { status });
		}

		const result = await redeemAttestedGithubBinding({
			userId: sessionUser.id,
			nonce: verified.claims.nonce,
			githubId: verified.claims.github.id,
			githubLogin: verified.claims.github.login,
			issuer: verified.claims.issuer,
			jti: verified.claims.jti,
			iat: verified.claims.iat,
		});

		if (result === "invalid_nonce") {
			return NextResponse.json(
				{ errorCode: "invalid_token" },
				{ status: 401 },
			);
		}

		if (result === "already_linked") {
			// NO_AUTO_MERGE: bound to a different user — never re-point.
			return NextResponse.json(
				{ errorCode: "already_linked" },
				{ status: 409 },
			);
		}

		ctx.log.info(
			{
				event: "identity.binding_imported",
				result,
				issuer: verified.claims.issuer,
				jti: verified.claims.jti,
				nodeId,
			},
			"Operator-attested github binding imported",
		);

		// Echo the bound login so the UI can name the account it just recorded.
		// A generic "verified" is what let the wrong account pass unnoticed on the
		// 2026-08-19 candidate; the human must be able to read back WHO was bound.
		if (result === "already_bound") {
			return NextResponse.json(
				{
					bound: true,
					code: "already_bound",
					githubLogin: verified.claims.github.login,
				},
				{ status: 200 },
			);
		}

		return NextResponse.json(
			{ bound: true, githubLogin: verified.claims.github.login },
			{ status: 201 },
		);
	},
);

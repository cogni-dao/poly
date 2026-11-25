// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/.well-known/jwks.json`
 * Purpose: This node's public service-assertion keys (story.0038), so a target node can verify the assertions this node signs as a home.
 * Scope: Single GET handler. Public, no auth. The key set comes from the signer in the container, which holds the public half only here.
 * Invariants:
 *   - NO_PRIVATE_MEMBER: the response is the signer's `jwks()`, an explicit public-key allowlist; the private JWK never reaches this route.
 *   - UNSET_IS_404: with no `SERVICE_ASSERTION_SIGNING_SEED` configured, this node is not a home and the route is 404.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const signer = await getContainer().serviceAuth.getSigner();
  if (!signer) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  return NextResponse.json(signer.jwks(), { headers: { "cache-control": "public, max-age=60" } });
}

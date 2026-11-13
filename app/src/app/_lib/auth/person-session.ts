// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/auth/person-session`
 * Purpose: The guard for a signed-in PERSON's own routes (not Admin): a same-origin browser session only, and the person's id from it.
 * Scope: Auth plumbing. Decides no authority: a person's own agents need no admin check (APPROVER_FOLLOWS_RESOURCE: your own rows, you decide).
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: ANY `Authorization` header is 403 `human_session_required`, before the session is read, even from an admin or an agent.
 *   - Signed out is 401 `unauthorized`. A resolved identity that is not a browser session is also 401 (a key never acts as a person here).
 *   - Every response, errors included, is `no-store`.
 * Side-effects: IO (session read), logs `human_plane.refused` on a refusal
 * Links: src/app/_lib/auth/human-plane.ts, https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { NextResponse } from "next/server";

import { refuseNonSession } from "@/app/_lib/auth/human-plane";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";

export type PersonSessionResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly response: NextResponse };

const NO_STORE = { "cache-control": "no-store" } as const;

/** JSON response that is never cached. */
export const noStoreJson = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, { status, headers: NO_STORE });

export async function requirePersonSession(request: Request): Promise<PersonSessionResult> {
  const refused = refuseNonSession(request, getContainer().log);
  if (refused) return { ok: false, response: refused };
  const user = await getSessionUser();
  if (!user || user.via !== "session") return { ok: false, response: noStoreJson({ error: "unauthorized" }, 401) };
  return { ok: true, userId: user.id };
}

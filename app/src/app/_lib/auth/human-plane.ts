// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/auth/human-plane`
 * Purpose: The one guard every human-plane route calls first. A human route accepts a same-origin session only.
 * Scope: Pure request check. Does not read the session.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY (KIND_PICKS_THE_PLANE): ANY `Authorization` header, valid or not, gets 403 with body code
 *     `human_session_required`, even from an admin who holds a key. An AI admin uses the AI plane, which runs the same
 *     authority check.
 *   - Each human route must call this first; S2 adds more human routes, and moving the guard into a published package
 *     (or a wrapper option) is a tracked follow-up before the cohort (review J1/J9).
 * Side-effects: logs one `human_plane.refused` warning (a fixed scheme name only) when it refuses
 * Links: https://cognidao.org/knowledge/ai-access-surface-design (Routes)
 * @public
 */

import { HUMAN_SESSION_REQUIRED } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { EVENT_NAMES } from "@/shared/observability";

/** The only values a log line may carry for the header: a fixed allowlist, never any part of the credential. */
export type RefusedScheme = "bearer" | "basic" | "digest" | "negotiate" | "other";

export function refusedScheme(header: string): RefusedScheme {
  const match = /^\s*(bearer|basic|digest|negotiate)\s/i.exec(header);
  return match ? (match[1]?.toLowerCase() as RefusedScheme) : "other";
}

/**
 * Returns the 403 response when the request carries an Authorization header, else null. When a logger is given it logs
 * the refusal with one of five fixed scheme names (`refusedScheme`), never a slice of the header, so a credential sent
 * without a scheme (for example a raw key or token) cannot reach a log field.
 */
export function refuseNonSession(
  request: Request,
  log?: { warn: (fields: Record<string, unknown>, msg: string) => void }
): NextResponse | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  log?.warn(
    { event: EVENT_NAMES.HUMAN_PLANE_REFUSED, code: HUMAN_SESSION_REQUIRED, scheme: refusedScheme(header) },
    EVENT_NAMES.HUMAN_PLANE_REFUSED
  );
  return NextResponse.json(
    { error: HUMAN_SESSION_REQUIRED, code: HUMAN_SESSION_REQUIRED },
    { status: 403, headers: { "cache-control": "no-store" } }
  );
}

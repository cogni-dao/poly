// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/internal/ops/poly/egress-check`
 * Purpose: Report whether THIS pod's actual outbound path is accepted by
 *   Polymarket, by asking Polymarket's own geoblock oracle from inside the
 *   running workload.
 * Scope: Bearer-auth GET. Read-only: one outbound GET, no DB, no signing, no
 *   fund movement, no placement decision.
 * Invariants:
 *   - INTERNAL_OPS_AUTH: requires Bearer INTERNAL_OPS_TOKEN. The response
 *     discloses the pod's egress IP, so it is never public.
 *   - IN_WORKLOAD_IS_THE_ONLY_PROOF (story.5050): a provider's advertised
 *     region and its Console `ipCountryCode` describe INGRESS. Polymarket
 *     geoblocks EGRESS, and the two have already been measured to disagree
 *     (ZenCloud and Digital Frontier both exited 80.199.246.35). So the only
 *     admissible evidence that a lease can trade is `blocked:false` observed
 *     from inside that lease — which is what this route exists to produce.
 *   - OBSERVE_NEVER_GATE: this route reports; it does not gate readiness,
 *     select providers, or filter bids. Placement logic is operator-owned.
 *   - FAIL_LOUD: a probe that cannot complete returns `blocked: null` with the
 *     error class. An unreachable oracle is never reported as "not blocked".
 * Side-effects: one outbound HTTPS GET to polymarket.com; emits
 *   `poly.egress.geoblock` so the result is also readable from Loki.
 * Links: work/items/story.5050, work/items/bug.5270, work/items/bug.5310
 * @internal
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GEOBLOCK_URL = "https://polymarket.com/api/geoblock";
const PROBE_TIMEOUT_MS = 8_000;
const MAX_AUTH_HEADER_LENGTH = 512;
const MAX_TOKEN_LENGTH = 256;

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  if (authHeader.length > MAX_AUTH_HEADER_LENGTH) return null;
  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  if (token.length > MAX_TOKEN_LENGTH) return null;
  return token;
}

type GeoblockOracleResponse = {
  readonly blocked?: unknown;
  readonly ip?: unknown;
  readonly country?: unknown;
  readonly region?: unknown;
};

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "poly.egress_check.ops", auth: { mode: "none" } },
  async (ctx, request) => {
    const env = serverEnv();
    const configuredToken = env.INTERNAL_OPS_TOKEN;
    if (!configuredToken) {
      ctx.log.error("INTERNAL_OPS_TOKEN not configured");
      return NextResponse.json(
        { error: "service_not_configured" },
        { status: 500 }
      );
    }
    const providedToken = extractBearerToken(
      request.headers.get("authorization")
    );
    if (!providedToken || !safeCompare(providedToken, configuredToken)) {
      ctx.log.warn("Invalid or missing INTERNAL_OPS_TOKEN");
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const started = performance.now();
    let blocked: boolean | null = null;
    let ip: string | null = null;
    let country: string | null = null;
    let region: string | null = null;
    let errorClass: string | null = null;
    let httpStatus: number | null = null;

    try {
      const res = await fetch(GEOBLOCK_URL, {
        cache: "no-store",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      httpStatus = res.status;
      if (!res.ok) {
        errorClass = `oracle_http_${res.status}`;
      } else {
        const body = (await res.json()) as GeoblockOracleResponse;
        // FAIL_LOUD: only a literal boolean counts. A missing/!boolean field
        // stays `null` rather than coercing to "not blocked".
        blocked = typeof body.blocked === "boolean" ? body.blocked : null;
        if (blocked === null) errorClass = "oracle_shape_unexpected";
        ip = asStringOrNull(body.ip);
        country = asStringOrNull(body.country);
        region = asStringOrNull(body.region);
      }
    } catch (error) {
      errorClass =
        error instanceof Error && error.name === "TimeoutError"
          ? "oracle_timeout"
          : "oracle_unreachable";
    }

    const durationMs = Math.round(performance.now() - started);
    // Logged as well as returned so the result is provable from Loki alone,
    // without holding the ops token.
    ctx.log.info(
      {
        event: "poly.egress.geoblock",
        blocked,
        egress_ip: ip,
        egress_country: country,
        egress_region: region,
        oracle_http_status: httpStatus,
        duration_ms: durationMs,
        ...(errorClass ? { error_class: errorClass } : {}),
      },
      blocked === false
        ? "egress permitted by Polymarket"
        : blocked === true
          ? "egress BLOCKED by Polymarket"
          : "egress geoblock probe inconclusive"
    );

    return NextResponse.json(
      {
        blocked,
        egress_ip: ip,
        egress_country: country,
        egress_region: region,
        oracle_url: GEOBLOCK_URL,
        oracle_http_status: httpStatus,
        duration_ms: durationMs,
        error_class: errorClass,
      },
      // A conclusive answer is a successful observation, even when blocked.
      { status: blocked === null ? 503 : 200 }
    );
  }
);

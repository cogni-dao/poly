// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Poly readiness: local sticky egress admission and declared deep diagnostics. */
import { metaReadyzOperation } from "@cogni/node-contracts";
import { serveReadyz } from "@cogni/substrate-health";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { localReadinessPreflight } from "@/bootstrap/local-readiness-preflight";
import { withRootSpan } from "@/bootstrap/otel";
import { getEgressGeoblockLatch } from "@/lib/egress-geoblock";
import { getNodeId } from "@/shared/config";
import { EnvValidationError, serverEnv } from "@/shared/env";
import { InfraConnectivityError, RuntimeSecretError } from "@/shared/env/invariants";
import { createRequestContext, httpRequestDurationMs, httpRequestsTotal, logRequestEnd, makeLogger, statusBucket } from "@/shared/observability";
import { setBuildInfo } from "@/shared/observability/server/metrics";
import { buildDeepChecks, deepRuntime } from "./readyz-probes";

export const dynamic = "force-dynamic";
class EgressGeoblocked extends Error {}
const EGRESS_MESSAGE = "Polymarket geoblocks this pod's outbound path; this lease cannot place orders";

export async function GET(request: Request): Promise<NextResponse> {
  let started = 0;
  let status = 500;
  let errorCode: string | undefined;
  let settledResponse: NextResponse | undefined;
  let log: ReturnType<typeof makeLogger> | undefined;
  try {
    started = performance.now();
    return await withRootSpan("GET meta.readyz", { route_id: "meta.readyz" }, async ({ traceId, span }) => {
      try {
      log = makeLogger({ service: "cogni-template", route: "meta.readyz", method: request.method, traceId });
      const ctx = createRequestContext({ baseLog: log, clock: { now: () => new Date().toISOString() } }, request, { routeId: "meta.readyz", traceId });
      log = ctx.log;
      span.setAttribute("request_id", ctx.reqId);
      try { ctx.log = ctx.log.child({ nodeId: getNodeId() }); log = ctx.log; }
      catch (error) { if (!(error instanceof EnvValidationError || error instanceof RuntimeSecretError)) throw error; }
      const result = await serveReadyz({
        deep: new URL(request.url).searchParams.get("deep") === "1",
        local: () => {
          const env = serverEnv();
          const egress = getEgressGeoblockLatch();
          if (egress.latched) {
            throw new EgressGeoblocked();
          }
          localReadinessPreflight();
          try { setBuildInfo(process.env.npm_package_version || "unknown", env.APP_BUILD_SHA || "unknown"); } catch {}
          return { buildSha: env.APP_BUILD_SHA || undefined, version: process.env.npm_package_version || undefined };
        },
        deepChecks: () => buildDeepChecks(ctx, getContainer(), serverEnv()),
        runtime: { ...deepRuntime(ctx), log: (...args: Parameters<ReturnType<typeof deepRuntime>["log"]>) => { try { deepRuntime(ctx).log(...args); } catch {} } },
        onFailure: (error) => { try { errorCode = error instanceof EgressGeoblocked ? "EGRESS_GEOBLOCKED" : error instanceof EnvValidationError ? "INVALID_ENV" : error instanceof RuntimeSecretError ? "MISSING_RUNTIME_SECRET" : error instanceof InfraConnectivityError ? "INFRA_UNREACHABLE" : "INTERNAL_ERROR"; } catch { errorCode = "INTERNAL_ERROR"; } },
        describeError: (error) => {
          if (error instanceof EgressGeoblocked) return { reason: "EGRESS_GEOBLOCKED", message: EGRESS_MESSAGE };
          if (error instanceof EnvValidationError) return { reason: error.meta.code, details: error.meta };
          if (error instanceof RuntimeSecretError || error instanceof InfraConnectivityError) return { reason: error.code, message: error.message };
          return { reason: "INTERNAL_ERROR" };
        },
      });
      const body = result.status === 200 ? metaReadyzOperation.output.parse(result.body) : result.body;
      const response = NextResponse.json(body, { status: result.status }); status = response.status; settledResponse = response; return response;
      } catch {
        errorCode = "INTERNAL_SERVER_ERROR";
        status = 500;
        settledResponse = new NextResponse(JSON.stringify({ status: "error", reason: "INTERNAL_ERROR" }), { status: 500, headers: { "content-type": "application/json" } });
        return settledResponse;
      }
    });
  } catch {
    if (settledResponse) return settledResponse;
    status = 500;
    errorCode = "INTERNAL_SERVER_ERROR";
    return new NextResponse(JSON.stringify({ status: "error", reason: "INTERNAL_ERROR" }), { status: 500, headers: { "content-type": "application/json" } }); }
  finally {
    try { if (errorCode) log?.error(errorCode === "EGRESS_GEOBLOCKED" ? { event: "poly.egress.geoblock.latched", severity: "critical", errorCode, reason: "EGRESS_GEOBLOCKED", dependency: "polymarket-egress" } : { errorCode }, errorCode === "INTERNAL_SERVER_ERROR" ? "request failed" : "readiness check failed"); } catch {}
    let durationMs = 0;
    try { durationMs = performance.now() - started; } catch {}
    try { if (log) logRequestEnd(log, { status, durationMs }); } catch {}
    try {
      httpRequestsTotal.inc({ route: "meta.readyz", method: request.method, status: statusBucket(status) });
    } catch {}
    try {
      httpRequestDurationMs.observe({ route: "meta.readyz", method: request.method }, durationMs);
    } catch {}
  }
}

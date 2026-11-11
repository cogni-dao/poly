// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/readyz`
 * Purpose: HTTP readiness endpoint. The default (k8s probe) path answers only "can this pod serve HTTP?" — local serving readiness: env and runtime secrets (fatal); remote dependencies are observed, not gated.
 * Scope: Validates env + runtime secrets (fatal). Checks EVM RPC, Temporal, scheduler-worker, and the Postgres system tenant but treats failures as NON-FATAL on the default probe (logged, still 200). `?deep=1` restores hard substrate assertion for provisioning / stack-test smoke checks. Also reads (never runs) the boot-time Polymarket egress assertion latch.
 * Invariants: EGRESS_GEOBLOCK_LATCH_IS_FATAL: when the boot-time egress assertion latched (N consecutive literal `blocked:true` verdicts from Polymarket inside the boot window), this endpoint 503s with reason `EGRESS_GEOBLOCKED` so the operator's boot SLO refuses the lease and re-mints elsewhere (story.5050). That latch is sticky, boot-window-bounded and never set by an unreachable oracle, so it cannot reproduce the 2026-06-26 drain; this route only READS it and performs zero IO for it. Always returns valid readyz schema; force-dynamic runtime. Every managed non-test node requires and exercises EVM RPC even before payment activation. The default path does not drain the fleet for a transient upstream failure (incident 2026-06-26: scheduler-worker hiccup → fleet-wide 502); `?deep=1` forces a live RPC read and makes EVM RPC, Temporal, and scheduler-worker failures fatal (503).
 *             The default path runs every check concurrently and is bounded (task.5298): non-fatal checks get NON_FATAL_CHECK_BUDGET_MS and are reported degraded on timeout; the system tenant (DB verdict, NON-FATAL since bug.0022: failure logs critical and reports degraded; provisioning is asserted once at boot by bootstrap/startup-assertions) gets SYSTEM_TENANT_BUDGET_MS and only its success is cached for SYSTEM_TENANT_OK_TTL_MS. The first probe after boot always performs the real DB check. `?deep=1` runs the declared-dependency registry concurrently and uncached, each check bounded by DEEP_CHECK_BUDGET_MS. The egress latch read stays first and zero-IO.
 * Side-effects: IO (HTTP response, structured logging, network calls to RPC, Temporal, LiteLLM, Redis, Doltgres)
 *             `?deep=1` probes exactly the Depend-class dependencies this node DECLARES, from the `SUBSTRATE_DEPENDENCIES` registry (readyz-probes.ts, built on `@cogni-dao/substrate-health`): evm-rpc, temporal, scheduler-worker, postgres, redis, litellm-gateway, and doltgres (only when DOLTGRES_URL is set). They run concurrently, each under DEEP_CHECK_BUDGET_MS, and a deep body adds `checks` (each probed dependency's status, on 200 and 503); a deep 503 also adds `unreachable` (every failing declared dependency) and `buildSha`. Readers parse it only through `readDeepReadiness` (@cogni-dao/substrate-health). `reason`/`message` come from the first failure in registry order. Config errors (env, secrets, egress latch) return before any check and carry no `unreachable`. The default path never adds the field and does no new IO. Poly-specific optional keys (POLYGON_RPC_URL/WSS, PAPER_SIDECAR_URL) are N/A-with-reason in the registry, not probed. A CI parity test keeps the registry in sync with the env schema.
 * Notes: Used by Docker HEALTHCHECK, deployment validation, K8s readiness probes.
 *        HTTP status is primary truth: 200 = ready, 503 = not ready.
 *        Provisioning / smoke checks that must assert the substrate is up call `/readyz?deep=1`.
 *        Logs readiness failures for deployment debugging.
 * Links: `@contracts/meta.readyz.read.v1.contract`, src/app/(infra)/readyz/readyz-probes.ts, src/shared/env/invariants.ts, src/app/(infra)/livez/route.ts, src/lib/egress-geoblock.ts, work/items/story.5050, knowledge entry `node-choose-placement-region`
 * @public
 */

import { metaReadyzOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { verifySystemTenant } from "@/bootstrap/healthchecks";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getEgressGeoblockLatch } from "@/lib/egress-geoblock";
import { EnvValidationError, serverEnv } from "@/shared/env";
import {
  assertEvmRpcConfig,
  assertRuntimeSecrets,
  assertSchedulerWorkerConnectivity,
  assertTemporalConnectivity,
  checkEvmRpcConnectivity,
  InfraConnectivityError,
  RuntimeSecretError,
} from "@/shared/env/invariants";
import type { RequestContext } from "@/shared/observability";
import { setBuildInfo } from "@/shared/observability/server/metrics";
import {
  buildDeepChecks,
  type DeepChecks,
  DeepProbeFailure,
  runDeepChecks,
} from "./readyz-probes";

export const dynamic = "force-dynamic";

/**
 * Logs readiness check failure with structured context.
 * Called before returning 503 to ensure failures are visible in deployment logs.
 */
function logReadinessFailure(
  ctx: RequestContext,
  error:
    | EnvValidationError
    | RuntimeSecretError
    | InfraConnectivityError
    | Error
): void {
  if (error instanceof EnvValidationError) {
    ctx.log.error(
      {
        reason: error.meta.code,
        missing: error.meta.missing,
        invalid: error.meta.invalid,
      },
      "readiness check failed: invalid environment configuration"
    );
  } else if (error instanceof RuntimeSecretError) {
    ctx.log.error(
      {
        reason: error.code,
        message: error.message,
      },
      "readiness check failed: missing runtime secret"
    );
  } else if (error instanceof InfraConnectivityError) {
    ctx.log.error(
      {
        reason: error.code,
        message: error.message,
      },
      "readiness check failed: infrastructure unreachable"
    );
  } else {
    // pg/drizzle errors wrap the driver error (with its SQLSTATE `code`) in `cause`.
    const cause = (error as { cause?: { code?: unknown; message?: unknown } })
      .cause;
    ctx.log.error(
      {
        reason: "INTERNAL_ERROR",
        error: error.message,
        causeCode: cause?.code,
        causeMessage: cause?.message,
      },
      "readiness check failed: internal error"
    );
  }
}

/** Default-path budget for each non-fatal remote check (EVM RPC, Temporal, scheduler-worker). */
const NON_FATAL_CHECK_BUDGET_MS = 1500;
/** Default-path budget for the system-tenant DB check; exceeding it reports degraded (non-fatal). */
const SYSTEM_TENANT_BUDGET_MS = 2000;
/** Successful system-tenant checks are reused for at most this long. Failures are never cached. */
const SYSTEM_TENANT_OK_TTL_MS = 30_000;
/** An in-flight tenant query older than this is abandoned and a fresh one started. */
const SYSTEM_TENANT_INFLIGHT_MAX_AGE_MS = 10_000;
/** Readiness summaries at or above this duration log at info (debug otherwise). */
const SLOW_READINESS_LOG_MS = 1000;

/** Epoch ms of the last successful default-path system-tenant check (0 = never). */
let systemTenantVerifiedAtMs = 0;
/** The single in-flight default-path tenant query, shared by concurrent probes. */
let systemTenantInflight: {
  promise: Promise<void>;
  startedAtMs: number;
} | null = null;

type CheckStatus = "ok" | "cached" | "degraded" | "timeout" | "failed";
type CheckTimings = Record<string, { status: CheckStatus; durationMs: number }>;

const CHECK_TIMEOUT = Symbol("readyz.check_timeout");

/**
 * Race `promise` against a budget. The underlying work keeps running (and may
 * warm a cache, e.g. the EVM RPC probe), but the probe stops waiting for it.
 */
async function withBudget<T>(
  promise: Promise<T>,
  budgetMs: number
): Promise<T | typeof CHECK_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof CHECK_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(CHECK_TIMEOUT), budgetMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run one named check, recording its status and duration in `timings`. */
async function timed(
  timings: CheckTimings,
  name: string,
  run: () => Promise<CheckStatus>
): Promise<void> {
  const startedAt = Date.now();
  try {
    const status = await run();
    timings[name] = { status, durationMs: Date.now() - startedAt };
  } catch (error) {
    timings[name] = { status: "failed", durationMs: Date.now() - startedAt };
    throw error;
  }
}

function logBudgetExceeded(
  ctx: RequestContext,
  event: string,
  dependency: string
): void {
  ctx.log.warn(
    {
      event,
      severity: "degraded",
      reason: "CHECK_TIMEOUT",
      dependency,
      budgetMs: NON_FATAL_CHECK_BUDGET_MS,
    },
    `readiness: ${dependency} check exceeded its budget, returning ready (non-fatal)`
  );
}

/**
 * Bounded system-tenant check (per SYSTEM_TENANT_STARTUP_CHECK). Throws on
 * failure or budget; the default route wraps it non-fatally via
 * `checkSystemTenantNonFatal`. Bounded so a wedged service pool fails fast;
 * success is cached briefly so steady-state probes do not hit Postgres.
 * Probes share one in-flight query, and a success that lands after a probe's
 * budget still fills the cache, so a slow-but-healthy DB does not stack
 * queries or 503 forever. A query that never settles (the DB client has no
 * query timeout) is abandoned after SYSTEM_TENANT_INFLIGHT_MAX_AGE_MS so a
 * fresh query can prove recovery. Failures are never cached.
 */
async function checkSystemTenant(
  serviceAccountService: Parameters<typeof verifySystemTenant>[0]
): Promise<CheckStatus> {
  if (
    systemTenantVerifiedAtMs > 0 &&
    Date.now() - systemTenantVerifiedAtMs < SYSTEM_TENANT_OK_TTL_MS
  ) {
    return "cached";
  }
  if (
    !systemTenantInflight ||
    Date.now() - systemTenantInflight.startedAtMs >
      SYSTEM_TENANT_INFLIGHT_MAX_AGE_MS
  ) {
    // An abandoned query that settles later must not touch the newer state.
    const inflight = {
      startedAtMs: Date.now(),
      promise: verifySystemTenant(serviceAccountService)
        .then(() => {
          if (systemTenantInflight === inflight) {
            systemTenantVerifiedAtMs = Date.now();
          }
        })
        .finally(() => {
          if (systemTenantInflight === inflight) systemTenantInflight = null;
        }),
    };
    systemTenantInflight = inflight;
  }
  const result = await withBudget(
    systemTenantInflight.promise,
    SYSTEM_TENANT_BUDGET_MS
  );
  if (result === CHECK_TIMEOUT) {
    throw new InfraConnectivityError(
      `System tenant check exceeded ${SYSTEM_TENANT_BUDGET_MS}ms budget`
    );
  }
  return "ok";
}

/**
 * Default-path system-tenant check: NON-FATAL (bug.0022). A k8s readiness probe
 * must not hard-gate on a shared DB: a Postgres blip would drain every pod from
 * its Service at once. Provisioning (a missing cogni_system tenant) is asserted
 * once at process boot instead (`bootstrap/startup-assertions`), so a pod that
 * is genuinely unprovisioned crash-loops rather than serving.
 *
 * Any rejection of `checkSystemTenant` (query error, missing account, budget
 * exceeded) becomes `"degraded"` plus a stable critical log, never a throw. The
 * deep probe does not use this: it calls `verifySystemTenant` directly and
 * still 503s with `postgres` in `unreachable`.
 */
async function checkSystemTenantNonFatal(
  ctx: RequestContext,
  serviceAccountService: Parameters<typeof verifySystemTenant>[0]
): Promise<CheckStatus> {
  try {
    return await checkSystemTenant(serviceAccountService);
  } catch (error) {
    // pg/drizzle errors wrap the driver error (with its SQLSTATE `code`) in `cause`.
    const cause = (error as { cause?: { code?: unknown; message?: unknown } })
      .cause;
    ctx.log.error(
      {
        event: "substrate.postgres.unreachable",
        severity: "critical",
        reason:
          error instanceof InfraConnectivityError
            ? error.code
            : "SYSTEM_TENANT_CHECK_FAILED",
        dependency: "postgres",
        message: error instanceof Error ? error.message : String(error),
        causeCode: cause?.code,
        causeMessage: cause?.message,
      },
      "readiness: postgres system-tenant check failed — shared DB down or unprovisioned. Returning ready: probe stays non-fatal so the fleet is not drained; provisioning is asserted at boot and the critical alert covers the outage."
    );
    return "degraded";
  }
}

/**
 * Async-substrate connectivity check that is NON-FATAL to the k8s readiness
 * probe by default. Temporal and scheduler-worker are async dispatch substrate,
 * not synchronous serving dependencies — failing /readyz on their blip drains
 * every node-app from its Service endpoints and causes a fleet-wide 502
 * (incident 2026-06-26). Same rationale already applied to EVM RPC.
 *
 * They ARE mission-critical: all AI/chat work is dispatched through Temporal, so
 * a sustained outage means AI is down. We therefore log failures at ERROR with a
 * stable `event` + `severity:"critical"` so monitoring fires a critical alert,
 * and the request paths that need the substrate return 503 at request time — we
 * just never take the public site down with the probe.
 *
 * Default (non-deep) path only: `?deep=1` runs the declared-dependency registry
 * in readyz-probes.ts, where these failures are fatal (503).
 */
async function assertSubstrate(
  check: () => Promise<void>,
  opts: {
    ctx: RequestContext;
    event: string;
    dependency: string;
  }
): Promise<CheckStatus> {
  try {
    const inflight = check();
    const result = await withBudget(inflight, NON_FATAL_CHECK_BUDGET_MS);
    if (result === CHECK_TIMEOUT) {
      logBudgetExceeded(opts.ctx, opts.event, opts.dependency);
      // The probe has already answered, but a hang-type outage must still page:
      // a failure that lands after the budget logs the same critical event.
      inflight.catch((error: unknown) => {
        logSubstrateUnreachable(opts, error);
      });
      return "timeout";
    }
    return "ok";
  } catch (error) {
    // bug.5343: the default probe is NON-FATAL for ANY substrate failure, not
    // just `InfraConnectivityError`. A raw timeout / AbortError from the
    // connectivity check (not wrapped into InfraConnectivityError) must NOT
    // escape to the generic handler and turn into a fatal 503 INTERNAL_ERROR —
    // that is exactly the fleet-draining regression this branch exists to
    // prevent (incident 2026-06-26). Log critical + stay ready regardless of
    // the thrown error's type; `?deep=1` hard-fails via the registry.
    logSubstrateUnreachable(opts, error);
    return "degraded";
  }
}

function logSubstrateUnreachable(
  opts: { ctx: RequestContext; event: string; dependency: string },
  error: unknown
): void {
  const reason =
    error instanceof InfraConnectivityError ? error.code : "INFRA_UNREACHABLE";
  const message = error instanceof Error ? error.message : String(error);
  opts.ctx.log.error(
    {
      event: opts.event,
      severity: "critical",
      reason,
      dependency: opts.dependency,
      message,
    },
    `readiness: ${opts.dependency} unreachable — MISSION-CRITICAL async substrate down (AI/chat is dispatched through Temporal). Returning ready: probe stays non-fatal so the fleet is not drained; the critical alert + request-time 503 cover it.`
  );
}

/**
 * EVM RPC connectivity on the default probe path: cached probe bounded by
 * NON_FATAL_CHECK_BUDGET_MS, degraded (never fatal) on failure or timeout. The
 * deep path's forced live, fatal read lives in readyz-probes.ts.
 */
async function checkEvmRpc(
  ctx: RequestContext,
  container: ReturnType<typeof getContainer>,
  env: ReturnType<typeof serverEnv>
): Promise<CheckStatus> {
  const probe = checkEvmRpcConnectivity(container.evmOnchainClient, env, {
    forceLive: false,
  });
  const evmRpcResult = await withBudget(probe, NON_FATAL_CHECK_BUDGET_MS);
  if (evmRpcResult === CHECK_TIMEOUT) {
    logBudgetExceeded(ctx, "substrate.evm_rpc.unreachable", "evm-rpc");
    return "timeout";
  }
  if (!evmRpcResult.ok) {
    const message = `EVM RPC connectivity check failed: ${evmRpcResult.errorMessage ?? "unknown"}`;
    ctx.log.warn(
      {
        event: "substrate.evm_rpc.unreachable",
        severity: "degraded",
        reason: "INFRA_UNREACHABLE",
        dependency: "evm-rpc",
        source: evmRpcResult.source,
        message,
      },
      "readiness: EVM RPC unreachable, returning ready (non-fatal)"
    );
    return "degraded";
  }
  return evmRpcResult.source === "cached" ? "cached" : "ok";
}

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "meta.readyz", auth: { mode: "none" } },
  async (ctx, request): Promise<NextResponse> => {
    // `?deep=1` restores hard-fail substrate semantics for provisioning /
    // stack-test smoke checks; the default (k8s probe) path is non-fatal.
    const deep = new URL(request.url).searchParams.get("deep") === "1";
    // Set once env parses, so a deep 503 names the revision that answered.
    let buildSha: string | undefined;
    try {
      const env = serverEnv();
      buildSha = env.APP_BUILD_SHA || undefined;
      const container = getContainer();

      // Set build info for metrics (canonical source: APP_BUILD_SHA from serverEnv())
      setBuildInfo(
        process.env.npm_package_version || "unknown",
        env.APP_BUILD_SHA || "unknown"
      );

      // Polymarket egress assertion (story.5050, knowledge `node-choose-placement-region`).
      // Country placement narrows the bid pool; it does NOT prove this pod's outbound
      // identity. The boot probe asked Polymarket directly from inside the lease. If it
      // latched, this lease can never place an order — fail the probe so the operator's
      // boot SLO refuses cutover and re-mints on another provider.
      // ZERO IO: cached latch read only, k8s hits this endpoint constantly.
      const egress = getEgressGeoblockLatch();
      if (egress.latched) {
        ctx.log.error(
          {
            event: "poly.egress.geoblock.latched",
            severity: "critical",
            reason: "EGRESS_GEOBLOCKED",
            dependency: "polymarket-egress",
            egress_ip: egress.egressIp,
            egress_country: egress.egressCountry,
            egress_region: egress.egressRegion,
            latched_at: egress.latchedAt,
          },
          "readiness check failed: Polymarket geoblocks this lease's egress — refusing cutover so the lease is re-minted elsewhere"
        );
        return new NextResponse(
          JSON.stringify({
            status: "error",
            reason: "EGRESS_GEOBLOCKED",
            message:
              "Polymarket geoblocks this pod's outbound path; this lease cannot place orders",
          }),
          {
            status: 503, // Service Unavailable - not ready
            headers: { "content-type": "application/json" },
          }
        );
      }

      // MVP readiness: env + runtime secrets (sync), then substrate checks.
      assertRuntimeSecrets(env);

      // EVM RPC is baseline node substrate, not conditional payment state.
      // Missing config is a deployment error. Transient connectivity remains
      // non-fatal for the default K8s probe so an upstream 429/blip cannot drain
      // the fleet; explicit deep readiness forces a fresh Base RPC read and
      // fails closed for birth/promotion proof.
      assertEvmRpcConfig(env);

      const temporalOpts = {
        ctx,
        event: "substrate.temporal.unreachable",
        dependency: "temporal",
      };
      const schedulerWorkerOpts = {
        ctx,
        event: "substrate.scheduler_worker.unreachable",
        dependency: "scheduler-worker",
      };

      let checks: DeepChecks | undefined;
      if (deep) {
        // Deep probe: concurrent, uncached, hard-fail. Probe exactly the
        // dependencies this node declares; every probed one is in the body's
        // `checks`, every failing one in the 503 body's `unreachable`.
        // Registry: readyz-probes.ts.
        checks = await runDeepChecks(ctx, buildDeepChecks(ctx, container, env));
      } else {
        // Default probe: run everything concurrently. Every check is bounded
        // and degrades (including the system tenant, bug.0022: a shared DB must
        // not hard-gate readiness; provisioning is asserted at boot).
        const timings: CheckTimings = {};
        const startedAt = Date.now();
        const results = await Promise.allSettled([
          timed(timings, "evmRpc", () =>
            checkEvmRpc(ctx, container, env)
          ),
          timed(timings, "temporal", () =>
            assertSubstrate(
              () => assertTemporalConnectivity(container.scheduleControl, env),
              temporalOpts
            )
          ),
          timed(timings, "schedulerWorker", () =>
            assertSubstrate(
              () => assertSchedulerWorkerConnectivity(env),
              schedulerWorkerOpts
            )
          ),
          timed(timings, "systemTenant", () =>
            checkSystemTenantNonFatal(ctx, container.serviceAccountService)
          ),
        ]);
        const durationMs = Date.now() - startedAt;
        const unhealthy = Object.values(timings).some(
          (check) => check.status !== "ok" && check.status !== "cached"
        );
        const summary = { checks: timings, durationMs };
        if (unhealthy || durationMs >= SLOW_READINESS_LOG_MS) {
          ctx.log.info(summary, "readiness: checks complete");
        } else {
          ctx.log.debug(summary, "readiness: checks complete");
        }
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected"
        );
        if (failure) throw failure.reason;
      }

      const payload = {
        status: "healthy" as const,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || undefined,
        buildSha,
        ...(checks ? { checks } : {}),
      };

      const parsed = metaReadyzOperation.output.parse(payload);
      return NextResponse.json(parsed);
    } catch (caught) {
      // A deep probe wraps its first failure and names every failing dependency.
      const error =
        caught instanceof DeepProbeFailure ? (caught.primary as Error) : caught;
      const unreachable =
        caught instanceof DeepProbeFailure
          ? { unreachable: caught.unreachable, checks: caught.checks, buildSha }
          : {};
      // HTTP status is primary truth for K8s: 503 = not ready
      // Log failure before returning 503 for deployment debugging
      if (error instanceof EnvValidationError) {
        logReadinessFailure(ctx, error);
        return new NextResponse(
          JSON.stringify({
            status: "error",
            reason: error.meta.code,
            details: error.meta,
            ...unreachable,
          }),
          {
            status: 503, // Service Unavailable - not ready
            headers: { "content-type": "application/json" },
          }
        );
      }

      // Runtime secret validation failures (typed error from assertRuntimeSecrets)
      if (error instanceof RuntimeSecretError) {
        logReadinessFailure(ctx, error);
        return new NextResponse(
          JSON.stringify({
            status: "error",
            reason: error.code,
            message: error.message,
            ...unreachable,
          }),
          {
            status: 503, // Service Unavailable - not ready
            headers: { "content-type": "application/json" },
          }
        );
      }

      // Infrastructure connectivity failures (Temporal, etc.)
      if (error instanceof InfraConnectivityError) {
        logReadinessFailure(ctx, error);
        return new NextResponse(
          JSON.stringify({
            status: "error",
            reason: error.code,
            message: error.message,
            ...unreachable,
          }),
          {
            status: 503, // Service Unavailable - not ready
            headers: { "content-type": "application/json" },
          }
        );
      }

      // Unknown error - log and return generic 503
      logReadinessFailure(ctx, error as Error);
      return new NextResponse(
        JSON.stringify({
          status: "error",
          reason: "INTERNAL_ERROR",
          ...unreachable,
        }),
        {
          status: 503, // Service Unavailable - not ready
          headers: { "content-type": "application/json" },
        }
      );
    }
  }
);

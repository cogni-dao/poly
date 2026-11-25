// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/http/wrapRouteHandlerWithLogging`
 * Purpose: Route wrapper to eliminate boilerplate for request logging envelope and metrics.
 * Scope: Bootstrap-layer utility. Handles ctx creation, timing, envelope logging, and Prometheus metrics. Does not implement route-specific business logic.
 * Invariants: Always logs request start/end exactly once; always measures duration; catches unhandled errors; always records metrics (even on 5xx).
 *   The session is resolved inside the request lifecycle, so a credential-store outage (503), a rate-limited key (429) and a superseded signed key (401)
 *   are logged, measured and traced like any other response.
 * Side-effects: IO (creates request context, emits structured log entries, records Prometheus metrics). Container loaded via dynamic import to avoid Turbopack per-route module duplication.
 * Notes: Use this wrapper for all instrumented routes. Domain events go in facades/features, not here.
 *        logRequestEnd runs exactly once in the finally block for all paths (success, 401, 5xx).
 *        For unhandled errors: logs error, then rethrows in dev/test (APP_ENV != production) for diagnosis.
 *        In production, converts to 500 for safety.
 *        Metrics are recorded in a finally block to ensure all paths are captured.
 * Links: Used by route handlers; delegates to shared/observability helpers; records to shared/observability/server/metrics.
 * @public
 */

import { bearerWriteRefusal } from "@cogni/agent-grants";
import {
  CredentialRateLimitedError,
  CredentialStoreUnavailableError,
  credentialDenialHttp,
  credentialErrorHttp,
  isRevocableKey,
  storeFailureFields,
  V1SupersededError,
} from "@cogni/agent-grants/credentials";
import type { SessionUser } from "@cogni/node-shared";
import { type NextRequest, NextResponse } from "next/server";
import type { Container } from "@/bootstrap/container";
import { ServiceAuthUnavailableError } from "@/bootstrap/service-auth-error";
import { withRootSpan } from "@/bootstrap/otel";
import {
  createRequestContext,
  EVENT_NAMES,
  httpRequestDurationMs,
  httpRequestsTotal,
  logRequestEnd,
  logRequestError,
  logRequestStart,
  makeLogger,
  type RequestContext,
  statusBucket,
} from "@/shared/observability";

/** One log line for a credential outcome that answers before the handler. Fields: routeId, plus userId (v1_superseded) or errorClass and sqlState (outage). Never a key, a hash or a message. */
function logCredentialRefusal(log: RequestContext["log"], error: unknown, routeId: string): void {
  if (error instanceof V1SupersededError) {
    // A signed key used after its user confirmed a revocable key: the best "leaked signed key is being replayed" signal. userId only.
    log.warn({ event: EVENT_NAMES.AGENT_CREDENTIAL_V1_SUPERSEDED_DENIED, routeId, userId: error.userId }, EVENT_NAMES.AGENT_CREDENTIAL_V1_SUPERSEDED_DENIED);
  } else if (error instanceof CredentialRateLimitedError) {
    log.warn({ event: EVENT_NAMES.AGENT_CREDENTIAL_RATE_LIMITED, routeId }, EVENT_NAMES.AGENT_CREDENTIAL_RATE_LIMITED);
  } else if (error instanceof CredentialStoreUnavailableError) {
    log.warn({ event: EVENT_NAMES.AGENT_CREDENTIAL_STORE_UNAVAILABLE, routeId, ...storeFailureFields(error) }, EVENT_NAMES.AGENT_CREDENTIAL_STORE_UNAVAILABLE);
  }
}

/**
 * DENY_BY_DEFAULT is wired but not yet enforced on this node: Poly's own bearer-reachable write routes (every `/api/v1/*` route accepts a bearer) have not been
 * audited for a declared door, and cookie-only routes (`getServerSessionUser`) do not mark `via: "session"`. Turning this on before both are done would answer
 * every undeclared write 403. The declared doors below (`sameDoor`, account doors) already run where a route declares them.
 */
const ENFORCE_BEARER_WRITE_DECLARATIONS = false;

type AuthRequiredHandler<TContext = unknown> = (
  ctx: RequestContext,
  request: NextRequest,
  sessionUser: SessionUser,
  context?: TContext
) => Promise<NextResponse>;

type AuthOptionalHandler<TContext = unknown> = (
  ctx: RequestContext,
  request: NextRequest,
  sessionUser: SessionUser | null,
  context?: TContext
) => Promise<NextResponse>;

type AuthRequiredOptions = {
  routeId: string;
  /**
   * SAME_DOOR: this route twins a guarded tool. Before the handler runs, the caller passes the same `authorize()` check as
   * the tool guard: a bearer caller needs a live role row for the tool's scope (403 `policy_denied`, 503 `authz_unavailable`);
   * a signed-in human passes the subject rules. Declared once in `SAME_DOOR_ROUTES` (`@cogni/agent-grants`).
   */
  sameDoor?: string;
  /**
   * DENY_BY_DEFAULT (bug.0045): the reason a bearer agent may write here with no grant. Only a route that touches nothing but the caller's own data
   * (its own chat turn, its own threads, its own credential), or whose service runs the one admin check on the caller itself (knowledge merge and close), declares one. A write route that declares none of `sameDoor`, `bearerWrite` or an
   * `OPEN_BY_DESIGN_ROUTES` entry answers a bearer 403 `bearer_write_undeclared`; a human session is never affected.
   */
  bearerWrite?: string;
  /**
   * An ACCOUNT door (task.5465): the name of the route param that carries the account id (`accountId`). The same-door check then decides this
   * account: the owner by session, or a bearer agent with a live grant for exactly this account. Every deny except an outage is ONE 404
   * (`not_found`), so a foreign, expired, revoked and missing account cannot be told apart (ACCOUNT_404_NON_DISCLOSING).
   */
  sameDoorAccountParam?: string;
  /**
   * An OPTIONAL account door for a route that reads the caller's own account by default (task.5465): the name of a QUERY parameter that may carry another
   * account id. With the parameter present the same account door runs (the owner by session, or a bearer agent with a live `account:read` grant for exactly that
   * account; every other answer is the one 404). Absent, the route reads the caller's own account as before and no door runs.
   */
  sameDoorAccountQuery?: string;
  auth: {
    mode: "required";
    getSessionUser: () => Promise<SessionUser | null>;
  };
};

type AuthOptionalOptions = {
  routeId: string;
  auth: {
    mode: "optional";
    getSessionUser: () => Promise<SessionUser | null>;
  };
};

type AuthNoneOptions = {
  routeId: string;
  auth?: { mode: "none" };
};

type WrapOptions = AuthRequiredOptions | AuthOptionalOptions | AuthNoneOptions;

/**
 * Wraps a route handler with consistent request logging envelope.
 * Handles ctx creation, session check, timing, logRequestStart/End/Error automatically.
 *
 * @param options - Configuration for route logging
 * @param options.routeId - Route identifier for logging (e.g., "payments.intents")
 * @param options.auth - Session authentication config: { mode: "required"|"optional"|"none", getSessionUser }
 * @param handler - Route handler that receives (ctx, request, sessionUser, context?)
 * @returns Next.js route handler function (supports both static and dynamic routes)
 *
 * @example
 * // Static route with required session — sessionUser is guaranteed non-null
 * export const POST = wrapRouteHandlerWithLogging(
 *   { routeId: "payments.intents", auth: { mode: "required", getSessionUser } },
 *   async (ctx, request, sessionUser) => {
 *     const body = await request.json();
 *     const input = paymentIntentOperation.input.parse(body);
 *     const result = await createPaymentIntentFacade({ sessionUser, ...input }, ctx);
 *     return NextResponse.json(paymentIntentOperation.output.parse(result));
 *   }
 * );
 *
 * @example
 * // Dynamic route (Next.js 15 with async params and typed context)
 * export const GET = wrapRouteHandlerWithLogging<{ params: Promise<{ id: string }> }>(
 *   { routeId: "payments.attempt_status", auth: { mode: "required", getSessionUser } },
 *   async (ctx, request, sessionUser, context) => {
 *     if (!context) throw new Error("context required for dynamic routes");
 *     const { id } = await context.params;
 *     const result = await getPaymentStatusFacade({ sessionUser, attemptId: id }, ctx);
 *     return NextResponse.json(paymentStatusOperation.output.parse(result));
 *   }
 * );
 */
// Overload: mode "required" → handler receives SessionUser (non-null)
export function wrapRouteHandlerWithLogging<TContext = unknown>(
  options: AuthRequiredOptions,
  handler: AuthRequiredHandler<TContext>
): (request: NextRequest, context?: TContext) => Promise<NextResponse>;
// Overload: mode "optional" or "none" → handler receives SessionUser | null
export function wrapRouteHandlerWithLogging<TContext = unknown>(
  options: AuthOptionalOptions | AuthNoneOptions,
  handler: AuthOptionalHandler<TContext>
): (request: NextRequest, context?: TContext) => Promise<NextResponse>;
// Implementation
export function wrapRouteHandlerWithLogging<TContext = unknown>(
  options: WrapOptions,
  handler: AuthRequiredHandler<TContext> | AuthOptionalHandler<TContext>
): (request: NextRequest, context?: TContext) => Promise<NextResponse> {
  return async (
    request: NextRequest,
    context?: TContext
  ): Promise<NextResponse> => {
    // Dynamic import: breaks Turbopack's per-route static module graph tracing
    // of the entire DI composition root (spike.0203 — was causing 6GB RSS in dev).
    let container: Container;
    let unhandledErrorPolicy: "rethrow" | "respond_500";

    try {
      const mod = await import("@/bootstrap/container");
      container = mod.getContainer();
      unhandledErrorPolicy = container.config.unhandledErrorPolicy;
    } catch (bootError) {
      // Container init failed (env validation, missing secrets, etc.)
      // Return structured 503 so /readyz never returns an empty 500.
      const fallbackLog = makeLogger({ component: "wrapRouteHandler" });
      fallbackLog.error(
        {
          errorCode: "CONTAINER_INIT_FAILED",
          err:
            bootError instanceof Error ? bootError.message : String(bootError),
        },
        "container initialization failed — returning 503"
      );
      return new NextResponse(
        JSON.stringify({
          status: "error",
          reason: "CONTAINER_INIT_FAILED",
          message:
            bootError instanceof Error
              ? bootError.message
              : "Unknown container initialization error",
        }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        }
      );
    }

    // Wrap entire request in OTel root span for distributed tracing
    // Per AI_SETUP_SPEC.md: root span bound to context via context.with()
    return withRootSpan(
      `${request.method} ${options.routeId}`,
      { route_id: options.routeId },
      async ({ traceId, span }) => {
        const start = performance.now();

        // Resolve the session INSIDE the span, so a credential outcome (401 v1_superseded, 429, 503) is logged, measured and traced like every
        // other response. The error is held here and answered in the try below, where `finally` logs the request end and records the metric
        // exactly once. A revocable key whose store cannot answer is 503, never a false 401 (STORE_OUTAGE_IS_NOT_401). The context is built once,
        // after this, with the session, exactly as before (no logger `.child` is assumed beyond what `createRequestContext` already uses).
        let sessionUser: SessionUser | null = null;
        let sessionError: unknown;
        if (options.auth && options.auth.mode !== "none") {
          try {
            sessionUser = await options.auth.getSessionUser();
          } catch (error) {
            sessionError = error;
          }
        }

        const ctx = createRequestContext(
          { baseLog: container.log, clock: container.clock },
          request,
          {
            routeId: options.routeId,
            traceId,
            session: sessionUser ?? undefined,
          }
        );

        // Per AI_SETUP_SPEC.md: request_id must be on root span for trace-log correlation
        span.setAttribute("request_id", ctx.reqId);

        logRequestStart(ctx.log);

        // Track response for metrics/logging (captured in try/catch, used in finally)
        let responseStatus = 500;
        let response: NextResponse;

        try {
          if (sessionError !== undefined) {
            // An unreachable home key set is 503, never 401 (the caller did nothing wrong).
            const refusal =
              sessionError instanceof ServiceAuthUnavailableError
                ? credentialDenialHttp("unavailable")
                : credentialErrorHttp(sessionError);
            if (!refusal) throw sessionError;
            logCredentialRefusal(ctx.log, sessionError, options.routeId);
            responseStatus = refusal.status;
            response = NextResponse.json(refusal.body, { status: refusal.status, headers: { ...refusal.headers } });
            return response;
          }

          // Check session requirement before calling handler
          if (options.auth?.mode === "required" && !sessionUser) {
            responseStatus = 401;
            // A refused revocable key (unknown, revoked, expired, wrong state) is a credential denial; logged with routeId only.
            if (isRevocableKey(request.headers.get("authorization")?.slice("Bearer ".length) ?? "")) {
              ctx.log.warn(
                { event: EVENT_NAMES.AGENT_CREDENTIAL_INVALID_DENIED, routeId: options.routeId },
                EVENT_NAMES.AGENT_CREDENTIAL_INVALID_DENIED
              );
            }
            response = NextResponse.json(
              { error: "Session required" },
              { status: responseStatus }
            );
            return response;
          }

          const sameDoor = "sameDoor" in options ? options.sameDoor : undefined;
          const pathAccountParam = "sameDoorAccountParam" in options ? options.sameDoorAccountParam : undefined;
          const queryAccountParam = "sameDoorAccountQuery" in options ? options.sameDoorAccountQuery : undefined;
          const queryAccountId = queryAccountParam ? new URL(request.url).searchParams.get(queryAccountParam) : null;
          // An optional query door runs only when the caller names an account; otherwise the route's own-account read needs no door.
          const accountParam = pathAccountParam ?? (queryAccountId !== null ? queryAccountParam : undefined);
          // The door counts only when it will actually run for this request.
          const doorRuns = Boolean(sameDoor) && (!queryAccountParam || Boolean(pathAccountParam) || queryAccountId !== null);
          // FAIL_CLOSED: any signed-in identity not proven `via: "session"` is a bearer, for the gate and the door alike. Every resolver sets `via`
          // (request-identity.ts for bearers and cookies, getServerSessionUser for cookie-only routes).
          const via = sessionUser?.via === "session" ? "session" : "bearer";
          // DENY_BY_DEFAULT (bug.0045): the decision is `bearerWriteRefusal` in @cogni-dao/agent-grants; the wrapper owns only the response and the log.
          if (
            ENFORCE_BEARER_WRITE_DECLARATIONS &&
            sessionUser !== null &&
            bearerWriteRefusal({
              method: request.method,
              via,
              doorRuns,
              bearerWrite: "bearerWrite" in options ? options.bearerWrite : undefined,
              routeId: options.routeId,
            })
          ) {
            ctx.log.warn(
              {
                event: EVENT_NAMES.AGENT_TOOL_AUTHZ,
                principal: sessionUser.id,
                subject: null,
                payer: null,
                tool: null,
                decision: "deny",
                code: "bearer_write_undeclared",
                reason: "no_declaration",
                runId: null,
                route: options.routeId,
                account: null,
              },
              EVENT_NAMES.AGENT_TOOL_AUTHZ
            );
            responseStatus = 403;
            return NextResponse.json(
              { error: "bearer_write_undeclared", code: "bearer_write_undeclared" },
              { status: responseStatus, headers: { "cache-control": "no-store" } }
            );
          }
          if (doorRuns && sameDoor && sessionUser) {
            let accountId: string | undefined;
            if (queryAccountParam && !pathAccountParam) accountId = queryAccountId ?? "";
            else if (pathAccountParam) {
              const params = (await (context as { params?: Promise<Record<string, string | string[] | undefined>> } | undefined)?.params) ?? {};
              const raw = params[pathAccountParam];
              accountId = typeof raw === "string" ? raw : undefined;
            }
            const decision = await container.agentAuthority.authorizeRoute({
              toolId: sameDoor,
              routeId: options.routeId,
              userId: sessionUser.id,
              via,
              ...(accountParam ? { accountId: accountId ?? "" } : {}),
            });
            if (decision.decision === "deny") {
              const unavailable = decision.code === "authz_unavailable";
              // An account door answers every non-outage deny with the same 404.
              responseStatus = unavailable ? 503 : accountParam ? 404 : 403;
              // ROUTE_DENIAL_IS_ONE_TERMINAL_LINE: every route's door denial ends here with routeId and the decision code
              // (policy_denied | authz_unavailable | ...), never the grant or role (task.0122). The route handler never runs.
              ctx.log.warn(
                {
                  event: EVENT_NAMES.AGENT_ROUTE_DENIED,
                  routeId: options.routeId,
                  outcome: "refused",
                  errorCode: decision.code,
                  tool: sameDoor,
                  status: responseStatus,
                },
                EVENT_NAMES.AGENT_ROUTE_DENIED
              );
              return NextResponse.json(
                accountParam && !unavailable ? { error: "not_found" } : { error: decision.code, code: decision.code },
                { status: responseStatus, headers: { "cache-control": "no-store" } }
              );
            }
          }

          // Safe cast: for mode "required", the guard above returns 401 if null.
          // For mode "optional"/"none", handlers accept null. Either way, this is sound.
          response = await (handler as AuthOptionalHandler<TContext>)(
            ctx,
            request,
            sessionUser,
            context
          );
          responseStatus = response.status;
          return response;
        } catch (error) {
          // Wrapper only catches unhandled errors - route should handle domain errors
          responseStatus = 500;
          logRequestError(ctx.log, error, "INTERNAL_SERVER_ERROR");

          if (unhandledErrorPolicy === "rethrow") {
            throw error;
          }

          // respond_500: convert to 500 for production safety
          response = NextResponse.json(
            { error: "Internal server error" },
            { status: responseStatus }
          );
          return response;
        } finally {
          // Always log request end exactly once and record metrics
          const durationMs = performance.now() - start;

          logRequestEnd(ctx.log, { status: responseStatus, durationMs });

          // Skip metrics recording for scraper endpoint to avoid polluting user traffic metrics
          if (options.routeId !== "meta.metrics") {
            httpRequestsTotal.inc({
              route: options.routeId,
              method: request.method,
              status: statusBucket(responseStatus),
            });
            httpRequestDurationMs.observe(
              { route: options.routeId, method: request.method },
              durationMs
            );
          }
        }
      }
    );
  };
}

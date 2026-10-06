// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/capability-plane/account-read-route`
 * Purpose: The ONE REST transport for account reads. Turns a descriptor plus a
 *   handler into a Next.js GET handler: lift query params, hand them to
 *   `executeAccountRead`, render the outcome. This is the module that replaces
 *   the ~40-line authorize + scope-log + validate block that used to be
 *   duplicated byte-for-byte across the three research routes.
 * Scope: Transport only. Contains no query, no authorization, and no logging of
 *   its own — the executor owns the single terminal event, including for the
 *   query-parse path, so this adapter cannot introduce a second emit site.
 * Invariants:
 *   - TRANSPORT_NEVER_GRANTS_AUTHORITY — it forwards the session principal and
 *     nothing else. The route names its own `resolveDb` (always `resolveAppDb`),
 *     so this module needs no container dependency of its own.
 *   - FAIL_CLOSED_NON_DISCLOSING — denied and not-found render the identical
 *     `{"error":"not_found"}` 404, so an attacker cannot distinguish "wrong
 *     tenant" from "no such account" from "expired grant".
 *   - STATUS_FROM_ONE_TABLE — HTTP statuses come from
 *     `ACCOUNT_READ_HTTP_STATUS`, the same table the terminal event uses.
 * Side-effects: IO, via the executor.
 * Links: task.1791070961, @features/capability-plane
 * @public
 */

import type { Database } from "@cogni/db-client";
import type { AccountReadOperation } from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";
import type { z } from "zod";

import {
  ACCOUNT_READ_HTTP_STATUS,
  type AccountReadHandler,
  type AccountReadStatus,
  executeAccountRead,
} from "@/features/capability-plane";
import type { EventName, RequestContext } from "@/shared/observability";

type SessionLike = { id: string } | null | undefined;

type AccountReadRouteBinding<TOperation extends AccountReadOperation> = {
  handler: AccountReadHandler<
    z.infer<TOperation["input"]>,
    z.infer<TOperation["output"]>
  >;
  extra?: (context: {
    status: AccountReadStatus;
    input: z.infer<TOperation["input"]> | null;
    data: z.infer<TOperation["output"]> | null;
  }) => Record<string, unknown>;
};

type AccountReadRouteConfig<TOperation extends AccountReadOperation> = {
  operation: TOperation;
  /**
   * The app-role handle factory, named by the route so NO_PRIVILEGED_TRANSPORT
   * is visible at every call site. Resolved per request, never at module load.
   * Pass `resolveAppDb`; never `resolveServiceDb` / `resolveServiceReadDb`.
   */
  resolveDb: () => Database;
  eventName: EventName;
  classifyError?: (error: unknown) => "invalid_input" | undefined;
} & (
  | (AccountReadRouteBinding<TOperation> & { createRequestBinding?: never })
  | {
      handler?: never;
      extra?: never;
      /** Build request-local handler instrumentation without mutable module state. */
      createRequestBinding: () => AccountReadRouteBinding<TOperation>;
    }
);

/**
 * Build the GET body for one account read. Wrap the result in
 * `wrapRouteHandlerWithLogging({ auth: { mode: "required" } })` so the session
 * principal is guaranteed before anything here runs.
 */
export function accountReadGetHandler<TOperation extends AccountReadOperation>(
  config: AccountReadRouteConfig<TOperation>
) {
  return async (
    ctx: RequestContext,
    request: Request,
    sessionUser: SessionLike
  ): Promise<NextResponse> => {
    if (!sessionUser) throw new Error("sessionUser required");

    // Every published account read is a GET, so the whole request is its query
    // string. The descriptor's input schema is the only validator — optional
    // params are simply absent rather than coerced to "".
    const rawInput = Object.fromEntries(
      new URL(request.url).searchParams.entries()
    );
    const binding: AccountReadRouteBinding<TOperation> =
      config.createRequestBinding ? config.createRequestBinding() : config;

    const outcome = await executeAccountRead({
      db: config.resolveDb(),
      ctx,
      operation: config.operation,
      principalId: sessionUser.id,
      rawInput,
      eventName: config.eventName,
      handler: binding.handler,
      ...(config.classifyError ? { classifyError: config.classifyError } : {}),
      ...(binding.extra ? { extra: binding.extra } : {}),
    });

    switch (outcome.status) {
      case "ok":
        return NextResponse.json(outcome.data, {
          status: ACCOUNT_READ_HTTP_STATUS.ok,
        });
      case "invalid_input":
        return NextResponse.json(
          {
            error: "invalid_query",
            ...(outcome.message ? { message: outcome.message } : {}),
          },
          { status: ACCOUNT_READ_HTTP_STATUS.invalid_input }
        );
      case "denied":
      case "not_found":
        // One response for both: an authorization denial must be
        // indistinguishable from a genuinely absent snapshot.
        return NextResponse.json(
          { error: "not_found" },
          { status: ACCOUNT_READ_HTTP_STATUS.denied }
        );
      default:
        return NextResponse.json(
          { error: "Internal server error" },
          { status: ACCOUNT_READ_HTTP_STATUS.failed }
        );
    }
  };
}

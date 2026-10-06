// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/capability-plane/execute-account-read`
 * Purpose: The ONE app-local executor for every account read in the capability
 *   plane. Given a pure descriptor, a principal, and a feature handler, it
 *   validates input, opens an app-role tenant transaction, authorizes, runs the
 *   handler, validates output, and emits exactly one terminal feature event.
 *   Transports (REST routes today, the internal agent next) differ only by how
 *   they obtain the principal and how they render the outcome.
 * Scope: Orchestration only. Owns no business query and no HTTP object. The
 *   caller injects the app-role `Database` handle (features must not reach into
 *   `@/bootstrap`), and the handler owns the actual SQL.
 * Invariants:
 *   - DISPATCH_ORDER_IS_THE_CONTRACT — input parse -> tenant transaction ->
 *     read-only isolation -> authorize + access-decision event -> cache ->
 *     handler -> output parse -> ONE terminal event. Nothing may be reordered.
 *   - AUTHORIZE_BEFORE_CACHE — the cache hooks take an `AccountReadAccess` as a
 *     required argument, so they are unreachable until `authorize()` has
 *     returned an allow. Access decisions themselves are never cached.
 *   - NO_PRIVILEGED_TRANSPORT — always `withTenantScope` over the injected
 *     app-role handle. Never `resolveServiceDb` / `resolveServiceReadDb`;
 *     Postgres RLS stays the backstop under every read.
 *   - READ_ONLY_AT_THE_DB — when `operation.readOnly`, the transaction is set
 *     to `REPEATABLE READ READ ONLY` as the first statement after the tenant
 *     context, so a handler physically cannot write and every statement in the
 *     operation sees one consistent snapshot.
 *   - EXACTLY_ONE_TERMINAL_EVENT — this module is the only emitter of the
 *     operation's terminal event, on every path including parse and error
 *     paths. Transport-specific counts arrive through the `extra` callback, so
 *     a transport has no reason to add a second emit site of its own, and a
 *     throwing `extra` is swallowed rather than allowed to suppress the event.
 *   - EXTRA_SEES_ONLY_VALIDATED_DATA — `extra` receives `data` only once it has
 *     passed `operation.output`; on the invalid-output path it receives null.
 *   - FAIL_CLOSED_NON_DISCLOSING — every denial collapses to `"denied"` with no
 *     access kind and no account id in the terminal event.
 *   - NO_FABRICATED_VALUES — a handler returning null is reported as
 *     `"not_found"`; it is never coerced into zeroes or an empty snapshot.
 *   - ACCOUNT_IS_EXPLICIT — the authorized account id is passed to the handler,
 *     which must filter on it. RLS alone is NOT a tenant selector: a delegated
 *     principal can see both the account it owns and every account it holds a
 *     grant on, so an unfiltered handler would merge two accounts into one
 *     response. Decisive for `accountFrom: "principal"` operations and for
 *     `poly_trader_*`, which carries no RLS at all.
 * Side-effects: IO (one Postgres transaction), logging.
 * Links: story.5006, task.1791070961, @features/agent-grants/authorization
 * @public
 */

import { type Database, withTenantScope } from "@cogni/db-client";
import { toUserId, userActor } from "@cogni/ids";
import type { AccountReadOperation } from "@cogni/poly-node-contracts";
import { sql } from "drizzle-orm";
import type { z } from "zod";

import {
  type AccountReadAccess,
  type AgentGrantTransaction,
  authorize,
  resolvePrincipalAccountId,
} from "@/features/agent-grants/authorization";
import {
  EVENT_NAMES,
  type EventName,
  logEvent,
  type RequestContext,
} from "@/shared/observability";

/**
 * A feature handler. Receives ONLY validated input, the already-authorized
 * app-role tenant transaction, and the id of the account that `authorize()`
 * actually allowed. Returns `null` for "no such saved fact", which the executor
 * renders as a non-disclosing not-found — never as zeroes.
 *
 * ACCOUNT_IS_EXPLICIT: the handler MUST filter every query by `accountId` and
 * must never infer the tenant from RLS alone. A delegated principal's RLS
 * legitimately spans BOTH the account it owns AND every account it holds a
 * grant on, so an unfiltered query would merge two accounts into one response.
 * This matters most for `accountFrom: "principal"` operations, where no account
 * id appears on the wire, and it is load-bearing for `poly_trader_*`, which has
 * no RLS at all (the capability is the only tenant clamp there).
 */
export type AccountReadHandler<TInput, TOutput> = (
  tx: AgentGrantTransaction,
  input: TInput,
  accountId: string
) => Promise<TOutput | null>;

/**
 * Optional account-keyed cache. Both hooks require an `AccountReadAccess`,
 * which only exists after `authorize()` allowed the read — AUTHORIZE_BEFORE_CACHE
 * is therefore a type-level guarantee rather than a review convention.
 */
export type AccountReadCache<TInput, TOutput> = {
  lookup: (input: TInput, access: AccountReadAccess) => Promise<TOutput | null>;
  store?: (
    input: TInput,
    access: AccountReadAccess,
    data: TOutput
  ) => Promise<void>;
};

export type AccountReadStatus =
  | "ok"
  | "denied"
  | "not_found"
  | "invalid_input"
  | "invalid_output"
  | "failed";

/**
 * HTTP status per outcome. Lives beside the single terminal-event emitter so
 * the status a transport returns and the status the event records cannot drift.
 */
export const ACCOUNT_READ_HTTP_STATUS: Record<AccountReadStatus, number> = {
  ok: 200,
  denied: 404,
  not_found: 404,
  invalid_input: 400,
  invalid_output: 500,
  failed: 500,
};

/** Terminal-event `errorCode` per non-success outcome. */
export const ACCOUNT_READ_ERROR_CODES: Record<
  Exclude<AccountReadStatus, "ok">,
  string
> = {
  denied: "not_found",
  not_found: "not_found",
  invalid_input: "invalid_query",
  invalid_output: "response_validation_failed",
  failed: "service_failed",
};

export type AccountReadOutcome<TOutput> =
  | { status: "ok"; data: TOutput; access: AccountReadAccess }
  | { status: "denied" }
  | { status: "not_found"; access: AccountReadAccess }
  | { status: "invalid_input"; message?: string }
  | { status: "invalid_output" }
  | { status: "failed" };

type InputOf<TOperation extends AccountReadOperation> = z.infer<
  TOperation["input"]
>;
type OutputOf<TOperation extends AccountReadOperation> = z.infer<
  TOperation["output"]
>;

export type ExecuteAccountReadArgs<TOperation extends AccountReadOperation> = {
  /** App-role database handle, injected by the transport. Never service-role. */
  db: Database;
  /** Request-scoped logger + correlation ids. */
  ctx: RequestContext;
  /** The pure descriptor that defines this capability. */
  operation: TOperation;
  /**
   * The authenticated principal. Authority travels with the principal, never
   * with the transport.
   */
  principalId: string;
  /** Unvalidated request input; parsed here against `operation.input`. */
  rawInput: unknown;
  /** Terminal feature event for this operation. */
  eventName: EventName;
  /** The feature handler bound to this operation. */
  handler: AccountReadHandler<InputOf<TOperation>, OutputOf<TOperation>>;
  /** Optional account-keyed cache; unreachable before an allow. */
  cache?: AccountReadCache<InputOf<TOperation>, OutputOf<TOperation>>;
  /**
   * Classifies a thrown error as a caller input problem (e.g. an unparseable
   * evidence cursor). Anything unclassified is an internal failure.
   */
  classifyError?: (error: unknown) => "invalid_input" | undefined;
  /** Transport-specific terminal-event fields (counts, kinds, flags). */
  extra?: (context: {
    status: AccountReadStatus;
    input: InputOf<TOperation> | null;
    data: OutputOf<TOperation> | null;
  }) => Record<string, unknown>;
};

export async function executeAccountRead<
  TOperation extends AccountReadOperation,
>(
  args: ExecuteAccountReadArgs<TOperation>
): Promise<AccountReadOutcome<OutputOf<TOperation>>> {
  type TInput = InputOf<TOperation>;
  type TOutput = OutputOf<TOperation>;

  const startedAt = performance.now();
  // Mutable holder: the transaction callback records the decision so the single
  // terminal emitter below can describe it without a second log site.
  const state: {
    access: AccountReadAccess | null;
    input: TInput | null;
    data: TOutput | null;
  } = { access: null, input: null, data: null };

  // A transport's count builder must never be able to suppress the one terminal
  // event: if `extra` throws, the event still goes out, minus the extras.
  const extraFields = (status: AccountReadStatus): Record<string, unknown> => {
    try {
      return args.extra?.({ status, input: state.input, data: state.data }) ?? {};
    } catch {
      return { extraFieldsFailed: true };
    }
  };

  const emit = (status: AccountReadStatus): void => {
    logEvent(args.ctx.log, args.eventName, {
      // Transport extras come FIRST so they can never clobber an envelope
      // field — a route cannot rewrite `status` or `authorizationOutcome`.
      ...extraFields(status),
      reqId: args.ctx.reqId,
      routeId: args.ctx.routeId,
      operationId: args.operation.id,
      status: ACCOUNT_READ_HTTP_STATUS[status],
      durationMs: Math.round(performance.now() - startedAt),
      outcome: status === "ok" ? "success" : "error",
      authorizationOutcome:
        status === "denied"
          ? "denied"
          : state.access
            ? "allowed"
            : "not_evaluated",
      // Non-disclosing: no accessKind on a denial, never an account id.
      ...(state.access ? { accessKind: state.access.accessKind } : {}),
      ...(status === "ok"
        ? {}
        : { errorCode: ACCOUNT_READ_ERROR_CODES[status] }),
    });
  };

  // 1. Input is validated before anything else — an unparseable request never
  //    reaches the database or the authorization seam.
  const parsedInput = args.operation.input.safeParse(args.rawInput);
  if (!parsedInput.success) {
    emit("invalid_input");
    return { status: "invalid_input", message: parsedInput.error.message };
  }
  const input = parsedInput.data as TInput;
  state.input = input;

  let handled: { data: TOutput | null } | null = null;
  try {
    // 2. One app-role tenant transaction. RLS is the backstop for every read
    //    inside it, including the authorization lookup itself.
    handled = await withTenantScope(
      args.db,
      userActor(toUserId(args.principalId)),
      async (tx) => {
        // 3. Read-only + snapshot isolation, immediately after the tenant
        //    context `SET LOCAL` and before any query. Postgres rejects
        //    `SET TRANSACTION` once a query has run, so this must stay first.
        if (args.operation.readOnly) {
          await tx.execute(
            sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
          );
        }

        const accountId =
          args.operation.accountFrom === "principal"
            ? await resolvePrincipalAccountId(tx, args.principalId)
            : accountIdFromInput(input);

        // 4. The single authorization decision, then its audit event. Emitted
        //    for allows and denials alike so every decision reaches Loki.
        const access = accountId
          ? await authorize(tx, {
              principalId: args.principalId,
              accountId,
              requiredScope: args.operation.requiredScope,
            })
          : null;
        state.access = access;

        logEvent(args.ctx.log, EVENT_NAMES.POLY_AGENT_GRANT_ACCESS_DECISION, {
          reqId: args.ctx.reqId,
          routeId: args.ctx.routeId,
          operationId: args.operation.id,
          outcome: access ? "allow" : "deny",
          requiredScope: args.operation.requiredScope,
          principalId: args.principalId,
          ...(accountId ? { billingAccountId: accountId } : {}),
          ...(access
            ? {
                accessKind: access.accessKind,
                ...(access.grantId ? { grantId: access.grantId } : {}),
              }
            : {}),
        });

        // `accountId` is non-null whenever `access` is, since authorize() is
        // only reached with one; narrowing both here keeps the handler's
        // `accountId` a plain string with no cast.
        if (!access || !accountId) return null;

        // 5. ONLY NOW may an account-keyed cache be consulted.
        const cached = await args.cache?.lookup(input, access);
        if (cached != null) return { data: cached };

        // 6. The handler sees validated input, this authorized tx, and the
        //    account authorize() allowed — per ACCOUNT_IS_EXPLICIT it must
        //    filter on that id rather than trusting RLS to scope the tenant.
        const result = await args.handler(tx, input, accountId);
        if (result != null) {
          await args.cache?.store?.(input, access, result);
        }
        return { data: result };
      }
    );
  } catch (error) {
    if (args.classifyError?.(error) === "invalid_input") {
      emit("invalid_input");
      return { status: "invalid_input" };
    }
    emit("failed");
    return { status: "failed" };
  }

  const access = state.access;
  if (!handled || !access) {
    // Denial. `state.access` is null, so the terminal event discloses nothing.
    emit("denied");
    return { status: "denied" };
  }

  if (handled.data == null) {
    emit("not_found");
    return { status: "not_found", access };
  }

  // 7. Output is validated against the descriptor before it leaves the node.
  const parsedOutput = args.operation.output.safeParse(handled.data);
  if (!parsedOutput.success) {
    // `state.data` deliberately stays null. The handler returned something that
    // does NOT satisfy the descriptor, so it is not an `OutputOf<TOperation>`
    // and must not be handed to `extra`, which is typed for the validated
    // shape and would read fields that are not there.
    emit("invalid_output");
    return { status: "invalid_output" };
  }

  const data = parsedOutput.data as TOutput;
  state.data = data;
  emit("ok");
  return { status: "ok", data, access };
}

function accountIdFromInput(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const candidate = (input as { billing_account_id?: unknown })
    .billing_account_id;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

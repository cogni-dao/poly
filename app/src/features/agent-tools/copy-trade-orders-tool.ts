// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/agent-tools/copy-trade-orders-tool`
 * Purpose: The INTERNAL-AGENT transport for one account-read capability —
 *   `poly.copy-trade.orders.v1`. This is the third principal of the capability
 *   plane: a LangGraph tool the in-process `poly-brain` agent calls, answered
 *   with the SIGNED-IN USER's principal and therefore with the same saved facts
 *   the dashboard and an approved external agent get. The sibling transport is
 *   `@app/_lib/capability-plane/account-read-route` (REST).
 * Scope: Transport only — lift input, call the executor, render the outcome for
 *   a language model. Contains ZERO queries, ZERO authorization, no container
 *   access, and no Postgres handle of its own: the caller injects the app-role
 *   `Database` (bootstrap owns injection; features must not reach into
 *   `@/bootstrap`). Every decision belongs to `executeAccountRead`.
 *
 *   The tool CONTRACT is deliberately NOT here. It lives in
 *   `@cogni/poly-graphs/tools` because `ToolContract` is typed against zod **v3**
 *   while `app` and `@cogni/poly-node-contracts` resolve zod **v4** — and a v4
 *   schema does not merely fail to typecheck, it compiles to an EMPTY JSON
 *   Schema through `toToolSpec` (`zod-to-json-schema` v3 reads `_def.typeName`,
 *   which v4 does not have), handing the model a tool with no arguments.
 *   Observed in CI, not theorised. This module is the v4 side of that boundary:
 *   it talks to the capability plane; the contract talks to the LLM runtime.
 * Invariants:
 *   - PRINCIPAL_NEVER_IN_ARGS — the tool takes no `billing_account_id` and no
 *     principal field of any kind; the account is resolved from the principal by
 *     the seam (`accountFrom: "principal"` → `resolveSubjectAccountId`). A tool
 *     that asks the MODEL for an account id is the incident that opened
 *     story.5006. The principal reaches this module by being closed over at
 *     construction (`@bootstrap/ai/principal-tool-source`), which is the only
 *     available channel: `ToolInvocationContext` forbids credential-shaped
 *     fields and `ToolImplementation.execute` takes no ctx at all.
 *   - NO_PRIVILEGED_TRANSPORT — no back door. Same executor, same app-role
 *     tenant transaction, so Postgres RLS is the same backstop as for REST.
 *   - ONE_TERMINAL_EVENT — emitted solely by `executeAccountRead`, under the
 *     SAME event name and `operationId` the dashboard route uses. Only `routeId`
 *     differs, so human-vs-agent parity is a one-stream Loki comparison.
 *   - FAIL_CLOSED_NON_DISCLOSING — `denied` and `not_found` collapse to ONE
 *     indistinguishable reason code with one message.
 *   - NO_FABRICATED_VALUES — every non-ok outcome omits `orders` and
 *     `order_count` entirely, so there is no zero for a model to misread, and
 *     the message instructs it not to invent one.
 *   - ROWS_PASS_THROUGH_UNCHANGED — the capability's rows are forwarded exactly
 *     as the executor validated them. No reshaping, no summarising; "identical
 *     saved facts" is literal.
 *   - AMBIGUITY_IS_A_MESSAGE_NOT_A_CRASH — more than one reachable account is
 *     `invalid_input` at the seam, not a denial, and is surfaced as actionable
 *     prose because this capability's frozen input schema CANNOT carry an
 *     account id and so cannot be aimed.
 *   - NEVER_THROW — a throwing tool becomes an opaque `execution` error to the
 *     model, which is exactly when models start guessing.
 * Side-effects: IO, entirely via `executeAccountRead` (one Postgres transaction).
 * Links: task.1791070967, story.5006, docs/spec/capability-plane.md
 * @public
 */

import type { Database } from "@cogni/db-client";
import type {
  PolyAccountCopyTradeOrdersToolOutput,
  PolyAccountReadUnavailableReason,
} from "@cogni/poly-graphs";
import {
  polyAccountReadCopyTradeOrdersOperation,
  type PolyCopyTradeOrdersOutput,
} from "@cogni/poly-node-contracts";

import {
  type AccountReadOutcome,
  ACCOUNT_READ_TERMINAL_EVENTS,
  copyTradeOrdersAccountReadHandler,
  copyTradeOrdersExtra,
  executeAccountRead,
} from "@/features/capability-plane";
import type { RequestContext } from "@/shared/observability";

/**
 * The messages the model sees. Written as instructions rather than status text,
 * because the failure mode being prevented is not a bad answer — it is a
 * CONFIDENT one. NO_FABRICATED_VALUES is enforced by the returned shape; this is
 * the belt to that braces.
 */
const UNAVAILABLE_MESSAGES: Record<PolyAccountReadUnavailableReason, string> = {
  // ONE message for denial AND absence. Do not split these: the difference is
  // exactly what FAIL_CLOSED_NON_DISCLOSING withholds.
  no_readable_account:
    "No copy-trade order ledger is readable for the signed-in user. There may be no saved mirror activity, or the account may not be readable with the current access. Tell the user that plainly. Do NOT state or estimate any order count, size, or price.",
  account_ambiguous:
    "The signed-in user can read more than one billing account, and this capability cannot be aimed at a specific one — its response contract carries no account identifier. Ask the user which account they mean and stop. Do NOT pick one, and do NOT report orders from any account.",
  read_failed:
    "The order-ledger read failed. This is a system fault, not a statement about the user's data. Say the read failed and offer to retry. Do NOT report any orders.",
};

/**
 * What the transport needs injected. Note what is NOT here: no container, no
 * service-role handle, no account id, and no bearer token.
 */
export type PolyAccountCopyTradeOrdersToolDeps = {
  /**
   * App-role handle. NEVER `resolveServiceDb` / `resolveServiceReadDb` — see
   * NO_PRIVILEGED_TRANSPORT. The executor opens its tenant transaction on this.
   */
  readonly db: Database;
  /**
   * The authenticated principal. For this transport that is the SIGNED-IN
   * USER's id, threaded from the graph run's `actorUserId` — the internal agent
   * borrows the user's authority rather than holding any of its own.
   */
  readonly principalId: string;
  /** Request-scoped logger + correlation ids for the terminal event. */
  readonly ctx: RequestContext;
};

/**
 * Invoke the capability and render the outcome for a language model.
 *
 * Structurally identical to `accountReadGetHandler`'s body: lift input, call
 * `executeAccountRead`, render. The ONLY differences are where the principal
 * comes from (a closure instead of a session cookie) and what an outcome is
 * rendered as (a typed envelope instead of an HTTP status). That is the whole
 * point of story.5006 — the actors are interchangeable clients of one
 * capability, not two implementations of one feature.
 */
export async function runPolyAccountCopyTradeOrdersTool(
  deps: PolyAccountCopyTradeOrdersToolDeps,
  rawInput: unknown
): Promise<PolyAccountCopyTradeOrdersToolOutput> {
  const operation = polyAccountReadCopyTradeOrdersOperation;

  let outcome: AccountReadOutcome<PolyCopyTradeOrdersOutput>;
  try {
    outcome = await executeAccountRead({
      db: deps.db,
      ctx: deps.ctx,
      operation,
      principalId: deps.principalId,
      rawInput,
      // The SAME terminal event the dashboard route emits, keyed off the SAME
      // descriptor id. Parity is then one Loki stream split by `routeId`.
      eventName: ACCOUNT_READ_TERMINAL_EVENTS[operation.id],
      handler: copyTradeOrdersAccountReadHandler,
      extra: copyTradeOrdersExtra,
    });
  } catch {
    // The executor already converts handler faults into `failed` outcomes, so
    // reaching here means the injection itself failed (e.g. no DB handle).
    // Still a typed unavailable, never a throw.
    return unavailable("read_failed");
  }

  switch (outcome.status) {
    case "ok":
      // ROWS_PASS_THROUGH_UNCHANGED.
      return {
        status: "ok",
        orders: outcome.data.orders,
        order_count: outcome.data.orders.length,
      };

    case "invalid_input":
      // `validateInput` in the bound runtime has ALREADY parsed `rawInput`
      // against an equivalent schema before `exec` was reached, so a schema
      // rejection here is unreachable in practice and the remaining
      // `invalid_input` producer in the executor is the ambiguous-subject path
      // (`resolveSubjectAccountId` → `kind: "ambiguous"`).
      //
      // The executor's own message says "specify billing_account_id". That is
      // correct advice for an `accountFrom: "input"` capability and WRONG here:
      // this capability's frozen contract has no such field, so it is NOT
      // forwarded. The model is told to ask the human instead.
      return unavailable("account_ambiguous");

    case "denied":
    case "not_found":
      // One branch, one code, one message. See FAIL_CLOSED_NON_DISCLOSING.
      return unavailable("no_readable_account");

    default:
      return unavailable("read_failed");
  }
}

function unavailable(
  reason: PolyAccountReadUnavailableReason
): PolyAccountCopyTradeOrdersToolOutput {
  // No `orders`, no `order_count`. NO_FABRICATED_VALUES is a property of the
  // returned shape, not of the prose.
  return {
    status: "unavailable",
    reason,
    message: UNAVAILABLE_MESSAGES[reason],
  };
}

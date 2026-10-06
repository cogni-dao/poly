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
 * Scope: Transport + tool contract only. Contains ZERO queries, ZERO
 *   authorization, no container access, and no Postgres handle of its own — the
 *   caller injects the app-role `Database` (bootstrap owns injection, features
 *   must not reach into `@/bootstrap`). All decisions belong to
 *   `executeAccountRead`.
 * Invariants:
 *   - PRINCIPAL_NEVER_IN_ARGS — the tool schema has NO `billing_account_id` and
 *     no principal field of any kind. The account is resolved from the
 *     principal by the seam (`accountFrom: "principal"` →
 *     `resolveSubjectAccountId`). A tool that asks the MODEL for an account id
 *     is the incident that started story.5006: an agent stalled demanding a
 *     UUID from the human. The principal reaches this module by being closed
 *     over at construction (see `@bootstrap/ai/principal-tool-source`), which is
 *     the only available channel — `ToolInvocationContext` forbids
 *     credential-shaped fields and `ToolImplementation.execute` takes no ctx at
 *     all.
 *   - CAPABILITY_DEFINED_ONCE — the tool's `inputSchema` IS the descriptor's
 *     `input`, by reference, not a re-declaration. Adding a field to the
 *     capability changes the tool's wire schema with no edit here.
 *   - NO_PRIVILEGED_TRANSPORT — this transport gets no back door. It calls the
 *     same executor, which opens the same app-role tenant transaction, so
 *     Postgres RLS is the same backstop it is for the REST route.
 *   - ONE_TERMINAL_EVENT — emitted solely by `executeAccountRead`, under the
 *     SAME event name and the SAME `operationId` the dashboard route uses. Only
 *     `routeId` differs, so Loki parity between the two principals is a
 *     one-stream comparison rather than a cross-stream join.
 *   - FAIL_CLOSED_NON_DISCLOSING — `denied` and `not_found` collapse to ONE
 *     indistinguishable reason code with one message. The model cannot learn
 *     "exists but forbidden" from "absent", and neither can a user driving it.
 *   - NO_FABRICATED_VALUES — every non-ok outcome returns a typed `unavailable`
 *     with NO `orders` and NO `order_count`. The absent-data branch carries no
 *     number at all, so there is nothing for a model to read as a zero, and the
 *     message instructs it not to invent one. This is the invariant that exists
 *     because an agent fabricated a wallet balance in production.
 *   - AMBIGUITY_IS_A_MESSAGE_NOT_A_CRASH — more than one reachable account is
 *     `invalid_input` at the seam, not a denial. It is surfaced as actionable
 *     prose telling the model to ask the human, because this capability's frozen
 *     input schema CANNOT carry an account id and so cannot be aimed.
 *   - FLAT_OUTPUT_NO_UNIONS — `ToolSpec.inputSchema`/output must avoid
 *     `oneOf`/`anyOf`, so the result envelope is one flat object with optional
 *     members rather than a `z.discriminatedUnion`.
 * Side-effects: IO, entirely via `executeAccountRead` (one Postgres transaction).
 * Links: task.1791070967, story.5006, docs/spec/capability-plane.md
 * @public
 */

import type { BoundTool, ToolContract } from "@cogni/ai-tools";
import type { Database } from "@cogni/db-client";
import {
  polyAccountReadCopyTradeOrdersOperation,
  polyCopyTradeOrdersOperation,
  type PolyCopyTradeOrdersInput,
  type PolyCopyTradeOrdersOutput,
} from "@cogni/poly-node-contracts";
import { z } from "zod";

import {
  ACCOUNT_READ_TERMINAL_EVENTS,
  type AccountReadOutcome,
  copyTradeOrdersAccountReadHandler,
  copyTradeOrdersExtra,
  executeAccountRead,
} from "@/features/capability-plane";
import type { RequestContext } from "@/shared/observability";

// ─────────────────────────────────────────────────────────────────────────────
// Tool identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Namespaced tool id, per TOOL_ID_NAMESPACED (`core__<name>`, double
 * underscore for provider compatibility). The `poly_account_` prefix marks it
 * as a capability-plane account read rather than a public-upstream lookup like
 * `core__poly_data_positions` — SAVED_FACTS_ONLY: this reads what THIS node has
 * saved, it is not a proxy to Polymarket.
 */
export const POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME =
  "core__poly_account_copy_trade_orders" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input is the capability descriptor's input, BY REFERENCE.
 *
 * Per CAPABILITY_DEFINED_ONCE there is no second declaration of this shape, and
 * per PRINCIPAL_NEVER_IN_ARGS note what the shape does NOT contain: the frozen
 * `poly.copy-trade.orders.v1` contract has no `billing_account_id`, which is
 * precisely why the descriptor is `accountFrom: "principal"`. The model is never
 * asked who it is reading for.
 */
export const PolyAccountCopyTradeOrdersToolInputSchema =
  polyAccountReadCopyTradeOrdersOperation.input;

export type PolyAccountCopyTradeOrdersToolInput = PolyCopyTradeOrdersInput;

/**
 * Why a read produced no facts. ONE code covers denial AND absence per
 * FAIL_CLOSED_NON_DISCLOSING: an unauthorized principal must not be able to
 * tell the two apart, and a model is a perfectly good oracle for an attacker.
 */
export const PolyAccountReadUnavailableReasonSchema = z.enum([
  /** Denied OR genuinely absent. Deliberately indistinguishable. */
  "no_readable_account",
  /** The principal reaches several accounts and this capability cannot be aimed. */
  "account_ambiguous",
  /** An internal failure, or a response that failed its own output contract. */
  "read_failed",
]);

/**
 * Flat result envelope.
 *
 * Per FLAT_OUTPUT_NO_UNIONS this is one object with optional members, not a
 * discriminated union: `ToolSpec` compiles through `zodToJsonSchema` and the
 * P0-supported JSONSchema subset disallows `oneOf`/`anyOf`, so a union here
 * would emit a spec shape the wire encoders are not allowed to carry.
 *
 * Per NO_FABRICATED_VALUES the `unavailable` branch omits `orders` and
 * `order_count` entirely. There is no zero to misread.
 */
export const PolyAccountCopyTradeOrdersToolOutputSchema = z.object({
  status: z
    .enum(["ok", "unavailable"])
    .describe(
      "ok = saved order-ledger rows are included. unavailable = no facts were returned; read `reason` and `message` and report them. Never substitute your own numbers."
    ),
  /** Present only when `status === "ok"`. The capability's rows, unchanged. */
  orders: polyCopyTradeOrdersOperation.output.shape.orders
    .optional()
    .describe(
      "Saved mirror order-ledger rows for the signed-in user's account, newest first. Absent unless status is ok."
    ),
  /** Present only when `status === "ok"`. */
  order_count: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Number of rows in `orders`. Absent unless status is ok — its absence is NOT zero."
    ),
  /** Present only when `status === "unavailable"`. */
  reason: PolyAccountReadUnavailableReasonSchema.optional().describe(
    "Machine-readable cause when status is unavailable."
  ),
  /** Present only when `status === "unavailable"`. */
  message: z
    .string()
    .optional()
    .describe(
      "Human-readable explanation to relay when status is unavailable. Relay it; do not paper over it with an estimate."
    ),
});

export type PolyAccountCopyTradeOrdersToolOutput = z.infer<
  typeof PolyAccountCopyTradeOrdersToolOutputSchema
>;

/**
 * Redaction is the identity map. Top-level keys only (P0 supports
 * `top_level_only`), and every one of them is already something this exact
 * principal is authorized to see — the owner dashboard renders these same rows
 * to the same person. Nothing here is a secret, an account id, or a wallet key.
 */
export type PolyAccountCopyTradeOrdersToolRedacted =
  PolyAccountCopyTradeOrdersToolOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Non-disclosing messages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The messages the model sees. Written as instructions rather than as status
 * text, because the failure mode being prevented is not a bad answer — it is a
 * CONFIDENT one. NO_FABRICATED_VALUES is enforced in the data shape above; this
 * is the belt to that braces.
 */
const UNAVAILABLE_MESSAGES: Record<
  z.infer<typeof PolyAccountReadUnavailableReasonSchema>,
  string
> = {
  // One message for denial AND absence. Do not split these: the difference is
  // exactly what FAIL_CLOSED_NON_DISCLOSING withholds.
  no_readable_account:
    "No copy-trade order ledger is readable for the signed-in user. There may be no saved mirror activity, or the account may not be readable with the current access. Tell the user that plainly. Do NOT state or estimate any order count, size, or price.",
  account_ambiguous:
    "The signed-in user can read more than one billing account, and this capability cannot be aimed at a specific one — its response contract carries no account identifier. Ask the user which account they mean and stop. Do NOT pick one, and do NOT report orders from any account.",
  read_failed:
    "The order-ledger read failed. This is a system fault, not a statement about the user's data. Say the read failed and offer to retry. Do NOT report any orders.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export const polyAccountCopyTradeOrdersToolContract: ToolContract<
  typeof POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
  PolyAccountCopyTradeOrdersToolInput,
  PolyAccountCopyTradeOrdersToolOutput,
  PolyAccountCopyTradeOrdersToolRedacted
> = {
  name: POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
  description:
    "Read the signed-in user's own saved copy-trade order ledger — the mirror placements this node has recorded, newest first. " +
    "You do NOT need and cannot supply an account, user, or wallet identifier: the account is resolved from the signed-in user's own access. " +
    "Never ask the user for a billing account id to call this tool. " +
    "Optional filters: `status` (one ledger state, or `all`), `target_id` (one tracked target), `limit` (keep it small; 20 is usually plenty). " +
    "Returns saved facts only — this is this node's own ledger, not a live Polymarket query. " +
    "If `status` comes back `unavailable`, relay `message` verbatim in substance and report NO numbers of your own.",
  effect: "read_only",
  inputSchema: PolyAccountCopyTradeOrdersToolInputSchema,
  outputSchema: PolyAccountCopyTradeOrdersToolOutputSchema,
  redact: (output) => output,
  allowlist: ["status", "orders", "order_count", "reason", "message"] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the transport needs injected. Note what is NOT here: no container, no
 * service-role handle, no account id, and no bearer token. Just the app-role
 * `Database`, the principal, and a request context for correlation.
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
 * point of story.5006 — the two actors are interchangeable clients of one
 * capability, not two implementations of one feature.
 *
 * Never throws. A tool that throws becomes an opaque `execution` error to the
 * model, which is exactly when a model starts guessing.
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
      // descriptor id. Parity is then a single Loki stream split by `routeId`.
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
      return {
        status: "ok",
        orders: outcome.data.orders,
        order_count: outcome.data.orders.length,
      };

    case "invalid_input":
      // `validateInput` in the bound runtime has ALREADY parsed `rawInput`
      // against this same descriptor schema before `exec` was reached, so a
      // schema rejection here is unreachable in practice and the remaining
      // `invalid_input` producer in the executor is the ambiguous-subject path
      // (`resolveSubjectAccountId` → `kind: "ambiguous"`).
      //
      // The executor's own message says "specify billing_account_id". That is
      // correct advice for an `accountFrom: "input"` capability and WRONG here:
      // this capability's frozen contract has no such field, so it is not
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
  reason: z.infer<typeof PolyAccountReadUnavailableReasonSchema>
): PolyAccountCopyTradeOrdersToolOutput {
  // No `orders`, no `order_count`. NO_FABRICATED_VALUES is a property of the
  // returned shape, not of the prose.
  return { status: "unavailable", reason, message: UNAVAILABLE_MESSAGES[reason] };
}

/**
 * Contract-only bound tool, for the node bundle the provider uses to build the
 * LLM-visible tool list. The real implementation is per-request (it closes over
 * a principal), so it cannot live in a module-scoped bundle — the stub here
 * exists to make that impossible to get wrong by accident.
 */
export const polyAccountCopyTradeOrdersBoundTool: BoundTool<
  typeof POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
  PolyAccountCopyTradeOrdersToolInput,
  PolyAccountCopyTradeOrdersToolOutput,
  PolyAccountCopyTradeOrdersToolRedacted
> = {
  contract: polyAccountCopyTradeOrdersToolContract,
  implementation: {
    execute: () => {
      throw new Error(
        "PRINCIPAL_NEVER_IN_ARGS: core__poly_account_copy_trade_orders has no " +
          "principal-free implementation. Resolve it from the per-request source " +
          "built by @bootstrap/ai/principal-tool-source, never from the " +
          "module-scoped container tool source."
      );
    },
  },
};

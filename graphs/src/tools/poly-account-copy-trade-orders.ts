// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-graphs/tools/poly-account-copy-trade-orders`
 * Purpose: The `ToolContract` for `core__poly_account_copy_trade_orders` — the
 *   LangGraph tool through which the internal `poly-brain` agent reads the
 *   SIGNED-IN USER's own saved copy-trade order ledger via the capability plane.
 *   Contract only: schemas, description, redaction. The implementation is
 *   injected at bootstrap (see `@bootstrap/ai/principal-tool-source`), exactly
 *   like `webSearchBoundTool` in `@cogni/ai-tools`.
 * Scope: Pure metadata. No IO, no DB, no env, no authorization, and no import
 *   from `src/**` (PACKAGES_NO_SRC_IMPORTS).
 *
 * WHY THIS LIVES IN THE GRAPH PACKAGE — the honest version, because it is not
 * the obvious home. `packages/poly-ai-tools` is where poly tool contracts
 * belong, but its `src/index.ts` is a port-frozen **P1** entry inside the
 * regression hard-stop, so a new export cannot be added there. `app/src` cannot
 * host it either, and for a sharper reason than layering:
 *
 *   **`app` and `@cogni/poly-node-contracts` resolve zod v4; `@cogni/ai-tools`,
 *   `@cogni/langgraph-graphs`, and this package resolve zod v3.**
 *
 * `ToolContract.inputSchema` is a zod **v3** `z.ZodType`, so a v4 schema does not
 * satisfy it — and the failure is not merely cosmetic. `toToolSpec` compiles the
 * spec with `zod-to-json-schema` (v3), which reads `_def.typeName`; zod v4 has no
 * such field, so a v4 schema compiles to an **empty** JSON Schema and the model
 * receives a tool with no arguments at all. That was observed in CI, not
 * theorised. This package already depends on zod v3 AND on
 * `@cogni/poly-node-contracts`, which makes it the one place that can express
 * the contract in v3 while type-checking it against the v4 descriptor.
 *
 * Invariants:
 *   - PRINCIPAL_NEVER_IN_ARGS — there is NO `billing_account_id`, account id,
 *     user id, or wallet field. The account is resolved from the calling
 *     principal by the capability plane. A tool that asks the MODEL who it is
 *     reading for is the incident that opened story.5006: an agent stalled
 *     demanding a UUID from a human. The bound capability
 *     (`poly.copy-trade.orders.v1`, `accountFrom: "principal"`) has no such
 *     field in its frozen schema, so this is structural, not a convention.
 *   - CAPABILITY_DEFINED_ONCE_ACROSS_ZOD_MAJORS — the input schema cannot be the
 *     descriptor's schema *by reference* across the v3/v4 boundary, so it is
 *     pinned to the descriptor's inferred TYPE instead:
 *     `z.ZodType<PolyCopyTradeOrdersInput>`. Add, remove, or rename a field on
 *     `poly.copy-trade.orders.v1` and this file stops compiling. That is a
 *     compile-time guard, not a review convention.
 *   - ROWS_ARE_NOT_REVALIDATED — `orders` is `z.array(z.unknown())` on purpose.
 *     The executor has ALREADY validated the rows against the capability's own
 *     output schema before this tool sees them. Re-declaring those 22 fields in
 *     v3 would create a second definition that can silently drift from the
 *     frozen contract — the exact failure CAPABILITY_DEFINED_ONCE forbids. The
 *     rows pass through unchanged, so the agent sees byte-identical saved facts
 *     to the dashboard.
 *   - FLAT_OUTPUT_NO_UNIONS — one object with optional members, never a
 *     `discriminatedUnion`: `ToolSpec` schemas must avoid `oneOf`/`anyOf`.
 *   - NO_FABRICATED_VALUES — the `unavailable` branch is expressed by OMITTING
 *     `orders` and `order_count`. There is no zero and no empty array for a
 *     model to narrate as fact.
 *   - NO_PRINCIPAL_FREE_IMPLEMENTATION — the exported `BoundTool`'s stub THROWS.
 *     It exists so the provider can publish the spec to the model; execution
 *     must come from the per-request, principal-scoped source.
 * Side-effects: none
 * Links: task.1791070967, story.5006, docs/spec/capability-plane.md
 * @public
 */

import type { BoundTool, ToolContract } from "@cogni/ai-tools";
import type { PolyCopyTradeOrdersInput } from "@cogni/poly-node-contracts";
import { z } from "zod";

/**
 * Namespaced tool id, per TOOL_ID_NAMESPACED (`core__<name>`, double underscore
 * for provider compatibility). `poly_account_` marks it as a capability-plane
 * read of THIS node's saved facts, unlike `core__poly_data_*`, which proxy the
 * public Polymarket API.
 */
export const POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME =
  "core__poly_account_copy_trade_orders" as const;

/**
 * Input, pinned to the capability descriptor's inferred type.
 *
 * Per CAPABILITY_DEFINED_ONCE_ACROSS_ZOD_MAJORS the annotation is the contract:
 * `PolyCopyTradeOrdersInput` comes from the frozen `poly.copy-trade.orders.v1`,
 * so this schema cannot drift from it without a compile error. `limit` coerces
 * because a model may emit it as a string.
 */
export const PolyAccountCopyTradeOrdersToolInputSchema: z.ZodType<PolyCopyTradeOrdersInput> =
  z.object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe(
        "Maximum rows to return (1-200). Keep it small; 20 is usually plenty."
      ),
    status: z
      .enum(["all", "pending", "open", "filled", "partial", "canceled", "error"])
      .optional()
      .describe("Return only rows in this ledger state, or `all`."),
    target_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Restrict to one tracked copy-trade target by its UUID. This is a TARGET id, not an account id — omit it unless the user named a specific target."
      ),
  });

/** Why a read produced no facts. */
export const PolyAccountReadUnavailableReasonSchema = z.enum([
  /**
   * Denied OR genuinely absent. Deliberately ONE code for both: per
   * FAIL_CLOSED_NON_DISCLOSING an unauthorized principal must not be able to
   * distinguish "exists but forbidden" from "absent", and a language model is a
   * perfectly good oracle for whoever is driving it.
   */
  "no_readable_account",
  /** The principal reaches several accounts and this capability cannot be aimed. */
  "account_ambiguous",
  /** Internal failure, or a response that failed its own output contract. */
  "read_failed",
]);

export type PolyAccountReadUnavailableReason = z.infer<
  typeof PolyAccountReadUnavailableReasonSchema
>;

/** Flat result envelope. See FLAT_OUTPUT_NO_UNIONS and NO_FABRICATED_VALUES. */
export const PolyAccountCopyTradeOrdersToolOutputSchema = z.object({
  status: z
    .enum(["ok", "unavailable"])
    .describe(
      "ok = saved order-ledger rows are included. unavailable = no facts were returned; read `reason` and `message` and report them. Never substitute your own numbers."
    ),
  /**
   * Present only when `status === "ok"`. Opaque here by design — see
   * ROWS_ARE_NOT_REVALIDATED; the capability already validated them.
   */
  orders: z
    .array(z.unknown())
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

export type PolyAccountCopyTradeOrdersToolInput = PolyCopyTradeOrdersInput;
export type PolyAccountCopyTradeOrdersToolOutput = z.infer<
  typeof PolyAccountCopyTradeOrdersToolOutputSchema
>;

/**
 * Redaction is the identity map. Top-level keys only (P0 supports
 * `top_level_only`), and every key is already something this exact principal is
 * authorized to see — the owner dashboard renders these same rows to the same
 * person. Nothing here is a secret, an account id, or a wallet key.
 */
export type PolyAccountCopyTradeOrdersToolRedacted =
  PolyAccountCopyTradeOrdersToolOutput;

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
    "Returns saved facts only — this is this node's own ledger, not a live Polymarket query, so it can legitimately be empty. " +
    "If `status` comes back `unavailable`, relay `message` and report NO numbers of your own.",
  effect: "read_only",
  inputSchema: PolyAccountCopyTradeOrdersToolInputSchema,
  outputSchema: PolyAccountCopyTradeOrdersToolOutputSchema,
  redact: (output) => output,
  allowlist: ["status", "orders", "order_count", "reason", "message"] as const,
};

/**
 * Contract + a THROWING stub, for the node bundle that publishes tool specs to
 * the model. Per NO_PRINCIPAL_FREE_IMPLEMENTATION, resolving this for execution
 * means the per-request principal-scoped source was not composed in — fail
 * loudly rather than answer with no principal.
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

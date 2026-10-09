// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-node-contracts/poly.capability-plane.v1.contract`
 * Purpose: The pure account-read operation catalog for the poly capability
 *   plane. One descriptor defines a capability once — its id, wire schemas,
 *   required scope, transport coordinates, and where the account id comes from.
 *   Every actor (owner session, approved external agent, internal agent) is a
 *   client of the same descriptor.
 * Scope: Pure metadata only — zod schemas and plain literals. Contains NO
 *   handler, NO database access, NO runtime registry, and imports nothing
 *   outside this package.
 * Invariants:
 *   - CAPABILITY_DEFINED_ONCE: a capability's id/input/output live here only.
 *   - NO_HANDLER_IN_PACKAGES: runtime binding is app-local
 *     (`@features/capability-plane`); packages stay pure so they can be
 *     imported by any transport without dragging in a DB client.
 *   - SCOPE_ENUM_SINGLE_SOURCE: `requiredScope` is typed by
 *     `AgentCapabilityScope` from `poly.agent-grants.v1.contract`.
 *   - COMPOSE_NEVER_MUTATE: existing `*Operation` literals are frozen port
 *     entries; account-read descriptors spread them rather than editing them.
 *   - GENERATED_DISCOVERY: `.well-known/agent.json` is a typed projection of
 *     `POLY_ACCOUNT_READ_OPERATIONS`, never hand-authored schemas.
 * Side-effects: none
 * Links: story.5006, story.5004, task.1791070961, docs/spec/capability-plane.md
 * @public
 */

import { z } from "zod";

import {
  PolyAccountCopySetupOwnerQuerySchema,
  polyAccountCopySetupOperation,
  polyAccountRecentAttemptsOperation,
  PolyAccountRecentAttemptsOwnerQuerySchema,
} from "./poly.account.copy-operations.v1.contract";
import {
  PolyAccountPortfolioSnapshotOwnerQuerySchema,
  polyAccountPortfolioSnapshotOperation,
} from "./poly.account.portfolio-snapshot.v1.contract";
import {
  PolyAccountTargetPositionsOwnerQuerySchema,
  polyAccountTargetPositionsOperation,
} from "./poly.account.target-positions.v1.contract";
import type { AgentCapabilityScope } from "./poly.agent-grants.v1.contract";
import { polyCopyTradeOrdersOperation } from "./poly.copy-trade.orders.v1.contract";
import {
  polyResearchCopyTradeInvestigationEvidenceOperation,
  polyResearchCopyTradeInvestigationOperation,
} from "./poly.research-copy-trade-investigation.v1.contract";
import { polyResearchCopyTradePnlOperation } from "./poly.research-copy-trade-pnl.v1.contract";

/** HTTP verbs an account read may be published under. Reads only. */
export type AccountReadMethod = "GET";

/**
 * Where the executor sources the billing account under authorization:
 * - `"input"`     — the validated input carries `billing_account_id`.
 * - `"principal"` — the account is the one the calling principal owns.
 */
export type AccountReadAccountSource = "input" | "principal";

/**
 * A single account-read capability, defined once.
 *
 * Pure metadata. The runtime handler is bound app-locally and is deliberately
 * absent from this type so `@cogni/poly-node-contracts` never gains a DB or
 * container dependency.
 */
export type AccountReadOperation<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  /** Stable, versioned capability id. Also keys the terminal feature event. */
  readonly id: string;
  /** One-line human/agent description published through discovery. */
  readonly summary: string;
  /** Request schema. Parsed before authorization; never trusted raw. */
  readonly input: TInput;
  /** Response schema. Validated after the handler, before the response. */
  readonly output: TOutput;
  /** Delegable scope a non-owner principal must hold. */
  readonly requiredScope: AgentCapabilityScope;
  /** Published HTTP method. */
  readonly method: AccountReadMethod;
  /** Published HTTP path. */
  readonly path: string;
  /**
   * `true` when the whole operation can run in a `REPEATABLE READ READ ONLY`
   * transaction. The executor sets that isolation level as the first statement
   * after the tenant context, which makes writes impossible at the DB level.
   */
  readonly readOnly: boolean;
  /** Where the account id under authorization comes from. */
  readonly accountFrom: AccountReadAccountSource;
};

/**
 * Identity helper that pins a descriptor to {@link AccountReadOperation} while
 * preserving its literal types (so discovery projections and handler maps stay
 * exhaustively checked). Pure — it only returns its argument.
 */
export function defineAccountReadOperation<
  const TOperation extends AccountReadOperation,
>(operation: TOperation): TOperation {
  return operation;
}

/** Coarse scope every account read is gated by (story.5006 rename). */
export const ACCOUNT_READ_SCOPE = "account:read" as const;

export const polyAccountReadCopyTradePnlOperation = defineAccountReadOperation({
  ...polyResearchCopyTradePnlOperation,
  requiredScope: ACCOUNT_READ_SCOPE,
  method: "GET",
  path: "/api/v1/poly/research/copy-trade-pnl",
  readOnly: true,
  accountFrom: "input",
});

export const polyAccountReadCopyTradeInvestigationOperation =
  defineAccountReadOperation({
    ...polyResearchCopyTradeInvestigationOperation,
    requiredScope: ACCOUNT_READ_SCOPE,
    method: "GET",
    path: "/api/v1/poly/research/copy-trade-investigation",
    readOnly: true,
    accountFrom: "input",
  });

export const polyAccountReadCopyTradeInvestigationEvidenceOperation =
  defineAccountReadOperation({
    ...polyResearchCopyTradeInvestigationEvidenceOperation,
    requiredScope: ACCOUNT_READ_SCOPE,
    method: "GET",
    path: "/api/v1/poly/research/copy-trade-investigation/evidence",
    readOnly: true,
    accountFrom: "input",
  });

/**
 * Copy-trade setup for the calling principal's own account (task.1791070959).
 *
 * `accountFrom: "input"` — the caller NAMES the account and `authorize()` then
 * checks a grant against it. This is deliberate and security-relevant: the
 * legacy dashboard/orders routes resolved the tenant from the caller's OWN id
 * with no grant check, and `resolveBillingAccountId` lazily CREATES an account
 * on miss, so a delegated agent silently received its own empty tenant instead
 * of a denial. Sourcing the account from validated input makes that
 * failure mode unreachable, and no GET on this plane can create an account.
 */
export const polyAccountReadCopySetupOperation = defineAccountReadOperation({
  ...polyAccountCopySetupOperation,
  requiredScope: ACCOUNT_READ_SCOPE,
  method: "GET",
  path: "/api/v1/poly/account/copy-setup",
  readOnly: true,
  accountFrom: "input",
});

/**
 * Owner-session transport for the SAME copy-setup capability. It intentionally
 * shares the operation id and output with the discoverable agent transport;
 * only its empty input, path, and principal-derived account differ.
 */
export const polyAccountReadCopySetupOwnerOperation =
  defineAccountReadOperation({
    ...polyAccountReadCopySetupOperation,
    input: PolyAccountCopySetupOwnerQuerySchema,
    path: "/api/v1/poly/copy-trade/targets",
    accountFrom: "principal",
  });

/**
 * Account-wide, cross-market mirror-attempt tape (task.1791070959). Spine is
 * `poly_copy_trade_decisions`, so skip reasons — the majority of mirror
 * activity — are visible for the first time.
 */
export const polyAccountReadRecentAttemptsOperation =
  defineAccountReadOperation({
    ...polyAccountRecentAttemptsOperation,
    requiredScope: ACCOUNT_READ_SCOPE,
    method: "GET",
    path: "/api/v1/poly/account/recent-attempts",
    readOnly: true,
    accountFrom: "input",
  });

/** Owner-session transport for the same canonical attempt tape. */
export const polyAccountReadRecentAttemptsOwnerOperation =
  defineAccountReadOperation({
    ...polyAccountReadRecentAttemptsOperation,
    input: PolyAccountRecentAttemptsOwnerQuerySchema,
    path: "/api/v1/poly/copy-trade/attempts",
    accountFrom: "principal",
  });

/**
 * The legacy mirror-orders list, inverted into a plane client (task.1791070959).
 *
 * `accountFrom: "principal"` is FORCED here, not chosen: the underlying
 * `poly.copy-trade.orders.v1` contract is a port-frozen `exact`/P1 entry, so its
 * input schema cannot gain a `billing_account_id` field and the account can
 * never arrive on the wire.
 *
 * Why that is delicate, stated plainly because it is sharper than "not
 * delegable": `POST /api/v1/agent/register` calls
 * `getOrCreateBillingAccountForUser`, so every approved agent OWNS a billing
 * account. An OWNERSHIP-based resolution would therefore resolve a delegated
 * agent to its own, empty account, which then passes `authorize()` as
 * `accessKind: "owner"` — a 200 describing the wrong tenant rather than the
 * granted account or a denial.
 *
 * The seam resolves by REACHABILITY for the required scope instead
 * (`resolveSubjectAccountId`: live grants ∪ owned). Exactly one reachable
 * account resolves; more than one returns `invalid_input`, so this operation
 * asks the caller to name the account instead of guessing — the right outcome
 * for an input schema that cannot carry the id; none is denied. Resolution is a
 * plain SELECT, so unlike the `resolveBillingAccountId` call this inversion
 * replaces, no GET here can CREATE a billing account.
 *
 * `poly.account.recent-attempts.v1` above remains the delegable successor for a
 * caller that wants to name an account, and is strictly more informative
 * because its spine is the decisions table rather than the fills ledger.
 */
export const polyAccountReadCopyTradeOrdersOperation =
  defineAccountReadOperation({
    ...polyCopyTradeOrdersOperation,
    summary:
      "Recent mirror order-ledger rows for the calling principal's own account",
    /**
     * COMPOSED, not mutated. The frozen contract declares `limit: z.number()`,
     * and the old hand-written route coerced it with `Number(limitRaw)` before
     * parsing. The plane's REST transport hands the descriptor raw query-string
     * values, so a bare `z.number()` would reject every `?limit=10` as a 400.
     * `.extend()` produces a coercing variant of the SAME shape — the inferred
     * TypeScript type is unchanged — while the frozen literal is untouched, per
     * COMPOSE_NEVER_MUTATE.
     */
    input: polyCopyTradeOrdersOperation.input.extend({
      limit: z.coerce.number().int().positive().max(200).optional(),
    }),
    requiredScope: ACCOUNT_READ_SCOPE,
    method: "GET",
    path: "/api/v1/poly/copy-trade/orders",
    readOnly: true,
    accountFrom: "principal",
  });

/**
 * The portfolio snapshot — the delegable agent transport (task.1791070962).
 *
 * A catalog member, and therefore discoverable. It was held out initially: its
 * output transitively contains `PolyAddressSchema`
 * (`poly.wallet-analysis.v1.contract.ts:30-33`), which ends in
 * `.transform((s) => s.toLowerCase())` at `execution.address` and again at
 * `market_groups[].lines[].participants[].walletAddress`. `z.toJSONSchema`
 * defaults to `unrepresentable: "throw"`, so projecting it threw — and because
 * the discovery route spreads the projection of the WHOLE catalog, publishing
 * this one descriptor blanked `.well-known/agent.json` for EVERY capability.
 *
 * Both halves are now fixed in the projection itself: each descriptor is
 * projected independently (`PROJECTION_FAILURE_IS_ISOLATED`) so blast radius is
 * one capability rather than the document, and an output schema that cannot be
 * represented falls back to input mode (`SCHEMA_DEGRADES_NEVER_LIES`), which
 * yields the pre-transform type — for an address `.toLowerCase()` that is the
 * same `string`, so the published schema is accurate rather than merely
 * permissive. See `@features/capability-plane/discovery`.
 *
 * `accountFrom: "input"` because a delegated agent MUST name the account it
 * reads. That is the structural fix for the production incident: before this,
 * an agent bearer calling `/wallet/dashboard` was answered about a tenant
 * resolved from its own id, which `resolveBillingAccountId` would lazily
 * CREATE on miss. Here the account comes from the wire and `authorize()`
 * decides, so a principal with no grant gets the same non-disclosing 404 as a
 * principal naming an account that does not exist.
 */
export const polyAccountReadPortfolioSnapshotOperation =
  defineAccountReadOperation({
    ...polyAccountPortfolioSnapshotOperation,
    requiredScope: ACCOUNT_READ_SCOPE,
    method: "GET",
    path: "/api/v1/poly/account/portfolio-snapshot",
    readOnly: true,
    accountFrom: "input",
  });

/**
 * The SAME capability over the owner-session transport: identical `id`,
 * `requiredScope`, and output, so Loki's `operationId` and every parity
 * assertion treat the two transports as one capability (CAPABILITY_DEFINED_ONCE).
 *
 * Only the account source and the input differ. The browser never learns its
 * own `billing_account_id` (inventory row 1.1 — it is not rendered and there
 * is no `whoami` yet), so this descriptor takes the account from the principal
 * instead of the wire.
 *
 * Deliberately NOT a member of `POLY_ACCOUNT_READ_OPERATIONS`: it must not be
 * published in `.well-known/agent.json`, because an agent calling it could only
 * ever be answered about an account the agent itself owns — which is useless
 * for delegation and is exactly the shape that caused the incident. Delegated
 * principals are served by the catalog entry above.
 */
export const polyAccountReadPortfolioSnapshotOwnerOperation =
  defineAccountReadOperation({
    ...polyAccountReadPortfolioSnapshotOperation,
    input: PolyAccountPortfolioSnapshotOwnerQuerySchema,
    path: "/api/v1/poly/wallet/dashboard",
    accountFrom: "principal",
  });

/** Delegable saved-facts view of every active copy-target portfolio. */
export const polyAccountReadTargetPositionsOperation =
  defineAccountReadOperation({
    ...polyAccountTargetPositionsOperation,
    requiredScope: ACCOUNT_READ_SCOPE,
    method: "GET",
    path: "/api/v1/poly/account/target-positions",
    readOnly: true,
    accountFrom: "input",
  });

/** Owner-session transport for the identical capability and output contract. */
export const polyAccountReadTargetPositionsOwnerOperation =
  defineAccountReadOperation({
    ...polyAccountReadTargetPositionsOperation,
    input: PolyAccountTargetPositionsOwnerQuerySchema,
    path: "/api/v1/poly/research/target-positions",
    accountFrom: "principal",
  });

/**
 * The account-read catalog. Discovery, handler binding, and terminal-event
 * maps all derive from this one array, so adding a capability without wiring
 * every surface is a type error rather than a silent gap.
 */
export const POLY_ACCOUNT_READ_OPERATIONS = [
  polyAccountReadCopyTradePnlOperation,
  polyAccountReadCopyTradeInvestigationOperation,
  polyAccountReadCopyTradeInvestigationEvidenceOperation,
  polyAccountReadCopySetupOperation,
  polyAccountReadRecentAttemptsOperation,
  polyAccountReadCopyTradeOrdersOperation,
  polyAccountReadPortfolioSnapshotOperation,
  polyAccountReadTargetPositionsOperation,
] as const;

export type PolyAccountReadOperation =
  (typeof POLY_ACCOUNT_READ_OPERATIONS)[number];

export type PolyAccountReadOperationId = PolyAccountReadOperation["id"];

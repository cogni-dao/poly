// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-node-contracts/poly.account.portfolio-snapshot.v1.contract`
 * Purpose: The canonical portfolio fact model — ONE bounded saved-facts
 *   snapshot carrying wallet identity/readiness, collateral/gas/open orders,
 *   total and component balances, P/L history, daily activity, open/closed
 *   positions, market exposure, and the freshness/completeness/warning
 *   envelope. It is the single output shape the owner dashboard and an
 *   approved delegated agent both receive, which is what makes parity
 *   structural rather than something a test has to chase.
 * Scope: Pure metadata only — zod schemas and plain literals. No handler, no
 *   DB, no env. Deliberately does NOT import the capability-plane contract:
 *   the pure literal lives here and the account-read descriptors are composed
 *   there, matching the house pattern and avoiding an import cycle.
 * Invariants:
 *   - DASHBOARD_IS_A_SUBSET: the output is
 *     `PolyWalletDashboardOutputSchema.extend({ readiness })`. Every field the
 *     owner UI renders is present verbatim, so the dashboard transport can
 *     return this shape unchanged and the UI's own non-strict parse of
 *     `PolyWalletDashboardOutputSchema` simply ignores `readiness`.
 *   - READINESS_IS_SAVED_FACTS_ONLY: `readiness` carries only columns
 *     persisted on the active `poly_wallet_connections` row (inventory rows
 *     2.4, 2.6, 2.7, 2.8). It performs no Privy round-trip and no Polygon RPC.
 *   - NO_MUTATION_HANDLES: `connection_id` (inventory row 2.5) is deliberately
 *     ABSENT. It is a connection mutation handle — an actor-only affordance,
 *     never a shared account fact, and it must never imply that a delegated
 *     principal may write. Same reasoning excludes `configured`, which is a
 *     deployment affordance and reaches the payload only through the
 *     dashboard's pre-existing `overview.configured` field.
 *   - NO_FABRICATED_VALUES: every readiness value that is not persisted is
 *     `null`/`false`-by-absence, never a stand-in number. `trading_ready` is
 *     strictly `trading_approvals_ready_at IS NOT NULL` on the active row.
 *   - ACCOUNT_ON_THE_WIRE_FOR_AGENTS: the delegated input requires
 *     `billing_account_id`. An agent must NAME the account it reads; it can
 *     never be silently answered about a tenant of its own. The owner input
 *     omits it and the account comes from the principal.
 * Side-effects: none
 * Links: story.5004, story.5006, task.1791070962,
 *   docs/spec/dashboard-agent-parity-inventory.md (rows 2.x-7.x, 10.3, 11.5-11.7)
 * @public
 */

import { z } from "zod";
import { PolyWalletDashboardOutputSchema } from "./poly.wallet.dashboard.v1.contract";
import { PolyWalletOverviewIntervalSchema } from "./poly.wallet.overview.v1.contract";

const walletAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

/**
 * Saved wallet readiness facts, read from the SAME active
 * `poly_wallet_connections` row that supplies `overview.address`, inside the
 * same snapshot. Inventory rows 2.4, 2.6, 2.7, 2.8 (plus `connected`, 2.2).
 *
 * These were previously reachable only through `GET /wallet/status`, which
 * resolves the tenant from the caller's own id with no grant check and reads
 * through a BYPASSRLS service handle. They are folded into the snapshot so one
 * authorized read covers the whole readiness picture.
 */
export const PolyAccountWalletReadinessSchema = z.object({
  /** An un-revoked connection row exists for this account (row 2.2). */
  connected: z.boolean(),
  /**
   * `funder_address`, falling back to `address` — the same `COALESCE` the
   * dashboard's identity lookup uses, so `readiness.funder_address` and
   * `overview.address` are the same fact from the same row (rows 2.1 / 2.6).
   */
  funder_address: walletAddressSchema.nullable(),
  /**
   * `trading_approvals_ready_at IS NOT NULL` on the active row (row 2.4).
   * APPROVALS_BEFORE_PLACE: false means Enable Trading has not been run.
   */
  trading_ready: z.boolean(),
  /**
   * ISO timestamp of the active auto-wrap consent, or null when never granted
   * or revoked since — `auto_wrap_revoked_at` nulls this out (row 2.7).
   */
  auto_wrap_consent_at: z.string().datetime().nullable(),
  /**
   * Minimum USDC.e the auto-wrap job will wrap, atomic 6-dp string (row 2.8).
   * Null only when there is no connection row at all — the column itself is
   * `NOT NULL DEFAULT 1000000`.
   *
   * Slightly more permissive than `polyWalletStatusOperation.output`'s
   * `/^[1-9][0-9]{0,18}$/`, which cannot express `0`. That is defence in
   * depth, not a bug fix: `poly_wallet_connections_auto_wrap_floor_positive`
   * (migration 0035) already CHECKs `> 0`, so a stored zero should be
   * unreachable. Accepting it here means a hypothetically corrupt row degrades
   * one readiness field rather than failing output validation and collapsing
   * the entire snapshot to a 500.
   */
  auto_wrap_floor_usdce_atomic: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,18})$/)
    .nullable(),
  /**
   * Freshness envelope for the readiness row, mirroring `facts.wallet`. The
   * readiness facts come from the identity row the snapshot already resolved,
   * so `observedAt` is the snapshot cutoff when a row exists.
   */
  observedAt: z.string().nullable(),
});
export type PolyAccountWalletReadiness = z.infer<
  typeof PolyAccountWalletReadinessSchema
>;

/**
 * The canonical portfolio snapshot: the entire dashboard contract plus the
 * readiness block. Strictly additive, so a consumer validating against
 * `PolyWalletDashboardOutputSchema` keeps working unchanged.
 */
export const PolyAccountPortfolioSnapshotOutputSchema =
  PolyWalletDashboardOutputSchema.extend({
    readiness: PolyAccountWalletReadinessSchema,
  });
export type PolyAccountPortfolioSnapshotOutput = z.infer<
  typeof PolyAccountPortfolioSnapshotOutputSchema
>;

/** Delegated/agent input. The account MUST be named on the wire. */
export const PolyAccountPortfolioSnapshotQuerySchema = z.object({
  billing_account_id: z.string().uuid(),
  interval: PolyWalletOverviewIntervalSchema.optional().default("1W"),
});
export type PolyAccountPortfolioSnapshotQuery = z.infer<
  typeof PolyAccountPortfolioSnapshotQuerySchema
>;

/** Owner-transport input. No account id; it comes from the principal. */
export const PolyAccountPortfolioSnapshotOwnerQuerySchema = z.object({
  interval: PolyWalletOverviewIntervalSchema.optional().default("1W"),
});
export type PolyAccountPortfolioSnapshotOwnerQuery = z.infer<
  typeof PolyAccountPortfolioSnapshotOwnerQuerySchema
>;

/**
 * The pure operation literal. `@features/capability-plane` composes the two
 * transport descriptors from this; it is never edited in place by them.
 */
export const polyAccountPortfolioSnapshotOperation = {
  id: "poly.account.portfolio-snapshot.v1",
  summary:
    "Read one coherent, bounded saved-facts portfolio snapshot for a billing account",
  description:
    "Returns wallet identity and readiness, collateral/gas/open orders, total and component balances, persisted P/L history, 14-day daily activity, bounded open and closed position previews with exact counts, bounded market exposure versus copy targets, and the per-component freshness/completeness/warning envelope — all at ONE coherent snapshot cutoff (`capturedAt`) inside a single REPEATABLE READ READ ONLY transaction. Saved facts only: no Polymarket, Privy, or Polygon RPC call is made. Missing or stale facts are returned as typed nulls with a warning explaining why, never as zero.",
  input: PolyAccountPortfolioSnapshotQuerySchema,
  output: PolyAccountPortfolioSnapshotOutputSchema,
} as const;

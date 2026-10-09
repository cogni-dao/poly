// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/poly.paper-account.v1.contract`
 * Purpose: Contract for creating the calling user's paper trading account — a
 *   `poly_wallet_connections` row with `kind = 'paper'` (migration 0082) plus
 *   the default `poly_wallet_grants` row that `authorizeIntent` requires.
 * Scope: `POST /api/v1/poly/paper-account`. Schema-only. Does not place
 *   trades, does not touch Privy, does not move real funds, and never reads
 *   or writes an on-chain balance.
 * Invariants:
 *   - TENANT_SCOPED: the tenant is derived from the authenticated session's
 *     billing account; the request body cannot override it.
 *   - PAPER_SEED_DECLARED: `seedUsdc` is required and positive. There is no
 *     default — a paper account with an implied starting balance would be a
 *     fabricated value, and the DB CHECK is the backstop.
 *   - SEED_IS_A_DECIMAL_STRING_ON_THE_WIRE: `seed_usdc` echoes back as a
 *     fixed-point string, not a float, because it originates from a
 *     `numeric(20, 8)` column and JSON numbers cannot carry it losslessly.
 *   - GRANT_CAPS_MIRROR_LIVE: `defaultGrant` reuses the exact shape and bounds
 *     of `poly.wallet.connect.v1`. A paper account whose caps differ from the
 *     live account's is not a twin — `authorizeIntent` enforces caps
 *     identically for both kinds, so divergent caps would silently make the
 *     two un-comparable.
 *   - IDEMPOTENT: re-posting for a tenant that already holds an active paper
 *     account returns that account with `created: false` rather than erroring.
 * Side-effects: none (schema only)
 * Links: docs/spec/capability-plane.md, docs/spec/poly-tenant-and-collateral.md
 * @public
 */

import { z } from "zod";

const walletAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

/** Fixed-point decimal as rendered by Postgres `numeric`. */
const decimalStringSchema = z.string().regex(/^\d+(\.\d+)?$/);

export const polyPaperAccountCreateOperation = {
  id: "poly.paper_account.create.v1",
  summary: "Create the calling user's paper trading account",
  description:
    "Creates (or returns, idempotently) a simulated trading account for the calling user's billing account: a poly_wallet_connections row with kind='paper', a synthetic deterministic address, a declared seed balance, and a default trade-authorization grant. No Privy wallet is created and no real funds are ever involved.",
  input: z.object({
    /**
     * Starting simulated collateral in USDC. Required — see
     * PAPER_SEED_DECLARED. Capped at 1e6 so a typo cannot mint an account
     * whose NAV curve is meaningless next to the live one.
     */
    seedUsdc: z.number().positive().min(1).max(1_000_000),
    /** Mirrors `poly.wallet.connect.v1`'s `defaultGrant` exactly. */
    defaultGrant: z
      .object({
        perOrderUsdcCap: z.number().positive().min(0.5).max(20),
        dailyUsdcCap: z.number().positive().min(2).max(200),
      })
      .refine((grant) => grant.dailyUsdcCap >= grant.perOrderUsdcCap, {
        message: "dailyUsdcCap must be >= perOrderUsdcCap",
        path: ["dailyUsdcCap"],
      }),
  }),
  output: z.object({
    connection_id: z.string().uuid(),
    kind: z.literal("paper"),
    /**
     * The synthetic deterministic address the paper account trades under.
     * Shaped like a real address so it satisfies the existing address CHECK
     * and the (chain_id, address) unique index, but no private key exists for
     * it and nothing on-chain will ever be observed at it.
     */
    address: walletAddressSchema,
    seed_usdc: decimalStringSchema,
    /** True iff this request created the row; false on an idempotent re-hit. */
    created: z.boolean(),
    /**
     * Always true for paper. A paper account needs no on-chain approvals, so
     * `trading_approvals_ready_at` is stamped at creation — otherwise
     * `authorizeIntent` would fail-closed on APPROVALS_BEFORE_PLACE and the
     * account could never place a simulated order.
     */
    trading_ready: z.boolean(),
  }),
} as const;

export type PolyPaperAccountCreateInput = z.infer<
  typeof polyPaperAccountCreateOperation.input
>;
export type PolyPaperAccountCreateOutput = z.infer<
  typeof polyPaperAccountCreateOperation.output
>;

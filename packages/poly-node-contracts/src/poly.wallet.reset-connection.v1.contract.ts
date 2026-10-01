// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/poly.wallet.reset-connection.v1.contract`
 * Purpose: Contract for the audited operator reset of ONE tenant's Polymarket
 *   wallet connection, so the owner can re-provision a fresh canonical V2
 *   Deposit Wallet through the normal product UI.
 * Scope: `POST /api/internal/node-actions/poly/wallet/reset-connection`.
 *   Schema-only. Moves no funds and deletes no history.
 * Invariants:
 *   - REVOKE_NEVER_DELETES — reset revokes the ACTIVE connection + grants and
 *     tombstones copy targets. Historical rows (including the row just
 *     revoked) are preserved for audit; nothing is deleted, and no Privy
 *     wallet or SIWE/user identity binding is touched.
 *   - NO_STRANDED_FUNDS — the reset refuses while the Deposit Wallet holds any
 *     USDC.e / pUSD / POL, unless the operator explicitly passes
 *     `accept_residual_dust`. A balance read that ERRORS always blocks reset
 *     (fail-closed) and cannot be overridden as dust.
 *   - NO_UNSETTLED_ORDERS — the reset refuses while any mirror fill row for
 *     the tenant is still `pending | open | partial`, so a revoke can never
 *     orphan a resting CLOB order.
 *   - RESET_IS_IDEMPOTENT — a second call with no active connection returns
 *     `no_active_connection` and 200, not an error.
 *   - NO_FUND_MOVEMENT — this operation never transfers, wraps, or withdraws.
 *     Recovery is a separate, explicit action.
 * Side-effects: none (schema only)
 * Links: docs/spec/poly-tenant-and-collateral.md, work/items/bug.5310
 * @public
 */

import { z } from "zod";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

export const polyWalletResetConnectionOperation = {
  id: "poly.wallet.reset-connection.v1",
  summary:
    "Revoke one tenant's active Polymarket wallet connection + grants and disable its copy targets, so the owner can re-provision a fresh V2 Deposit Wallet",
  description:
    "Audited operator reset for a single billing account. Fail-closed on residual balances and unsettled mirror orders. Preserves all history, the Privy wallet, and the SIWE identity binding. Never moves funds.",
  input: z.object({
    billing_account_id: z.string().min(1),
    /**
     * Acknowledge that the Deposit Wallet still holds a residual amount the
     * owner has accepted as unrecoverable dust. This never overrides an
     * unreadable balance; read errors always block (NO_STRANDED_FUNDS).
     */
    accept_residual_dust: z.boolean().default(false),
  }),
  output: z.object({
    billing_account_id: z.string(),
    outcome: z.enum(["reset", "no_active_connection", "blocked"]),
    /** Populated iff `outcome === "blocked"`. */
    blocked_reason: z
      .enum([
        "residual_balance",
        "balance_read_failed",
        "unsettled_orders",
      ])
      .nullable(),
    connection: z
      .object({
        connection_id: z.string(),
        /** The user-visible Deposit Wallet. `null` on a legacy EOA row. */
        funder_address: addressSchema.nullable(),
        /** Hidden Privy signer. Reported for audit only — never a funding destination. */
        signer_address: addressSchema,
        revoked_at: z.string().datetime().nullable(),
      })
      .nullable(),
    balances: z.object({
      usdc_e: z.number().nullable(),
      pusd: z.number().nullable(),
      pol: z.number().nullable(),
      read_errors: z.array(z.string()),
    }),
    unsettled_fill_count: z.number().int(),
    grants_revoked_count: z.number().int(),
    targets_disabled_count: z.number().int(),
    /**
     * Seconds until `/connect` will accept a re-provision. The connect
     * cooldown keys off the newest row's `revoked_at`, so a fresh reset always
     * starts a short window; there is deliberately no bypass.
     */
    reprovision_available_in_seconds: z.number().int(),
  }),
} as const;

export type PolyWalletResetConnectionInput = z.infer<
  typeof polyWalletResetConnectionOperation.input
>;
export type PolyWalletResetConnectionOutput = z.infer<
  typeof polyWalletResetConnectionOperation.output
>;

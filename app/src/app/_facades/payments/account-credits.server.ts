// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/payments/account-credits.server`
 * Purpose: Read ONE account's credit summary (balance and ledger) as the CALLER, for the gated account reads: `GET /api/v1/accounts/{accountId}/credits` and
 *   `GET /api/v1/payments/credits/summary?accountId=`. Both are the route twins of the tool `core__account_credits_read` (scope `account:read`, the one
 *   account scope: "Read your account data").
 * Scope: Server-only. The door (`sameDoor` + an account param) has already decided owner | delegated | nothing; this reads under row-level security.
 * Invariants:
 *   - RLS_DECIDES_ROWS: the read runs in an app-role tenant transaction with `app.current_user_id` = the CALLER (the owner, or the agent), never the service
 *     role, so a delegated agent sees rows only through `agent_has_scope` and the door and the database cannot disagree.
 *   - ACCOUNT_404_NON_DISCLOSING: an account the database hides from the caller is `null`; the route answers one 404.
 * Side-effects: IO (RLS-scoped reads of billing_accounts and credit_ledger)
 * @public
 */

import { toUserId } from "@cogni/ids";
import type { CreditsSummaryOutput } from "@cogni/node-contracts";

import { getContainer } from "@/bootstrap/container";
import { getCreditsSummary } from "@/features/payments/services/creditsSummary";
import { isBillingAccountNotFoundPortError } from "@/ports";

export async function readAccountCredits(params: {
  /** The caller's user id: the RLS actor. */
  callerUserId: string;
  accountId: string;
  limit?: number | undefined;
}): Promise<CreditsSummaryOutput | null> {
  try {
    const summary = await getCreditsSummary(getContainer().accountsForUser(toUserId(params.callerUserId)), {
      billingAccountId: params.accountId,
      limit: params.limit,
    });
    return {
      billingAccountId: summary.billingAccountId,
      balanceCredits: summary.balanceCredits,
      ledger: summary.ledger.map((entry) => ({
        id: entry.id,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter,
        reason: entry.reason,
        reference: entry.reference,
        metadata: entry.metadata,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  } catch (error) {
    // RLS returned no row for this caller (the door agreed, the database did not, or the account vanished): the same 404.
    if (isBillingAccountNotFoundPortError(error)) return null;
    throw error;
  }
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/payments/account-credits.server`
 * Purpose: Read ONE account's credit summary (balance and ledger) as the CALLER, for the gated account reads: `GET /api/v1/accounts/{accountId}/credits` and
 *   `GET /api/v1/payments/credits/summary?accountId=`. Both are the route twins of the tool `core__account_credits_read` (scope `account:read`, the one
 *   account scope: "Read your account data").
 * Scope: Server-only. The door (`sameDoor` + an account param) has already decided owner | delegated | nothing; this reads under row-level security.
 * Invariants:
 *   - DOOR_DECIDES_THEN_OWNER_SCOPE: the route's door (`authorizeAccount` over `agent_roles`) has already answered owner | delegated | nothing. The read then runs
 *     in an app-role tenant transaction scoped to the ACCOUNT OWNER (never the service role, never a caller-chosen id), as a payer-bound run does. There is no
 *     delegated policy on billing_accounts or credit_ledger: billing_accounts sits under every owner subquery, so an extra qual there is costed into every tenant read.
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
  /** The caller's user id. The door has already decided this caller may read this account; it is not the RLS actor (the account owner is). */
  callerUserId: string;
  accountId: string;
  limit?: number | undefined;
}): Promise<CreditsSummaryOutput | null> {
  try {
    const container = getContainer();
    const account = await container.serviceAccountService.getBillingAccountById(params.accountId);
    if (!account) return null;
    const summary = await getCreditsSummary(container.accountsForUser(toUserId(account.ownerUserId)), {
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

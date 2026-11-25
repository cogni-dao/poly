// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/ai/payer.server`
 * Purpose: Which billing account pays for a run (story.0038 phase 2). The decisions are pure functions in `@cogni-dao/agent-grants` (`selectRunPayer`, `payerScopeUserFor`); this
 *   file only composes them with the node's lookups and logs the selection.
 * Scope: Composition. A caller with a live payer binding is billed to the account its owners approved; every other caller is billed to its own account, unchanged.
 * Invariants:
 *   - PAYER_IS_AUTHORIZED / NEVER_CACHED / FAIL_CLOSED_ON_OUTAGE / OWNER_SCOPED_READ: owned by the package functions (see `payer.ts` there).
 *   - Logs `payer.selected` (subject, billingAccountId) when a bound account is chosen; no token or balance.
 * Side-effects: logs
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @internal
 */

import { payerScopeUserFor as packagePayerScopeUserFor, selectRunPayer as packageSelectRunPayer } from "@cogni/agent-grants";
import type { Logger } from "pino";
import { EVENT_NAMES } from "@/shared/observability";

interface AccountLike {
  readonly id: string;
  readonly ownerUserId?: string;
}

export interface PayerDeps<A extends AccountLike> {
  /** The account a live binding names for this subject, or null. */
  readonly payerFor: (subjectUserId: string) => Promise<string | null>;
  /** Read by id on the service-role path (RLS would hide an org's account from the subject). */
  readonly getBillingAccountById: (billingAccountId: string) => Promise<A | null>;
  readonly log: Pick<Logger, "info">;
}

/** The account that pays for this caller's run: the bound account when a live binding names one, else `own`. */
export async function selectRunPayer<A extends AccountLike>(
  deps: PayerDeps<A>,
  input: { readonly subjectUserId: string; readonly own: A }
): Promise<A> {
  const { account, bound } = await packageSelectRunPayer(
    { payerFor: deps.payerFor, getAccount: deps.getBillingAccountById },
    input
  );
  if (bound)
    deps.log.info(
      { event: EVENT_NAMES.PAYER_SELECTED, subject: input.subjectUserId, billingAccountId: account.id },
      EVENT_NAMES.PAYER_SELECTED
    );
  return account;
}

/** The user whose row-level-security scope reads and charges `billingAccountId` for this run. */
export function payerScopeUserFor(
  deps: Pick<PayerDeps<AccountLike>, "payerFor" | "getBillingAccountById">,
  input: { readonly actorUserId: string; readonly billingAccountId: string }
): Promise<string> {
  return packagePayerScopeUserFor({ payerFor: deps.payerFor, getAccount: deps.getBillingAccountById }, input);
}

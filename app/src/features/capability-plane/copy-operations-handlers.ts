// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/capability-plane/copy-operations-handlers`
 * Purpose: App-local runtime binding for the three copy-operations account
 *   reads of task.1791070959 — copy setup, the recent-attempt tape, and the
 *   inverted mirror-orders list. Joins each pure descriptor to its feature
 *   query, its error classifier, and the counts its terminal event carries.
 * Scope: Wiring only. No query, no authorization, no HTTP. Kept in its own
 *   module rather than appended to `handlers.ts` so this task's bindings and
 *   the seam task's bindings do not share a file.
 * Invariants:
 *   - NO_AUTHORIZATION_HERE — `executeAccountRead` owns the single decision.
 *   - EXTRA_IS_COUNTS_ONLY — the `extra` builders emit cardinality and
 *     completeness flags, never account ids, wallet addresses, or cap values.
 *     A terminal event is not a data channel.
 *   - CLASSIFIERS_ARE_CALLER_ERRORS_ONLY — only an unparseable cursor or a
 *     future `captured_at` becomes a 400. Everything else stays a 500 so a
 *     genuine outage is never reported as the caller's fault.
 * Side-effects: none at module load; handlers do IO when invoked.
 * Links: task.1791070959, story.5004
 * @public
 */

import type {
  PolyAccountCopySetupQuery,
  PolyAccountCopySetupResponse,
  PolyAccountRecentAttemptsQuery,
  PolyAccountRecentAttemptsResponse,
  PolyCopyTradeOrdersInput,
  PolyCopyTradeOrdersOutput,
} from "@cogni/poly-node-contracts";

import { getCopySetupForAccount } from "@/features/wallet-analysis/server/copy-setup-read";
import {
  getRecentAttemptsForAccount,
  InvalidAttemptCapturedAtError,
  InvalidAttemptCursorError,
} from "@/features/wallet-analysis/server/copy-trade-attempts-read";
import { listCopyTradeOrdersForAccount } from "@/features/wallet-analysis/server/copy-trade-orders-read";

import type { AccountReadHandler, AccountReadStatus } from "./execute-account-read";

// ---------------------------------------------------------------------------
// Capability 1 — copy setup
// ---------------------------------------------------------------------------

export const copySetupAccountReadHandler: AccountReadHandler<
  PolyAccountCopySetupQuery,
  PolyAccountCopySetupResponse
> = (tx, input) => getCopySetupForAccount(tx, input);

/**
 * Setup counts. `capsStatus` is the discriminant only — never the cap values,
 * which are account data and have no business in a log line.
 */
export function copySetupExtra(context: {
  status: AccountReadStatus;
  data: PolyAccountCopySetupResponse | null;
}): Record<string, unknown> {
  const data = context.data;
  if (context.status !== "ok" || !data) return {};
  return {
    targetCount: data.targets.length,
    activeTargetCount: data.active_target_count,
    targetsTruncated: data.targets_truncated,
    capsStatus: data.wallet_safety.status,
    // High-signal: counts the targets that are configured but silently not
    // enumerated because the wallet grant lapsed (bug.5288).
    blockedTargetCount: data.targets.filter(
      (target) => target.activation.status === "blocked_no_active_wallet_grant"
    ).length,
    complete: data.completeness.complete,
  };
}

// ---------------------------------------------------------------------------
// Capability 2 — recent attempts
// ---------------------------------------------------------------------------

export const recentAttemptsAccountReadHandler: AccountReadHandler<
  PolyAccountRecentAttemptsQuery,
  PolyAccountRecentAttemptsResponse
> = (tx, input) => getRecentAttemptsForAccount(tx, input);

/**
 * An unparseable cursor or a future `captured_at` is a caller problem. The
 * executor renders both as the 400 a hand-written route would have raised.
 */
export function classifyRecentAttemptsError(
  error: unknown
): "invalid_input" | undefined {
  return error instanceof InvalidAttemptCursorError ||
    error instanceof InvalidAttemptCapturedAtError
    ? "invalid_input"
    : undefined;
}

/** Tape counts, including the skip-rate signal this capability exists to expose. */
export function recentAttemptsExtra(context: {
  status: AccountReadStatus;
  input: PolyAccountRecentAttemptsQuery | null;
  data: PolyAccountRecentAttemptsResponse | null;
}): Record<string, unknown> {
  const data = context.data;
  const base = context.input
    ? { modeFilter: context.input.mode, outcomeFilter: context.input.outcome }
    : {};
  if (context.status !== "ok" || !data) return base;
  const skipped = data.attempts.filter(
    (attempt) => attempt.decision.outcome === "skipped"
  ).length;
  return {
    ...base,
    attemptCount: data.attempts.length,
    skippedCount: skipped,
    placedCount: data.attempts.filter(
      (attempt) => attempt.decision.outcome === "placed"
    ).length,
    errorCount: data.attempts.filter(
      (attempt) => attempt.decision.outcome === "error"
    ).length,
    truncated: data.truncated,
    hasNextPage: data.next_cursor !== null,
    freshness: data.freshness.status,
    attemptsMissingLedgerRow: data.completeness.attempts_missing_ledger_row,
    complete: data.completeness.complete,
  };
}

// ---------------------------------------------------------------------------
// The inverted mirror-orders list
// ---------------------------------------------------------------------------

export const copyTradeOrdersAccountReadHandler: AccountReadHandler<
  PolyCopyTradeOrdersInput,
  PolyCopyTradeOrdersOutput
> = (tx, input) => listCopyTradeOrdersForAccount(tx, input);

export function copyTradeOrdersExtra(context: {
  status: AccountReadStatus;
  input: PolyCopyTradeOrdersInput | null;
  data: PolyCopyTradeOrdersOutput | null;
}): Record<string, unknown> {
  return {
    ...(context.input?.status !== undefined
      ? { statusFilter: context.input.status }
      : {}),
    ordersCount:
      context.status === "ok" && context.data ? context.data.orders.length : 0,
  };
}

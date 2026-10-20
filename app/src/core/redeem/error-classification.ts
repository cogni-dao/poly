// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@core/redeem/error-classification`
 * Purpose: Typed classification of a redeem-tx submission failure so the
 *   worker routes RPC-infrastructure flukes around the chain-revert
 *   circuit breaker.
 * Scope: Pure. No DB, no chain, no time. Operates on the decoded error
 *   shape produced by `decodeRevertReason`.
 * Invariants:
 *   - TYPED_DISPATCH_FAILURES — local invalid input and explicit service
 *     rejection are distinct from chain reverts and RPC transport errors.
 *     Missing revert fields alone do not prove a transport failure.
 *   - RPC_TRANSIENT_DOES_NOT_CONSUME_RETRY_BUDGET — only `chain_revert`
 *     and explicit submission rejection consume the 3-strike retry budget.
 * Side-effects: none
 * Links: docs/research/poly/redeem-worker-resilience-handoff-2026-05-09.md,
 *   work/items/bug.5041
 * @public
 */

export type RedeemErrorClass =
  | "rpc_transient"
  | "chain_revert"
  | "malformed"
  | "submission_rejected";

/** SDK-independent signal set only at a known redemption submission boundary. */
export class RedeemSubmissionError extends Error {
  constructor(
    readonly failureClass: "malformed" | "submission_rejected",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RedeemSubmissionError";
  }
}

/** Decoded shape of a viem submission error — kept structural so this
 *  module stays import-clean from viem. */
export interface DecodedRedeemError {
  reason: string | null;
  data: string | null;
  shortMessage: string;
  dispatchFailure?: "malformed" | "submission_rejected" | undefined;
}

export function classifyRedeemError(err: DecodedRedeemError): RedeemErrorClass {
  if (err.dispatchFailure) return err.dispatchFailure;
  if (err.reason !== null) return "chain_revert";
  if (err.data !== null && err.data !== "") return "chain_revert";
  if (/contract function .* reverted/i.test(err.shortMessage))
    return "chain_revert";
  return "rpc_transient";
}

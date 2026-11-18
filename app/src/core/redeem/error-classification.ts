// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@core/redeem/error-classification`
 * Purpose: Classification of a redeem-tx submission failure so the worker can
 *   (a) park deterministic rejections instead of retrying them forever,
 *   (b) route genuine RPC-infrastructure flukes around the chain-revert
 *   circuit breaker, and (c) budget everything else.
 * Scope: Pure. No DB, no chain, no time. Operates on the decoded error
 *   shape produced by `decodeRevertReason`.
 * Invariants:
 *   - DETERMINISTIC_REJECTION_IS_TERMINAL (bug.5047) — SDK input validation
 *     (`UserInputError`, e.g. "Position ID must use a supported protocol v2
 *     module") can never succeed on retry. Class `permanent_input`; the worker
 *     abandons the job with a named reason instead of looping.
 *   - STRUCTURAL_FIELDS_ARE_DISPOSITIVE — viem's `reason`/`data` are
 *     populated iff the tx executed and reverted on chain. Their absence
 *     alone does NOT mean RPC (bug.5047 conflated the two).
 *   - ONLY_POSITIVE_RPC_EVIDENCE_IS_FREE — `rpc_transient` requires positive
 *     transport evidence (HttpRequestError/timeout/429/5xx/ECONN…). Anything
 *     else is `unclassified` and consumes the 3-strike retry budget, so no
 *     failure can stay at attempt 1/3 forever.
 * Side-effects: none
 *   work/items/bug.5041, work/items/bug.5047
 * @public
 */

export type RedeemErrorClass =
  | "permanent_input"
  | "chain_revert"
  | "rpc_transient"
  | "unclassified";

/** Decoded shape of a viem/SDK submission error — kept structural so this
 *  module stays import-clean from viem. */
export interface DecodedRedeemError {
  reason: string | null;
  data: string | null;
  shortMessage: string;
  /** `err.name` (e.g. `UserInputError`, `HttpRequestError`). */
  errorName?: string | null;
  /** Full `err.message` when it differs from `shortMessage`. */
  message?: string | null;
}

/** `last_error` prefix written when a job is parked for an unsupported
 *  position-ID module. The enqueue path must not revive rows carrying it. */
export const UNSUPPORTED_POSITION_MODULE_REASON = "unsupported_position_module";

/** `last_error` prefix for other deterministic SDK input rejections. */
export const INVALID_POSITION_INPUT_REASON = "invalid_position_input";

const UNSUPPORTED_MODULE_RE = /supported protocol v2 module/i;
// Deterministic `UserInputError` messages thrown by @polymarket/client@0.11.0
// `redeemPositions` before any tx is built (position-id decode / zero balance).
const DETERMINISTIC_INPUT_RE =
  /position id must (use a supported protocol v2 module|be a uint256 value)|protocol v2 position id must be a yes\/no|position has no balance to redeem/i;
const TRANSPORT_NAME_RE =
  /^(HttpRequestError|TimeoutError|RpcRequestError|TransportError|WebSocketRequestError)$/;
const TRANSPORT_MESSAGE_RE =
  /timed? ?out|fetch failed|network|econn|enotfound|eai_again|etimedout|socket hang up|rate.?limit|too many requests|\b429\b|\b50[0234]\b|service unavailable|bad gateway|http request failed/i;

function haystack(err: DecodedRedeemError): string {
  return `${err.shortMessage} ${err.message ?? ""}`;
}

export function classifyRedeemError(err: DecodedRedeemError): RedeemErrorClass {
  if (
    err.errorName === "UserInputError" ||
    DETERMINISTIC_INPUT_RE.test(haystack(err))
  )
    return "permanent_input";
  if (err.reason !== null) return "chain_revert";
  if (err.data !== null && err.data !== "") return "chain_revert";
  if (/contract function .* reverted/i.test(err.shortMessage))
    return "chain_revert";
  if (
    (err.errorName != null && TRANSPORT_NAME_RE.test(err.errorName)) ||
    TRANSPORT_MESSAGE_RE.test(haystack(err))
  )
    return "rpc_transient";
  return "unclassified";
}

/** Named park reason for a `permanent_input` failure. */
export function permanentRedeemReason(err: DecodedRedeemError): string {
  return UNSUPPORTED_MODULE_RE.test(haystack(err))
    ? UNSUPPORTED_POSITION_MODULE_REASON
    : INVALID_POSITION_INPUT_REASON;
}

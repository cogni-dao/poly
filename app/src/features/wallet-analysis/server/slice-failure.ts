// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/slice-failure`
 * Purpose: Make swallowed read failures visible (bug.5064). A wallet-analysis slice that
 *   throws is turned into a response `warnings[]` entry; without a log line a Postgres
 *   53300 (role connection exhaustion) was invisible in Loki.
 * Scope: Builds bounded, secret-scrubbed log fields, classifies connection-capacity
 *   failures, and emits ONE structured warn per failed slice. No SQL, no HTTP.
 * Invariants:
 *   - SLICE_FAILURE_LOGGED_ONCE: every swallowed slice failure emits exactly one warn
 *     with `event` + `slice` + `cause_code` (SQLSTATE when present).
 *   - NO_PAYLOAD: only error class/code/sanitized message — never SQL params or DSNs.
 * Side-effects: one log line per failure.
 * Links: work/items/bug.5064, @shared/observability/safe-error-dimensions
 * @internal
 */

import { EVENT_NAMES, makeLogger } from "@/shared/observability";
import { isDbCapacityError } from "@/shared/observability/db-capacity-error";
import { safeErrorDimensions } from "@/shared/observability/safe-error-dimensions";

export { isDbCapacityError };

export interface SliceFailureLogger {
  warn: (fields: Record<string, unknown>, message: string) => void;
}

/** Structured fields for a failed slice; `cause_code` is the SQLSTATE or driver code. */
export function sliceFailureFields(
  slice: string,
  err: unknown
): Record<string, unknown> {
  const dims = safeErrorDimensions(err);
  return {
    ...dims,
    event: EVENT_NAMES.POLY_WALLET_ANALYSIS_SLICE_FAILED,
    slice,
    // Drizzle wraps the driver error as `cause`; postgres-js errors carry `code` directly.
    cause_code: dims.cause_code ?? dims.err_code,
  };
}

/** Emit the one structured warn for a swallowed slice failure. */
export function logSliceFailure(
  slice: string,
  err: unknown,
  logger: SliceFailureLogger = makeLogger({ component: "wallet-analysis" })
): void {
  logger.warn(
    sliceFailureFields(slice, err),
    "wallet-analysis slice failed — served as a response warning"
  );
}

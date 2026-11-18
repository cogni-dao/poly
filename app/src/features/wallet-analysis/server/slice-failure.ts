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
import { safeErrorDimensions } from "@/shared/observability/safe-error-dimensions";

/** SQLSTATE 53300 too_many_connections; 53000/53400 are the sibling resource limits. */
const DB_CAPACITY_SQLSTATES: ReadonlySet<string> = new Set([
  "53300",
  "53000",
  "53400",
]);

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

/** True when the failure is Postgres refusing a connection (role/db/server limit). */
export function isDbCapacityError(err: unknown): boolean {
  const dims = safeErrorDimensions(err);
  const code = dims.cause_code ?? dims.err_code;
  if (code !== undefined && DB_CAPACITY_SQLSTATES.has(code)) return true;
  return /too many connections/i.test(
    `${dims.err ?? ""} ${dims.cause_message ?? ""}`
  );
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

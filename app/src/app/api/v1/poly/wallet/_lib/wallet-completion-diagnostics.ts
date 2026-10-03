// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/wallet/_lib/wallet-completion-diagnostics`
 * Purpose: Canonical observability fields for partial-success wallet reads.
 * Scope: Pure completion-event projection. Does not alter HTTP responses.
 * Invariants:
 *   - WARNING_CODES_CANONICAL: warning_codes are sorted and deduplicated.
 *   - WARNINGS_NEVER_OK: a warning-bearing completion cannot report status=ok.
 * Side-effects: none
 * @internal
 */

export function walletCompletionDiagnostics(
  status: string,
  warningCodes: readonly string[]
): {
  status: string;
  warnings: number;
  warning_codes: string[];
} {
  const normalizedWarningCodes = [...new Set(warningCodes)].sort();
  return {
    status:
      normalizedWarningCodes.length > 0 && status === "ok"
        ? "degraded"
        : status,
    warnings: warningCodes.length,
    warning_codes: normalizedWarningCodes,
  };
}

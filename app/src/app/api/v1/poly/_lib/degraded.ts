// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/_lib/degraded`
 * Purpose: Shared degraded-response helpers for the first read-only Poly runtime port.
 * Scope: Pure response constants/helpers only. Does not read DB, env, or upstream APIs.
 * Invariants: READ_ONLY_BOOTSTRAP — no trading, signing, wallet mutation, or DB writes.
 * Side-effects: none
 * @internal
 */

export const POLY_RUNTIME_BOOTSTRAP_WARNING = {
  code: "poly_runtime_bootstrap",
  message:
    "Poly runtime read models are being restored; this endpoint is serving a safe degraded response.",
} as const;

export function capturedAt(): string {
  return new Date().toISOString();
}

export function noWalletWarning() {
  return {
    code: "wallet_unconfigured",
    message:
      "No Poly trading wallet is configured for this session in the restored node runtime.",
  };
}


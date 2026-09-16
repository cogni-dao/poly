// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/lib/token-display`
 * Purpose: BigInt-safe ERC20 amount formatting for ownership views.
 * Scope: Pure display derivation only.
 * Invariants: Never converts base-unit amounts to Number; caps visible precision at four decimals.
 * Side-effects: none
 * @internal
 */

export function formatTokenAmount(base: bigint, decimals: number): string {
  const safeDecimals =
    Number.isInteger(decimals) && decimals >= 0 ? decimals : 18;
  const divisor = 10n ** BigInt(safeDecimals);
  const whole = base / divisor;
  const frac = base % divisor;
  if (frac === 0n) return `${whole.toLocaleString()} tokens`;
  const fracStr = frac
    .toString()
    .padStart(safeDecimals, "0")
    .replace(/0+$/, "");
  return `${whole.toLocaleString()}.${fracStr.slice(0, 4)} tokens`;
}

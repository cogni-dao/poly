// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/wallet/_lib/cash-on-chain`
 * Purpose: Combine a trading wallet's two on-chain cash legs — USDC.e (bridged,
 *   pre-cutover collateral) and pUSD (Polymarket V2 collateral, post the
 *   2026-04-28 cutover) — into a single spendable cash figure for the dashboard.
 * Scope: Pure function. No IO. Consumed by the wallet overview route.
 * Invariants:
 *   - COLLATERAL_INCLUDES_PUSD: pUSD is where a funded wallet's balance lives
 *     after the cutover, so it MUST be summed. Reading USDC.e alone reports a
 *     funded wallet as empty (the pUSD-collateral bug).
 *   - SUM_IS_NULL_SAFE: sum whichever legs read successfully. A single failed
 *     RPC read (one leg null, the other a real balance) must never zero out the
 *     wallet. Returns null only when NO leg read succeeded (both null → RPC
 *     down / unconfigured), so the dashboard degrades to "—" rather than
 *     falsely claiming an empty wallet.
 * Side-effects: none
 * Links: docs/spec/poly-tenant-and-collateral.md
 * @internal
 */

/**
 * Sum the wallet's spendable on-chain cash across both collateral vintages.
 *
 * @param usdcE bridged USDC.e balance in whole tokens, or null when the read failed
 * @param pusd Polymarket V2 pUSD balance in whole tokens, or null when the read failed
 * @returns combined cash in whole tokens, or null when neither leg read successfully
 */
export function sumCashOnChain(
  usdcE: number | null,
  pusd: number | null
): number | null {
  if (usdcE === null && pusd === null) return null;
  return (usdcE ?? 0) + (pusd ?? 0);
}

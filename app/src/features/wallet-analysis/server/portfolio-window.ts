// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/portfolio-window`
 * Purpose: Canonical cutoff semantics for every portfolio time-window preset.
 * Scope: Pure UTC date arithmetic. No I/O, cache, or wall-clock reads.
 * Invariants:
 *   - ONE_WINDOW_SEMANTIC: P/L history and closed-position history use the
 *     same 1D/1W/1M/1Y/YTD/ALL cutoff.
 *   - SNAPSHOT_RELATIVE: rolling windows are relative to the coherent
 *     snapshot cutoff supplied by the caller, never an independent Date.now().
 *   - YTD_IS_UTC: YTD begins at 00:00:00 UTC on January 1.
 * Side-effects: none
 * @internal
 */

import type { PolyWalletOverviewInterval } from "@cogni/poly-node-contracts";

/** Return the inclusive start of a portfolio window, or null for ALL/invalid. */
export function portfolioWindowStart(
  interval: PolyWalletOverviewInterval,
  capturedAt: string | Date
): Date | null {
  if (interval === "ALL") return null;

  const capturedAtMs = new Date(capturedAt).getTime();
  if (!Number.isFinite(capturedAtMs)) return null;

  switch (interval) {
    case "1D":
      return new Date(capturedAtMs - 86_400_000);
    case "1W":
      return new Date(capturedAtMs - 7 * 86_400_000);
    case "1M":
      return new Date(capturedAtMs - 30 * 86_400_000);
    case "1Y":
      return new Date(capturedAtMs - 365 * 86_400_000);
    case "YTD": {
      const captured = new Date(capturedAtMs);
      return new Date(Date.UTC(captured.getUTCFullYear(), 0, 1));
    }
  }
}

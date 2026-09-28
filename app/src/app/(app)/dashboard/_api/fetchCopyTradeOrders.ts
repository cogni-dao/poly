// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/_api/fetchCopyTradeOrders`
 * Purpose: Client fetcher for the copy-trade order ledger — every mirror placement
 *          attempt and, crucially, why the failed ones failed.
 * Scope: Data fetching only. Returns the route contract payload as-is.
 * Invariants:
 *   - LEDGER_HAS_NO_UI_UNTIL_NOW (bug.5279): `/api/v1/poly/copy-trade/orders` has
 *     existed and served correctly for this node's whole life with ZERO callers, so
 *     placement failures were only visible by querying Loki. Do not remove this
 *     fetcher without replacing the surface.
 * Side-effects: IO (HTTP fetch)
 * @public
 */

import type { PolyCopyTradeOrdersOutput } from "@cogni/poly-node-contracts";

export async function fetchCopyTradeOrders(opts?: {
  limit?: number;
}): Promise<PolyCopyTradeOrdersOutput> {
  const searchParams = new URLSearchParams();
  if (opts?.limit !== undefined) searchParams.set("limit", String(opts.limit));
  const url = `/api/v1/poly/copy-trade/orders${
    searchParams.size > 0 ? `?${searchParams.toString()}` : ""
  }`;
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch copy-trade orders: ${response.status} ${response.statusText}`
    );
  }
  return (await response.json()) as PolyCopyTradeOrdersOutput;
}

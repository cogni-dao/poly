// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  type PolyAccountPortfolioSnapshotOutput,
  PolyAccountPortfolioSnapshotOutputSchema,
  type PolyWalletOverviewInterval,
} from "@cogni/poly-node-contracts";

export async function fetchWalletDashboard(
  interval: PolyWalletOverviewInterval
): Promise<PolyAccountPortfolioSnapshotOutput> {
  const response = await fetch(
    `/api/v1/poly/wallet/dashboard?interval=${encodeURIComponent(interval)}`,
    { credentials: "include", cache: "no-store" }
  );
  if (!response.ok) {
    throw new Error(`wallet dashboard failed: ${response.status}`);
  }
  return PolyAccountPortfolioSnapshotOutputSchema.parse(await response.json());
}

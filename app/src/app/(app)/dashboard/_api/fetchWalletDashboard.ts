// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  type PolyWalletDashboardOutput,
  PolyWalletDashboardOutputSchema,
  type PolyWalletOverviewInterval,
} from "@cogni/poly-node-contracts";

export async function fetchWalletDashboard(
  interval: PolyWalletOverviewInterval
): Promise<PolyWalletDashboardOutput> {
  const response = await fetch(
    `/api/v1/poly/wallet/dashboard?interval=${encodeURIComponent(interval)}`,
    { credentials: "include", cache: "no-store" }
  );
  if (!response.ok) {
    throw new Error(`wallet dashboard failed: ${response.status}`);
  }
  return PolyWalletDashboardOutputSchema.parse(await response.json());
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/_components/markets-table/MarketsDeltaDistribution`
 * Purpose: Per-event-group |Δ| histogram for the Markets tab. Thin
 *   adapter over `DeltaDistribution` — flattens the filtered `groups`
 *   into abs-percentage values (cost-basis-weighted blend per group).
 * Scope: Pure client component. No fetch.
 * Invariants:
 *   - REACTS_TO_FILTER: bins live or closed groups according to the
 *     parent panel's `statusFilter`. The dashboard's Live/Closed toggle
 *     is the single source of truth.
 *   - FINITE_VALUES_ONLY: malformed deltas are omitted without hiding the
 *     histogram or suppressing other valid saved values.
 * Side-effects: none
 * @public
 */

"use client";

import type {
  WalletExecutionMarketGroup,
  WalletExecutionMarketLineStatus,
} from "@cogni/poly-node-contracts";
import type { ReactElement } from "react";
import { useMemo } from "react";

import { DeltaDistribution } from "./DeltaDistribution";

export type MarketsDeltaDistributionProps = {
  groups?: readonly WalletExecutionMarketGroup[] | undefined;
  statusFilter: WalletExecutionMarketLineStatus;
};

export function marketDeltaValues(
  groups: readonly WalletExecutionMarketGroup[],
  statusFilter: WalletExecutionMarketLineStatus
): number[] {
  return groups
    .filter((group) => group.status === statusFilter)
    .filter(
      (group): group is WalletExecutionMarketGroup & { edgeGapPct: number } =>
        group.edgeGapPct !== null && Number.isFinite(group.edgeGapPct)
    )
    .map((group) => Math.abs(group.edgeGapPct * 100));
}

export function MarketsDeltaDistribution({
  groups,
  statusFilter,
}: MarketsDeltaDistributionProps): ReactElement {
  const absDeltaPcts = useMemo(
    () => marketDeltaValues(groups ?? [], statusFilter),
    [groups, statusFilter]
  );

  return (
    <DeltaDistribution absDeltaPcts={absDeltaPcts} subtitle={statusFilter} />
  );
}

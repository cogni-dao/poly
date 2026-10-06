// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/_components/markets-table/PositionsDeltaDistribution`
 * Purpose: Per-position |Δ| histogram for the Open Positions and History
 *   tabs. Cardinality differs from `MarketsDeltaDistribution` — one item
 *   per position (held by us) rather than one per event-group rollup.
 *   Each position is joined to the per-condition `WalletExecutionMarketLine`
 *   by `conditionId`; that line carries the line-level `edgeGapPct`
 *   (`targetReturnPct − ourReturnPct`, fractional).
 * Scope: Pure client component. No fetch — caller passes both `positions`
 *   and `groups` (already in dashboard state).
 * Invariants:
 *   - JOIN_BY_NORMALIZED_CONDITION_ID: both sides of the UI join are
 *     lowercased; missing comparisons remain visible through backend coverage.
 *   - DUPLICATE_ID_FAILS_CLOSED: duplicate normalized line identities suppress
 *     the histogram instead of letting Map overwrite pick a winner.
 *   - STATUS_AT_LINE: line `status` ("live" | "closed") drives the
 *     filter, not position lifecycle. The Open tab passes `live`,
 *     History passes `closed`.
 *   - ABSOLUTE_VALUE: bins on `Math.abs(edgeGapPct)`. Sign asymmetry is
 *     a follow-up; v0 is variance-from-target.
 * Side-effects: none
 * @public
 */

"use client";

import type {
  WalletDashboardComparisonCoverageLeaf,
  WalletExecutionMarketGroup,
  WalletExecutionMarketLineStatus,
} from "@cogni/poly-node-contracts";
import type { ReactElement } from "react";
import { useMemo } from "react";

import type { WalletPosition } from "@/features/wallet-analysis";

import { DeltaDistribution } from "./DeltaDistribution";

export type PositionsDeltaDistributionProps = {
  positions?: readonly WalletPosition[] | undefined;
  groups?: readonly WalletExecutionMarketGroup[] | undefined;
  /** Drives both the line-status filter and the displayed subtitle. */
  statusFilter: WalletExecutionMarketLineStatus;
  coverage: WalletDashboardComparisonCoverageLeaf;
};

function normalizeConditionId(conditionId: string): string {
  return conditionId.toLowerCase();
}

export function PositionsDeltaDistribution({
  positions,
  groups,
  statusFilter,
  coverage,
}: PositionsDeltaDistributionProps): ReactElement | null {
  const { absDeltaPcts, identityAmbiguous } = useMemo(() => {
    const lineByCondition = new Map<
      string,
      | { kind: "line"; edgeGapPct: number | null }
      | { kind: "ambiguous" }
    >();
    let hasAmbiguousIdentity = false;
    for (const g of groups ?? []) {
      for (const line of g.lines) {
        if (line.status !== statusFilter) continue;
        const key = normalizeConditionId(line.conditionId);
        if (lineByCondition.has(key)) {
          lineByCondition.set(key, { kind: "ambiguous" });
          hasAmbiguousIdentity = true;
          continue;
        }
        lineByCondition.set(key, { kind: "line", edgeGapPct: line.edgeGapPct });
      }
    }
    const out: number[] = [];
    for (const p of positions ?? []) {
      const line = lineByCondition.get(normalizeConditionId(p.conditionId));
      if (!line) continue;
      if (line.kind === "ambiguous") {
        continue;
      }
      if (line.edgeGapPct === null || !Number.isFinite(line.edgeGapPct)) continue;
      out.push(Math.abs(line.edgeGapPct * 100));
    }
    return {
      absDeltaPcts: out,
      identityAmbiguous: hasAmbiguousIdentity,
    };
  }, [positions, groups, statusFilter]);

  return (
    <DeltaDistribution
      absDeltaPcts={absDeltaPcts}
      subtitle={statusFilter}
      coverage={coverage}
      entityLabel="positions"
      integrityReasons={identityAmbiguous ? ["identity_ambiguous"] : []}
    />
  );
}

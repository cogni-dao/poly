// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `dashboard-delta-coverage`
 * Purpose: Pure validation and canonical input projection for dashboard delta
 *   coverage. The smart container remains the rendering authority.
 * Scope: Pure functions over bounded API payloads; no React and no IO.
 * Invariants:
 *   - BACKEND_OWNS_COUNTS: full-population counts are accepted, never inferred.
 *   - NORMALIZE_BOTH_SIDES: position and line condition IDs share one casing.
 *   - DUPLICATE_IDENTITIES_FAIL_CLOSED: no Map overwrite selects a winner.
 * Side-effects: none
 * @internal
 */

import type {
  WalletDashboardComparisonCoverageLeaf,
  WalletDashboardComparisonCoverageReason,
  WalletExecutionMarketGroup,
  WalletExecutionMarketLineStatus,
} from "@cogni/poly-node-contracts";

import type { WalletPosition } from "@/features/wallet-analysis";

export type DeltaCoverageCounts = {
  eligible: number;
  comparable: number;
  dropped: number;
  sampled: number;
};

export type DeltaCoverageState =
  | {
      kind: "unavailable";
      counts: DeltaCoverageCounts | null;
      reasons: readonly WalletDashboardComparisonCoverageReason[];
      invalid: boolean;
    }
  | {
      kind: "empty" | "complete" | "partial";
      counts: DeltaCoverageCounts;
      reasons: readonly WalletDashboardComparisonCoverageReason[];
      suppressChart: boolean;
      invalid: false;
    };

const REASON_COPY: Readonly<
  Record<WalletDashboardComparisonCoverageReason, string>
> = {
  comparison_missing:
    "Some eligible rows are missing a comparable target-versus-us delta.",
  preview_truncated: "The chart uses a bounded preview.",
  source_unavailable: "The comparison source is unavailable.",
  source_incomplete: "The comparison source is stale or incomplete.",
  identity_ambiguous:
    "Duplicate wallet or market identities made this comparison ambiguous.",
};

function uniqueReasons(
  reasons: readonly WalletDashboardComparisonCoverageReason[],
  identityAmbiguous: boolean
): readonly WalletDashboardComparisonCoverageReason[] {
  return [
    ...new Set([
      ...reasons,
      ...(identityAmbiguous ? (["identity_ambiguous"] as const) : []),
    ]),
  ];
}

export function comparisonCoverageReasonText(
  reasons: readonly WalletDashboardComparisonCoverageReason[]
): string {
  return reasons.map((reason) => REASON_COPY[reason]).join(" ");
}

export function resolveDeltaCoverageState(args: {
  coverage?: WalletDashboardComparisonCoverageLeaf | undefined;
  sampleCount: number;
  identityAmbiguous?: boolean | undefined;
  inputInvalid?: boolean | undefined;
}): DeltaCoverageState {
  const {
    coverage,
    sampleCount,
    identityAmbiguous = false,
    inputInvalid = false,
  } = args;
  if (!coverage) {
    return {
      kind: "unavailable",
      counts: null,
      reasons: ["source_unavailable"],
      invalid: false,
    };
  }

  const reasons = uniqueReasons(coverage.reasons, identityAmbiguous);
  const rawCounts = [
    coverage.eligible,
    coverage.comparable,
    coverage.dropped,
    coverage.sampled,
  ];
  const allNull = rawCounts.every((value) => value === null);
  if (allNull) {
    const validUnavailable =
      !coverage.complete && reasons.includes("source_unavailable");
    return {
      kind: "unavailable",
      counts: null,
      reasons,
      invalid: !validUnavailable,
    };
  }

  const allNonnegativeIntegers = rawCounts.every(
    (value) =>
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
  );
  if (!allNonnegativeIntegers) {
    return { kind: "unavailable", counts: null, reasons, invalid: true };
  }

  const counts = {
    eligible: coverage.eligible as number,
    comparable: coverage.comparable as number,
    dropped: coverage.dropped as number,
    sampled: coverage.sampled as number,
  };
  const sourceUnavailable = reasons.includes("source_unavailable");
  const sourceIncomplete = reasons.includes("source_incomplete");
  const hasIdentityAmbiguity = reasons.includes("identity_ambiguous");
  const suppressChart =
    sourceUnavailable || sourceIncomplete || hasIdentityAmbiguity;
  const expectedComplete =
    reasons.length === 0 &&
    counts.dropped === 0 &&
    counts.sampled === counts.comparable;
  const invalid =
    inputInvalid ||
    counts.eligible !== counts.comparable + counts.dropped ||
    counts.sampled > counts.comparable ||
    coverage.complete !== expectedComplete ||
    sourceUnavailable ||
    (suppressChart && counts.sampled !== 0) ||
    (!suppressChart && counts.sampled !== sampleCount);

  if (invalid || hasIdentityAmbiguity) {
    return { kind: "unavailable", counts, reasons, invalid };
  }
  if (counts.eligible === 0 && coverage.complete) {
    return {
      kind: "empty",
      counts,
      reasons,
      suppressChart: false,
      invalid: false,
    };
  }
  return {
    kind: coverage.complete ? "complete" : "partial",
    counts,
    reasons,
    suppressChart,
    invalid: false,
  };
}

export function projectMarketDeltaInput(
  groups: readonly WalletExecutionMarketGroup[],
  statusFilter: WalletExecutionMarketLineStatus
): {
  groups: readonly WalletExecutionMarketGroup[];
  sampleCount: number;
  identityAmbiguous: boolean;
  inputInvalid: boolean;
} {
  const identities = new Set<string>();
  let identityAmbiguous = false;
  let inputInvalid = false;
  let sampleCount = 0;
  const safeGroups = groups.map((group) => {
    if (
      group.status === statusFilter &&
      group.edgeGapPct !== null &&
      !Number.isFinite(group.edgeGapPct)
    ) {
      inputInvalid = true;
    }
    const edgeGapPct =
      group.edgeGapPct !== null && Number.isFinite(group.edgeGapPct)
        ? group.edgeGapPct
        : null;
    if (group.status === statusFilter) {
      const identity = group.groupKey.toLowerCase();
      if (identities.has(identity)) identityAmbiguous = true;
      identities.add(identity);
      if (edgeGapPct !== null) sampleCount += 1;
    }
    return { ...group, edgeGapPct };
  });
  return { groups: safeGroups, sampleCount, identityAmbiguous, inputInvalid };
}

export function projectPositionDeltaInput(
  positions: readonly WalletPosition[],
  groups: readonly WalletExecutionMarketGroup[],
  statusFilter: WalletExecutionMarketLineStatus
): {
  positions: readonly WalletPosition[];
  groups: readonly WalletExecutionMarketGroup[];
  sampleCount: number;
  identityAmbiguous: boolean;
  inputInvalid: boolean;
} {
  const lineByCondition = new Map<
    string,
    | { status: WalletExecutionMarketLineStatus; edgeGapPct: number | null }
    | null
  >();
  let identityAmbiguous = false;
  let inputInvalid = false;
  const normalizedGroups = groups.map((group) => ({
    ...group,
    lines: group.lines
      .filter((line) => line.status === statusFilter)
      .map((line) => {
        const conditionId = line.conditionId.toLowerCase();
        if (line.edgeGapPct !== null && !Number.isFinite(line.edgeGapPct)) {
          inputInvalid = true;
        }
        const edgeGapPct =
          line.edgeGapPct !== null && Number.isFinite(line.edgeGapPct)
            ? line.edgeGapPct
            : null;
        if (lineByCondition.has(conditionId)) {
          lineByCondition.set(conditionId, null);
          identityAmbiguous = true;
        } else {
          lineByCondition.set(conditionId, {
            status: line.status,
            edgeGapPct,
          });
        }
        return { ...line, conditionId, edgeGapPct };
      }),
  }));
  const positionIdentities = new Set<string>();
  const normalizedPositions = positions.map((position) => {
    const conditionId = position.conditionId.toLowerCase();
    const identity = `${conditionId}\u0000${position.asset}`;
    if (positionIdentities.has(identity)) identityAmbiguous = true;
    positionIdentities.add(identity);
    return { ...position, conditionId };
  });
  const sampleCount = normalizedPositions.filter((position) => {
    const line = lineByCondition.get(position.conditionId);
    return (
      line !== undefined &&
      line !== null &&
      line.status === statusFilter &&
      line.edgeGapPct !== null &&
      Number.isFinite(line.edgeGapPct)
    );
  }).length;

  return {
    positions: normalizedPositions,
    groups: normalizedGroups,
    sampleCount,
    identityAmbiguous,
    inputInvalid,
  };
}

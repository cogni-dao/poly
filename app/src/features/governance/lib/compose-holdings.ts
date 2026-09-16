// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/lib/compose-holdings`
 * Purpose: Aggregates finalized claimant attribution across epochs into cumulative holdings.
 * Scope: Pure function. Does not perform IO or access external services.
 * Invariants:
 *   - ALL_MATH_BIGINT: credit values stay bigint until serialized into the view model
 *   - CANONICAL_OWNER_IDENTITY: aggregation and deterministic ties use canonicalOwnerKey
 *   - Source of truth is finalized claimant attribution (not mutable allocations)
 * Side-effects: none
 * Links: src/features/governance/types.ts
 * @public
 */

import type { HoldingsData, HoldingView } from "@/features/governance/types";

import type { EpochClaimantsDto, EpochDto } from "./compose-epoch";

export function composeHoldings(
  epochs: readonly EpochDto[],
  claimants: readonly EpochClaimantsDto[]
): HoldingsData {
  const ownerMap = new Map<
    string,
    {
      canonicalOwnerKey: string;
      claimantKind: "user" | "identity";
      isLinked: boolean;
      displayName: string | null;
      totalCredits: bigint;
      epochs: Set<string>;
    }
  >();

  let totalCreditsAll = 0n;

  for (let i = 0; i < epochs.length; i++) {
    const epoch = epochs[i];
    const epochClaimants = claimants[i];
    if (!epoch || !epochClaimants) continue;

    for (const item of epochClaimants.items) {
      const credits = BigInt(item.amountCredits);
      const ownerKind = item.canonicalOwnerKey.startsWith("user:")
        ? "user"
        : item.claimant.kind;
      totalCreditsAll += credits;

      const existing = ownerMap.get(item.canonicalOwnerKey);
      if (existing) {
        existing.totalCredits += credits;
        existing.epochs.add(epoch.id);
        if (!existing.displayName && item.displayName) {
          existing.displayName = item.displayName;
        }
        existing.isLinked = existing.isLinked || item.isLinked;
        if (ownerKind === "user") {
          existing.claimantKind = "user";
        }
      } else {
        ownerMap.set(item.canonicalOwnerKey, {
          canonicalOwnerKey: item.canonicalOwnerKey,
          claimantKind: ownerKind,
          isLinked: item.isLinked,
          displayName: item.displayName,
          totalCredits: credits,
          epochs: new Set([epoch.id]),
        });
      }
    }
  }

  const holdings: HoldingView[] = [...ownerMap.values()]
    .sort((a, b) => {
      if (a.totalCredits !== b.totalCredits) {
        return a.totalCredits > b.totalCredits ? -1 : 1;
      }
      return a.canonicalOwnerKey.localeCompare(b.canonicalOwnerKey);
    })
    .map((entry) => ({
      canonicalOwnerKey: entry.canonicalOwnerKey,
      claimantKind: entry.claimantKind,
      isLinked: entry.isLinked,
      displayName: entry.displayName,
      claimantLabel: entry.isLinked ? "Linked account" : "Unlinked account",
      totalCredits: entry.totalCredits.toString(),
      ownershipPercent:
        totalCreditsAll > 0n
          ? Number(
              (entry.totalCredits * 1000n + totalCreditsAll / 2n) /
                totalCreditsAll
            ) / 10
          : 0,
      epochsContributed: entry.epochs.size,
    }));

  return {
    holdings,
    totalCreditsIssued: totalCreditsAll.toString(),
    totalContributors: holdings.length,
    epochsCompleted: claimants.length,
  };
}

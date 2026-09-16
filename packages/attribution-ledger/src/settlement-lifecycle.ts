// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/settlement-lifecycle`
 * Purpose: Derives per-epoch settlement and publication coverage from persisted liabilities and chain-matched revisions.
 * Scope: Pure read-model derivation only. Does not read databases or chains and does not mutate settlement state.
 * Invariants: REVISION_SEQUENCE_COVERAGE, UNKNOWN_PUBLICATION_FAILS_CLOSED, ALL_MATH_BIGINT.
 * Side-effects: none
 * Links: packages/attribution-ledger/src/store.ts
 * @public
 */

import type {
  AttributionEpoch,
  ClaimantLiabilityLifecycleRecord,
  SettlementRevisionRecord,
} from "./store";

export type PublicationEvidence = "matched" | "not_published" | "unknown";

export interface EpochSettlementLifecycle {
  readonly epochId: bigint;
  readonly liabilityCount: number;
  readonly settledLiabilityCount: number;
  readonly publishedLiabilityCount: number | null;
}

export interface SettlementLifecycle {
  readonly publicationEvidence: PublicationEvidence;
  readonly liveRevision: SettlementRevisionRecord | null;
  readonly latestRevision: SettlementRevisionRecord | null;
  readonly epochs: readonly EpochSettlementLifecycle[];
}

export interface DeriveSettlementLifecycleParams {
  readonly epochs: readonly AttributionEpoch[];
  readonly liabilities: readonly ClaimantLiabilityLifecycleRecord[];
  readonly latestRevision: SettlementRevisionRecord | null;
  readonly publicationEvidence: PublicationEvidence;
  readonly liveRevision: SettlementRevisionRecord | null;
}

/** Build the lifecycle read model without inferring publication from epoch order. */
export function deriveSettlementLifecycle(
  params: DeriveSettlementLifecycleParams
): SettlementLifecycle {
  const liveSequence =
    params.publicationEvidence === "matched"
      ? (params.liveRevision?.sequence ?? null)
      : null;
  const publicationKnown = params.publicationEvidence !== "unknown";
  const countsByEpoch = new Map<
    bigint,
    {
      liabilityCount: number;
      settledLiabilityCount: number;
      publishedLiabilityCount: number;
    }
  >();

  for (const liability of params.liabilities) {
    const counts = countsByEpoch.get(liability.sourceEpochId) ?? {
      liabilityCount: 0,
      settledLiabilityCount: 0,
      publishedLiabilityCount: 0,
    };
    counts.liabilityCount += 1;
    if (liability.settledRevisionSequence !== null) {
      counts.settledLiabilityCount += 1;
      if (
        liveSequence !== null &&
        liability.settledRevisionSequence <= liveSequence
      ) {
        counts.publishedLiabilityCount += 1;
      }
    }
    countsByEpoch.set(liability.sourceEpochId, counts);
  }

  return {
    publicationEvidence: params.publicationEvidence,
    liveRevision:
      params.publicationEvidence === "matched" ? params.liveRevision : null,
    latestRevision: params.latestRevision,
    epochs: params.epochs.map((epoch) => {
      const counts = countsByEpoch.get(epoch.id) ?? {
        liabilityCount: 0,
        settledLiabilityCount: 0,
        publishedLiabilityCount: 0,
      };
      const publishedLiabilityCount = !publicationKnown
        ? null
        : counts.publishedLiabilityCount;

      return {
        epochId: epoch.id,
        liabilityCount: counts.liabilityCount,
        settledLiabilityCount: counts.settledLiabilityCount,
        publishedLiabilityCount,
      };
    }),
  };
}

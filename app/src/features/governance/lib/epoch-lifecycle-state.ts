// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/governance/lib/epoch-lifecycle-state`
 * Purpose: Derive five human epoch checkpoints from protocol state and settlement evidence.
 * Scope: Pure governance view-model logic. No React, time reads, or IO.
 * Invariants: ZERO_LIABILITY_UNAVAILABLE, UNKNOWN_NEVER_COMPLETE, CLAIMS_REQUIRE_PROVEN_LIVE_ALLOCATION.
 * Side-effects: none
 * Links: packages/node-contracts/src/attribution.settlement-lifecycle.v1.contract.ts, task.5039
 * @public
 */

import type { EpochView } from "@/features/governance/types";

export type EpochCheckpointState =
  | "complete"
  | "current"
  | "locked"
  | "unavailable"
  | "unknown";

export interface EpochCheckpoint {
  readonly id: "collect" | "review" | "finalize" | "publish" | "claim";
  readonly label: string;
  readonly state: EpochCheckpointState;
  readonly description: string;
}

export interface EpochSettlementLifecycleEvidence {
  readonly epochId: string;
  readonly liabilityCount: number;
  readonly settledLiabilityCount: number;
  readonly publishedLiabilityCount: number | null;
}

export interface SettlementLifecycleEvidence {
  readonly publicationEvidence: "matched" | "not_published" | "unknown";
  readonly liveRevision: {
    readonly sequence: string;
    readonly merkleRoot: string;
    readonly cumulativeTotal: string;
  } | null;
  readonly latestRevision: {
    readonly sequence: string;
    readonly merkleRoot: string;
    readonly cumulativeTotal: string;
  } | null;
  readonly epochs: readonly EpochSettlementLifecycleEvidence[];
}

export const UNKNOWN_SETTLEMENT_LIFECYCLE: SettlementLifecycleEvidence = {
  publicationEvidence: "unknown",
  liveRevision: null,
  latestRevision: null,
  epochs: [],
};

export interface EpochLifecycleView {
  readonly steps: readonly EpochCheckpoint[];
  readonly publishDetail: string;
}

const completeCollect: EpochCheckpoint = {
  id: "collect",
  label: "Collect",
  state: "complete",
  description: "Contribution collection is closed.",
};

const lockedFinalize: EpochCheckpoint = {
  id: "finalize",
  label: "Finalize",
  state: "locked",
  description: "Requires a completed review and approver signature.",
};

function unavailableSettlementSteps(): readonly [
  EpochCheckpoint,
  EpochCheckpoint,
] {
  return [
    {
      id: "publish",
      label: "Publish",
      state: "unavailable",
      description: "This epoch has no claimant allocations to publish.",
    },
    {
      id: "claim",
      label: "Claims open",
      state: "unavailable",
      description: "This epoch has no claimant allocations to claim.",
    },
  ];
}

function lockedSettlementSteps(): readonly [EpochCheckpoint, EpochCheckpoint] {
  return [
    {
      id: "publish",
      label: "Publish",
      state: "locked",
      description: "Requires a finalized cumulative settlement.",
    },
    {
      id: "claim",
      label: "Claims open",
      state: "locked",
      description: "Requires at least one allocation proven live on-chain.",
    },
  ];
}

function deriveFinalizedSettlement(
  lifecycle: SettlementLifecycleEvidence,
  epochEvidence: EpochSettlementLifecycleEvidence | undefined
): {
  readonly publish: EpochCheckpoint;
  readonly claim: EpochCheckpoint;
  readonly detail: string;
} {
  if (!epochEvidence) {
    return {
      publish: {
        id: "publish",
        label: "Publish",
        state: "unknown",
        description: "Settlement coverage for this epoch is unavailable.",
      },
      claim: {
        id: "claim",
        label: "Claims open",
        state: "unknown",
        description: "Claim availability cannot be verified.",
      },
      detail: "Settlement and publication coverage could not be verified.",
    };
  }

  const { liabilityCount, settledLiabilityCount, publishedLiabilityCount } =
    epochEvidence;
  if (liabilityCount === 0) {
    const [publish, claim] = unavailableSettlementSteps();
    return {
      publish,
      claim,
      detail: "No claimant allocations for this epoch.",
    };
  }

  const settled = Math.min(settledLiabilityCount, liabilityCount);
  if (
    lifecycle.publicationEvidence === "unknown" ||
    publishedLiabilityCount === null
  ) {
    const detail = `${settled} of ${liabilityCount} allocations settled · published count unknown`;
    return {
      publish: {
        id: "publish",
        label: "Publish",
        state: "unknown",
        description: detail,
      },
      claim: {
        id: "claim",
        label: "Claims open",
        state: "unknown",
        description: "On-chain claim availability could not be verified.",
      },
      detail,
    };
  }

  const live = Math.min(publishedLiabilityCount, liabilityCount);
  const detail =
    `${settled} of ${liabilityCount} allocations settled · ` +
    `${live} of ${liabilityCount} published on-chain`;
  const allPublished = live >= liabilityCount;
  const anyPublished = live > 0;
  return {
    publish: {
      id: "publish",
      label: "Publish",
      state: allPublished ? "complete" : "current",
      description: detail,
    },
    claim: {
      id: "claim",
      label: "Claims open",
      state: anyPublished ? "current" : "locked",
      description: anyPublished
        ? `${live} allocation${live === 1 ? " is" : "s are"} proven live and claimable.`
        : "Claims open when at least one allocation is proven live.",
    },
    detail,
  };
}

export function deriveEpochLifecycle(
  epoch: Pick<EpochView, "id" | "status">,
  lifecycle: SettlementLifecycleEvidence,
  periodEnded: boolean
): EpochLifecycleView {
  const epochEvidence = lifecycle.epochs.find(
    (candidate) => candidate.epochId === epoch.id
  );
  const noLiabilities = epochEvidence?.liabilityCount === 0;
  const [publishBeforeFinalization, claimBeforeFinalization] = noLiabilities
    ? unavailableSettlementSteps()
    : lockedSettlementSteps();
  const publishDetail = noLiabilities
    ? "No claimant allocations for this epoch."
    : "Settlement preparation begins after finalization.";

  if (epoch.status === "open") {
    return {
      publishDetail,
      steps: [
        {
          id: "collect",
          label: "Collect",
          state: periodEnded ? "complete" : "current",
          description: periodEnded
            ? "The contribution window has ended."
            : "Contributions are being collected.",
        },
        {
          id: "review",
          label: "Review",
          state: periodEnded ? "current" : "locked",
          description: periodEnded
            ? "Ready for an approver to open review."
            : "Available when the contribution window ends.",
        },
        lockedFinalize,
        publishBeforeFinalization,
        claimBeforeFinalization,
      ],
    };
  }

  if (epoch.status === "review") {
    return {
      publishDetail,
      steps: [
        completeCollect,
        {
          id: "review",
          label: "Review",
          state: "current",
          description: "Contributions are being reviewed before finalization.",
        },
        lockedFinalize,
        publishBeforeFinalization,
        claimBeforeFinalization,
      ],
    };
  }

  const settlement = deriveFinalizedSettlement(lifecycle, epochEvidence);
  return {
    publishDetail: settlement.detail,
    steps: [
      completeCollect,
      {
        id: "review",
        label: "Review",
        state: "complete",
        description: "The contribution set was reviewed and locked.",
      },
      {
        id: "finalize",
        label: "Finalize",
        state: "complete",
        description: "The signed epoch statement is finalized.",
      },
      settlement.publish,
      settlement.claim,
    ],
  };
}

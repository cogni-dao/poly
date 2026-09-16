// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/attribution-ledger/settlement-lifecycle`
 * Purpose: Proves per-epoch settlement and publication counts follow settlement revision sequence.
 * Scope: Pure read-model tests only. Does not access a database or chain.
 * Invariants: REVISION_SEQUENCE_COVERAGE, UNKNOWN_PUBLICATION_FAILS_CLOSED.
 * Side-effects: none
 * Links: packages/attribution-ledger/src/settlement-lifecycle.ts
 * @public
 */

import {
  type AttributionEpoch,
  type ClaimantLiabilityLifecycleRecord,
  deriveSettlementLifecycle,
  type SettlementRevisionRecord,
} from "@cogni/attribution-ledger";
import { describe, expect, it } from "vitest";

const NODE_ID = "00000000-0000-4000-a000-000000000001";

function epoch(id: bigint): AttributionEpoch {
  return {
    id,
    nodeId: NODE_ID,
    scopeId: "default",
    status: "finalized",
    periodStart: new Date("2026-08-01T00:00:00Z"),
    periodEnd: new Date("2026-08-08T00:00:00Z"),
    weightConfig: {},
    poolTotalCredits: 100n,
    approverSetHash: "approvers",
    approvers: ["0x1111111111111111111111111111111111111111"],
    allocationAlgoRef: "weight-sum-v0",
    weightConfigHash: "weights",
    artifactsHash: "artifacts",
    openedAt: new Date("2026-08-01T00:00:00Z"),
    closedAt: new Date("2026-08-08T00:00:00Z"),
    createdAt: new Date("2026-08-01T00:00:00Z"),
  };
}

function liability(
  id: string,
  sourceEpochId: bigint,
  settledRevisionSequence: bigint | null
): ClaimantLiabilityLifecycleRecord {
  return {
    id,
    nodeId: NODE_ID,
    scopeId: "default",
    sourceEpochId,
    statementId: `statement-${sourceEpochId}`,
    claimantKey: `user:${id}`,
    amountAtomic: 100n,
    receiptIds: [`receipt-${id}`],
    settledRevisionId:
      settledRevisionSequence === null ? null : `r${settledRevisionSequence}`,
    settledRevisionSequence,
    createdAt: new Date("2026-08-08T00:00:00Z"),
  };
}

function revision(sequence: bigint): SettlementRevisionRecord {
  return {
    id: `r${sequence}`,
    nodeId: NODE_ID,
    scopeId: "default",
    sequence,
    previousRevisionId: sequence === 1n ? null : `r${sequence - 1n}`,
    previousMerkleRoot: null,
    distributionId: `distribution-${sequence}`,
    statementHash: `statement-${sequence}`,
    merkleRoot: `root-${sequence}`,
    chainId: 8453,
    tokenAddress: "0x2222222222222222222222222222222222222222",
    distributorAddress: "0x3333333333333333333333333333333333333333",
    mintDelta: 100n,
    cumulativeTotal: sequence * 100n,
    triggerKind: "epoch_finalize",
    triggerRef: sequence.toString(),
    createdAt: new Date("2026-08-08T00:00:00Z"),
  };
}

describe("deriveSettlementLifecycle", () => {
  const epochs = [epoch(1n), epoch(2n), epoch(3n)];
  const liabilities = [
    liability("one", 1n, 1n),
    liability("two", 2n, 2n),
    liability("pending", 2n, null),
  ];

  it("counts publication by live revision sequence, including zero-liability epochs", () => {
    const result = deriveSettlementLifecycle({
      epochs,
      liabilities,
      latestRevision: revision(2n),
      publicationEvidence: "matched",
      liveRevision: revision(1n),
    });

    expect(result.epochs).toEqual([
      {
        epochId: 1n,
        liabilityCount: 1,
        settledLiabilityCount: 1,
        publishedLiabilityCount: 1,
      },
      {
        epochId: 2n,
        liabilityCount: 2,
        settledLiabilityCount: 1,
        publishedLiabilityCount: 0,
      },
      {
        epochId: 3n,
        liabilityCount: 0,
        settledLiabilityCount: 0,
        publishedLiabilityCount: 0,
      },
    ]);
  });

  it("reports known zero publication for the on-chain zero root", () => {
    const result = deriveSettlementLifecycle({
      epochs,
      liabilities,
      latestRevision: revision(2n),
      publicationEvidence: "not_published",
      liveRevision: null,
    });

    expect(result.liveRevision).toBeNull();
    expect(result.epochs.map((item) => item.publishedLiabilityCount)).toEqual([
      0, 0, 0,
    ]);
  });

  it("fails closed when publication evidence is unknown", () => {
    const result = deriveSettlementLifecycle({
      epochs,
      liabilities,
      latestRevision: revision(2n),
      publicationEvidence: "unknown",
      liveRevision: null,
    });

    expect(result.liveRevision).toBeNull();
    expect(result.epochs.map((item) => item.publishedLiabilityCount)).toEqual([
      null,
      null,
      null,
    ]);
  });
});

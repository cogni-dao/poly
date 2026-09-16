// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `epoch-lifecycle-state.test`
 * Purpose: Lock the honest mapping from epoch, settlement, and chain evidence to five checkpoints.
 * Scope: Pure table-driven state tests; no React, IO, time, or adapters.
 * Invariants: ZERO_LIABILITY_UNAVAILABLE, UNKNOWN_NEVER_COMPLETE, PARTIAL_PUBLICATION_OPENS_CLAIMS.
 * Side-effects: none
 * Links: src/features/governance/lib/epoch-lifecycle-state.ts, task.5039
 */

import { describe, expect, it } from "vitest";

import {
  deriveEpochLifecycle,
  type SettlementLifecycleEvidence,
} from "@/features/governance/lib/epoch-lifecycle-state";
import type { EpochView } from "@/features/governance/types";

const EMPTY: SettlementLifecycleEvidence = {
  publicationEvidence: "not_published",
  liveRevision: null,
  latestRevision: null,
  epochs: [],
};

function epoch(id: string, status: EpochView["status"]): EpochView {
  return {
    id,
    status,
    periodStart: "2026-08-10T00:00:00.000Z",
    periodEnd: "2026-08-17T00:00:00.000Z",
    poolTotalCredits: status === "finalized" ? "100" : null,
    approvers: status === "open" ? null : ["0xapprover"],
    contributors: [],
    unresolvedCount: 0,
    unresolvedActivities: [],
  };
}

function states(
  value: ReturnType<typeof deriveEpochLifecycle>
): Record<string, string> {
  return Object.fromEntries(value.steps.map((step) => [step.id, step.state]));
}

function evidence(params: {
  readonly liability: number;
  readonly settled: number;
  readonly published: number | null;
  readonly publicationEvidence?: SettlementLifecycleEvidence["publicationEvidence"];
}): SettlementLifecycleEvidence {
  return {
    ...EMPTY,
    publicationEvidence: params.publicationEvidence ?? "matched",
    epochs: [
      {
        epochId: "7",
        liabilityCount: params.liability,
        settledLiabilityCount: params.settled,
        publishedLiabilityCount: params.published,
      },
    ],
  };
}

describe("deriveEpochLifecycle", () => {
  it("moves an ended open epoch from Collect to Review", () => {
    expect(
      states(deriveEpochLifecycle(epoch("8", "open"), EMPTY, false))
    ).toMatchObject({ collect: "current", review: "locked" });
    expect(
      states(deriveEpochLifecycle(epoch("8", "open"), EMPTY, true))
    ).toMatchObject({
      collect: "complete",
      review: "current",
      finalize: "locked",
    });
  });

  it("marks zero-liability publication and claims unavailable", () => {
    const result = deriveEpochLifecycle(
      epoch("7", "finalized"),
      evidence({ liability: 0, settled: 0, published: 0 }),
      true
    );

    expect(states(result)).toMatchObject({
      finalize: "complete",
      publish: "unavailable",
      claim: "unavailable",
    });
    expect(result.publishDetail).toBe("No claimant allocations for this epoch.");
  });

  it("shows exact partial preparation and keeps claims locked before publication", () => {
    const result = deriveEpochLifecycle(
      epoch("7", "finalized"),
      evidence({ liability: 4, settled: 2, published: 0 }),
      true
    );

    expect(states(result)).toMatchObject({ publish: "current", claim: "locked" });
    expect(result.publishDetail).toBe(
      "2 of 4 allocations settled · 0 of 4 published on-chain"
    );
  });

  it("opens claims as soon as any allocation is proven live", () => {
    const result = deriveEpochLifecycle(
      epoch("7", "finalized"),
      evidence({ liability: 4, settled: 4, published: 1 }),
      true
    );

    expect(states(result)).toMatchObject({ publish: "current", claim: "current" });
    expect(result.publishDetail).toBe(
      "4 of 4 allocations settled · 1 of 4 published on-chain"
    );
  });

  it("completes Publish only when every liability is proven live", () => {
    expect(
      states(
        deriveEpochLifecycle(
          epoch("7", "finalized"),
          evidence({ liability: 4, settled: 4, published: 4 }),
          true
        )
      )
    ).toMatchObject({ publish: "complete", claim: "current" });
  });

  it("keeps Publish and Claims open unknown when chain evidence is unavailable", () => {
    const result = deriveEpochLifecycle(
      epoch("7", "finalized"),
      evidence({
        liability: 4,
        settled: 4,
        published: null,
        publicationEvidence: "unknown",
      }),
      true
    );

    expect(states(result)).toMatchObject({ publish: "unknown", claim: "unknown" });
    expect(result.publishDetail).toBe(
      "4 of 4 allocations settled · published count unknown"
    );
  });
});

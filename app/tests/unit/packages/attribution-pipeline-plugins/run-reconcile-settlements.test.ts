// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/tests/run-reconcile-settlements`
 * Purpose: Prove late-bound liabilities settle exactly once at their signed atomic amount.
 * Scope: Pure unit tests with in-memory port doubles; no database or chain.
 * Invariants: LIABILITY_AMOUNT_FIXED, SETTLEMENT_EXACTLY_ONCE, HEAD_CONFLICT_RETRY.
 * Side-effects: none
 * Links: packages/attribution-pipeline-plugins/src/settlement/run-reconcile-settlements.ts
 * @internal
 */

import {
  type ClaimantWalletResolver,
  hashCumulativeClaimLeaf,
  verifyCumulativeMerkleProof,
} from "@cogni/aragon-osx";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type RunReconcileSettlementsDeps,
  runReconcileSettlements,
} from "../../../../../packages/attribution-pipeline-plugins/src/index";

const NODE_ID = "72aa130b-f0ad-495a-a061-9ee1f9c9525d";
const SCOPE_ID = "44479543-87d0-5d3b-ac57-73a6242770cf";
const TOKEN = "0xE48d3835c75cc81B6B831fc663B91960f4d9B94a";
const DISTRIBUTOR = "0xb75d75a395BB2b1362182A9F24aD18D07A735423";
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function liability(overrides: Record<string, unknown> = {}) {
  return {
    id: "liability-1",
    nodeId: NODE_ID,
    scopeId: SCOPE_ID,
    sourceEpochId: 2n,
    statementId: "statement-2",
    claimantKey: "identity:github:42",
    amountAtomic: 7n,
    receiptIds: ["receipt-1"],
    settledRevisionId: null,
    ...overrides,
  };
}

function resolver(wallet: `0x${string}` | null): ClaimantWalletResolver {
  return {
    resolveWallets: vi.fn(async (keys: readonly string[]) =>
      keys.map((claimantKey) => ({
        claimantKey,
        userId: wallet ? "user-1" : null,
        wallet,
      }))
    ),
  };
}

function deps(
  settlementStore: object,
  walletResolver: ClaimantWalletResolver
): RunReconcileSettlementsDeps {
  return {
    settlementStore:
      settlementStore as RunReconcileSettlementsDeps["settlementStore"],
    walletResolver,
    nodeId: NODE_ID,
    scopeId: SCOPE_ID,
    chainId: 8453,
    tokenAddress: TOKEN,
    distributorAddress: DISTRIBUTOR,
    logger,
  };
}

describe("runReconcileSettlements", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps an unresolved finalized liability pending", async () => {
    const append = vi.fn();
    const store = {
      listPendingClaimantLiabilities: vi.fn().mockResolvedValue([liability()]),
      getLatestSettlementRevision: vi.fn(),
      getSettlementLeavesForRevision: vi.fn(),
      appendSettlementRevisionAtomic: append,
    };

    const result = await runReconcileSettlements(deps(store, resolver(null)), {
      kind: "epoch_finalize",
      epochId: "2",
    });

    expect(result).toEqual({
      status: "noop",
      reason: "no_resolvable_liabilities",
      pendingLiabilityCount: 1,
      unresolvedLiabilityCount: 1,
    });
    expect(append).not.toHaveBeenCalled();
  });

  it("settles the exact fixed amount once and makes a retry a no-op", async () => {
    let pending = [liability({ amountAtomic: 10_000n * 10n ** 18n })];
    const append = vi.fn(async (params) => {
      pending = [];
      return {
        status: "appended" as const,
        revision: {
          id: "revision-1",
          sequence: 1n,
          ...params,
        },
      };
    });
    const store = {
      listPendingClaimantLiabilities: vi.fn(async () => pending),
      getLatestSettlementRevision: vi.fn().mockResolvedValue(null),
      getSettlementLeavesForRevision: vi.fn(),
      appendSettlementRevisionAtomic: append,
    };
    const reconcileDeps = deps(store, resolver(WALLET));

    const first = await runReconcileSettlements(reconcileDeps, {
      kind: "identity_binding",
      eventId: "event-1",
    });
    const second = await runReconcileSettlements(reconcileDeps, {
      kind: "collect_retry",
    });

    expect(first).toMatchObject({
      status: "appended",
      mintDelta: 10_000n * 10n ** 18n,
      cumulativeTotal: 10_000n * 10n ** 18n,
      liabilityCount: 1,
      leafCount: 1,
    });
    expect(second).toMatchObject({
      status: "noop",
      reason: "no_pending_liabilities",
    });
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      expectedPreviousRevisionId: null,
      mintDelta: 10_000n * 10n ** 18n,
      cumulativeTotal: 10_000n * 10n ** 18n,
      resolutions: [
        {
          liabilityId: "liability-1",
          resolvedUserId: "user-1",
          account: WALLET,
        },
      ],
    });
    const persisted = append.mock.calls[0]?.[0];
    const leaf = persisted?.leaves[0];
    if (!persisted || !leaf) throw new Error("expected persisted leaf");
    expect(leaf.leafHash).toBe(
      hashCumulativeClaimLeaf(WALLET, 10_000n * 10n ** 18n)
    );
    expect(
      verifyCumulativeMerkleProof(
        leaf.leafHash,
        leaf.proof,
        persisted.merkleRoot
      )
    ).toBe(true);
  });

  it("rebuilds from the latest cumulative head after an append conflict", async () => {
    const priorRevision = {
      id: "revision-prior",
      sequence: 1n,
    };
    const latest = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(priorRevision);
    const append = vi
      .fn()
      .mockResolvedValueOnce({ status: "conflict" })
      .mockImplementationOnce(async (params) => ({
        status: "appended" as const,
        revision: { id: "revision-2", sequence: 2n, ...params },
      }));
    const store = {
      listPendingClaimantLiabilities: vi
        .fn()
        .mockResolvedValue([liability({ amountAtomic: 7n })]),
      getLatestSettlementRevision: latest,
      getSettlementLeavesForRevision: vi.fn().mockResolvedValue([
        {
          revisionId: "revision-prior",
          index: 0,
          claimantKey: "identity:github:7",
          account: OTHER_WALLET,
          cumulativeAmount: 5n,
          deltaAmount: 5n,
          receiptIds: [],
          leafHash: "0x00",
          proof: [],
        },
      ]),
      appendSettlementRevisionAtomic: append,
    };

    const result = await runReconcileSettlements(
      deps(store, resolver(WALLET)),
      {
        kind: "collect_retry",
      }
    );

    expect(result).toMatchObject({
      status: "appended",
      sequence: 2n,
      mintDelta: 7n,
      cumulativeTotal: 12n,
      leafCount: 2,
    });
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]?.[0]).toMatchObject({
      expectedPreviousRevisionId: "revision-prior",
      cumulativeTotal: 12n,
    });
  });

  it("preserves prior receipt lineage when revision 2 adds to the same account", async () => {
    const append = vi.fn(async (params) => ({
      status: "appended" as const,
      revision: { id: "revision-2", sequence: 2n, ...params },
    }));
    const store = {
      listPendingClaimantLiabilities: vi.fn().mockResolvedValue([
        liability({
          id: "liability-2",
          amountAtomic: 7n,
          receiptIds: ["receipt-current"],
        }),
      ]),
      getLatestSettlementRevision: vi.fn().mockResolvedValue({
        id: "revision-1",
        sequence: 1n,
      }),
      getSettlementLeavesForRevision: vi.fn().mockResolvedValue([
        {
          revisionId: "revision-1",
          index: 0,
          claimantKey: "identity:github:42",
          account: WALLET,
          cumulativeAmount: 5n,
          deltaAmount: 5n,
          receiptIds: ["receipt-prior"],
          leafHash: "0x00",
          proof: [],
        },
      ]),
      appendSettlementRevisionAtomic: append,
    };

    const result = await runReconcileSettlements(
      deps(store, resolver(WALLET)),
      {
        kind: "identity_binding",
        eventId: "event-2",
      }
    );

    expect(result).toMatchObject({
      status: "appended",
      sequence: 2n,
      mintDelta: 7n,
      cumulativeTotal: 12n,
      leafCount: 1,
    });
    expect(append.mock.calls[0]?.[0].leaves).toEqual([
      expect.objectContaining({
        account: WALLET,
        cumulativeAmount: 12n,
        deltaAmount: 7n,
        receiptIds: ["receipt-current", "receipt-prior"],
      }),
    ]);
  });
});

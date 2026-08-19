// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/tests/run-finalize-epoch-liabilities`
 * Purpose: Prove finalization hands every positive signed line to the atomic liability write.
 * Scope: Pure orchestration unit test with a port double; no database or chain.
 * Invariants: FINALIZE_MATERIALIZES_LIABILITIES, LIABILITY_AMOUNT_FIXED.
 * Side-effects: none
 * Links: packages/attribution-pipeline-plugins/src/finalize/run-finalize-epoch.ts
 * @internal
 */

import {
  type AttributionEpoch,
  type AttributionStore,
  computeApproverSetHash,
} from "@cogni/attribution-ledger";
import { verifyTypedData } from "viem";
import { describe, expect, it, vi } from "vitest";

vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  verifyTypedData: vi.fn(),
}));

import {
  createDefaultRegistries,
  runFinalizeEpoch,
} from "../../../../../packages/attribution-pipeline-plugins/src/index";

const NODE_ID = "72aa130b-f0ad-495a-a061-9ee1f9c9525d";
const SCOPE_ID = "44479543-87d0-5d3b-ac57-73a6242770cf";
const SIGNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("runFinalizeEpoch claimant liabilities", () => {
  it("rejects an invalid signature before repairing a finalized epoch", async () => {
    vi.mocked(verifyTypedData).mockResolvedValue(false);
    const epoch: AttributionEpoch = {
      id: 2n,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      status: "finalized",
      periodStart: new Date("2026-08-03T00:00:00Z"),
      periodEnd: new Date("2026-08-10T00:00:00Z"),
      weightConfig: { "github:pr_merged": 1000 },
      poolTotalCredits: 10_000n,
      approverSetHash: await computeApproverSetHash([SIGNER]),
      approvers: [SIGNER],
      allocationAlgoRef: "weight-sum-v0",
      weightConfigHash: "weight-config-hash",
      artifactsHash: "artifacts-hash",
      openedAt: new Date(),
      closedAt: new Date(),
      createdAt: new Date(),
    };
    const finalizeEpochAtomic = vi.fn();
    const store = {
      getEpoch: vi.fn().mockResolvedValue(epoch),
      getStatementForEpoch: vi.fn().mockResolvedValue({
        id: "statement-2",
        nodeId: NODE_ID,
        epochId: 2n,
        finalAllocationSetHash: "allocation-set-hash",
        poolTotalCredits: 10_000n,
        statementLines: [],
        supersedesStatementId: null,
        createdAt: new Date(),
      }),
      finalizeEpochAtomic,
    } as unknown as AttributionStore;

    await expect(
      runFinalizeEpoch(
        {
          attributionStore: store,
          registries: createDefaultRegistries(),
          nodeId: NODE_ID,
          scopeId: SCOPE_ID,
          chainId: 8453,
          tokenAddress: null,
          distributorAddress: null,
          walletResolver: null,
          deploymentEnvironment: "candidate-a",
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        },
        {
          epochId: "2",
          signature: "0xdeadbeef",
          signerAddress: SIGNER,
        }
      )
    ).rejects.toMatchObject({ code: "signature_invalid" });
    expect(finalizeEpochAtomic).not.toHaveBeenCalled();
  });

  it("writes the exact token-atomic liability in the finalize transaction", async () => {
    vi.mocked(verifyTypedData).mockResolvedValue(true);
    const epoch: AttributionEpoch = {
      id: 2n,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      status: "review",
      periodStart: new Date("2026-08-03T00:00:00Z"),
      periodEnd: new Date("2026-08-10T00:00:00Z"),
      weightConfig: { "github:pr_merged": 1000 },
      poolTotalCredits: null,
      approverSetHash: await computeApproverSetHash([SIGNER]),
      approvers: [SIGNER],
      allocationAlgoRef: "weight-sum-v0",
      weightConfigHash: "weight-config-hash",
      artifactsHash: null,
      openedAt: new Date(),
      closedAt: null,
      createdAt: new Date(),
    };
    const finalizeEpochAtomic = vi.fn(async (params) => ({
      epoch: { ...epoch, status: "finalized" as const },
      statement: {
        id: "statement-2",
        nodeId: NODE_ID,
        epochId: 2n,
        finalAllocationSetHash: params.statement.finalAllocationSetHash,
        poolTotalCredits: params.statement.poolTotalCredits,
        statementLines: params.statement.statementLines,
        supersedesStatementId: null,
        createdAt: new Date(),
      },
    }));
    const store = {
      getEpoch: vi.fn().mockResolvedValue(epoch),
      getPoolComponentsForEpoch: vi.fn().mockResolvedValue([
        {
          id: "pool-2",
          nodeId: NODE_ID,
          epochId: 2n,
          componentId: "base_issuance",
          algorithmVersion: "v1",
          inputsJson: { base_amount: 10000 },
          amountCredits: 10_000n,
          evidenceRef: null,
          computedAt: new Date(),
        },
      ]),
      loadLockedClaimants: vi.fn().mockResolvedValue([
        {
          id: "claimant-2",
          nodeId: NODE_ID,
          epochId: 2n,
          receiptId: "receipt-2",
          status: "locked",
          resolverRef: "cogni.default-author.v0",
          algoRef: "default-author-v0",
          inputsHash: "inputs-hash",
          claimantKeys: ["identity:github:42"],
          createdAt: new Date(),
          createdBy: "system",
        },
      ]),
      getSelectedReceiptsForAllocation: vi.fn().mockResolvedValue([
        {
          receiptId: "receipt-2",
          userId: null,
          source: "github",
          eventType: "pr_merged",
          included: true,
          weightOverrideMilli: null,
        },
      ]),
      getReviewSubjectOverridesForEpoch: vi.fn().mockResolvedValue([]),
      getEvaluationsForEpoch: vi.fn().mockResolvedValue([
        {
          id: "evaluation-2",
          nodeId: NODE_ID,
          epochId: 2n,
          evaluationRef: "cogni.echo.v0",
          status: "locked",
          algoRef: "echo-v0",
          inputsHash: "inputs-hash",
          payloadHash: "payload-hash",
          payloadJson: {
            totalEvents: 1,
            byEventType: { pr_merged: 1 },
            byUserId: {},
          },
          payloadRef: null,
          createdAt: new Date(),
        },
      ]),
      finalizeEpochAtomic,
    } as unknown as AttributionStore;

    const result = await runFinalizeEpoch(
      {
        attributionStore: store,
        registries: createDefaultRegistries(),
        nodeId: NODE_ID,
        scopeId: SCOPE_ID,
        chainId: 8453,
        tokenAddress: null,
        distributorAddress: null,
        walletResolver: null,
        deploymentEnvironment: "candidate-a",
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      {
        epochId: "2",
        signature: "0xdeadbeef",
        signerAddress: SIGNER,
      }
    );

    expect(result.statementLineCount).toBe(1);
    expect(finalizeEpochAtomic).toHaveBeenCalledOnce();
    expect(finalizeEpochAtomic.mock.calls[0]?.[0].claimantLiabilities).toEqual([
      {
        claimantKey: "identity:github:42",
        amountAtomic: 10_000n * 10n ** 18n,
        receiptIds: ["receipt-2"],
      },
    ]);
  });
});

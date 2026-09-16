// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/attribution.settlement-lifecycle`
 * Purpose: Proves the authenticated lifecycle route returns chain-proven per-epoch coverage and fails closed.
 * Scope: Route contract with mocked store, auth shell, config, and RPC. Does not access a database or chain.
 * Invariants: WRITE_ROUTES_AUTHED, REVISION_SEQUENCE_COVERAGE, UNKNOWN_PUBLICATION_FAILS_CLOSED, ALL_MATH_BIGINT.
 * Side-effects: none
 * Links: app/src/app/api/v1/attribution/settlement-lifecycle/route.ts
 * @public
 */

import { settlementLifecycleOperation } from "@cogni/node-contracts";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "00000000-0000-4000-a000-000000000001";
const LIVE_ROOT =
  "0x1100000000000000000000000000000000000000000000000000000000000000";
const LATEST_ROOT =
  "0x2200000000000000000000000000000000000000000000000000000000000000";
const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

const { store, readLiveRoot, routeOptions } = vi.hoisted(() => ({
  store: {
    listEpochs: vi.fn(),
    listClaimantLiabilities: vi.fn(),
    getLatestSettlementRevision: vi.fn(),
    getSettlementRevisionByMerkleRoot: vi.fn(),
  },
  readLiveRoot: vi.fn(),
  routeOptions: { value: null as unknown },
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ attributionStore: store }),
}));

vi.mock("@/bootstrap/settlement-runtime", () => ({
  readLiveDistributionMerkleRoot: readLiveRoot,
}));

vi.mock("@/shared/config", () => ({
  getNodeId: () => NODE_ID,
  getScopeId: () => "default",
  getNodeTokenomicsConfig: () => ({
    chainId: 8453,
    distributorAddress: "0x3333333333333333333333333333333333333333",
  }),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (options: unknown, handler: () => Promise<Response>) =>
    async () => {
      routeOptions.value = options;
      return handler();
    },
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

import { GET } from "@/app/api/v1/attribution/settlement-lifecycle/route";

function epoch(id: bigint) {
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

function revision(sequence: bigint, merkleRoot: string) {
  return {
    id: `r${sequence}`,
    nodeId: NODE_ID,
    scopeId: "default",
    sequence,
    previousRevisionId: sequence === 1n ? null : `r${sequence - 1n}`,
    previousMerkleRoot: null,
    distributionId: `distribution-${sequence}`,
    statementHash: `statement-${sequence}`,
    merkleRoot,
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

function liability(
  id: string,
  sourceEpochId: bigint,
  settledRevisionSequence: bigint | null
) {
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

async function callRoute() {
  return GET(
    new NextRequest(
      "http://localhost:3000/api/v1/attribution/settlement-lifecycle"
    )
  );
}

describe("GET attribution settlement lifecycle", () => {
  const r1 = revision(1n, LIVE_ROOT);
  const r2 = revision(2n, LATEST_ROOT);

  beforeEach(() => {
    vi.clearAllMocks();
    store.listEpochs.mockResolvedValue([epoch(1n), epoch(2n)]);
    store.listClaimantLiabilities.mockResolvedValue([
      liability("published", 1n, 1n),
      liability("settled", 2n, 2n),
      liability("pending", 2n, null),
    ]);
    store.getLatestSettlementRevision.mockResolvedValue(r2);
    store.getSettlementRevisionByMerkleRoot.mockResolvedValue(r1);
    readLiveRoot.mockResolvedValue(LIVE_ROOT);
  });

  it("is authenticated and returns live/latest revision-sequence coverage", async () => {
    const response = await callRoute();
    expect(response.status).toBe(200);
    const parsed = settlementLifecycleOperation.output.parse(
      await response.json()
    );

    expect(routeOptions.value).toMatchObject({
      routeId: "ledger.settlement-lifecycle",
      auth: { mode: "required" },
    });
    expect(parsed).toMatchObject({
      publicationEvidence: "matched",
      liveRevision: {
        sequence: "1",
        merkleRoot: LIVE_ROOT,
        cumulativeTotal: "100",
      },
      latestRevision: {
        sequence: "2",
        merkleRoot: LATEST_ROOT,
        cumulativeTotal: "200",
      },
      epochs: [
        {
          epochId: "1",
          liabilityCount: 1,
          settledLiabilityCount: 1,
          publishedLiabilityCount: 1,
        },
        {
          epochId: "2",
          liabilityCount: 2,
          settledLiabilityCount: 1,
          publishedLiabilityCount: 0,
        },
      ],
    });
  });

  it("fails closed when the live root does not match settlement history", async () => {
    store.getSettlementRevisionByMerkleRoot.mockResolvedValue(null);
    const response = await callRoute();
    const parsed = settlementLifecycleOperation.output.parse(
      await response.json()
    );

    expect(parsed.publicationEvidence).toBe("unknown");
    expect(parsed.liveRevision).toBeNull();
    expect(
      parsed.epochs.map((epochItem) => epochItem.publishedLiabilityCount)
    ).toEqual([null, null]);
  });

  it("fails closed when RPC evidence is unavailable", async () => {
    readLiveRoot.mockResolvedValue(null);
    const response = await callRoute();
    const parsed = settlementLifecycleOperation.output.parse(
      await response.json()
    );

    expect(parsed.publicationEvidence).toBe("unknown");
    expect(parsed.epochs[0].publishedLiabilityCount).toBeNull();
  });

  it("fails closed when the live-root RPC rejects", async () => {
    readLiveRoot.mockRejectedValue(new Error("rpc unavailable"));
    const response = await callRoute();
    const parsed = settlementLifecycleOperation.output.parse(
      await response.json()
    );

    expect(parsed.publicationEvidence).toBe("unknown");
    expect(parsed.liveRevision).toBeNull();
    expect(
      parsed.epochs.map((epochItem) => epochItem.publishedLiabilityCount)
    ).toEqual([null, null]);
  });

  it("reports known zero coverage when the distributor root is empty", async () => {
    readLiveRoot.mockResolvedValue(ZERO_ROOT);
    const response = await callRoute();
    const parsed = settlementLifecycleOperation.output.parse(
      await response.json()
    );

    expect(parsed.publicationEvidence).toBe("not_published");
    expect(parsed.liveRevision).toBeNull();
    expect(
      parsed.epochs.map((epochItem) => epochItem.publishedLiabilityCount)
    ).toEqual([0, 0]);
  });
});

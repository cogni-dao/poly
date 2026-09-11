// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/attribution.distribution-tx`
 * Purpose: Prove publish payloads advance from the live chain root to the newest descendant revision.
 * Scope: Route contract with mocked store/RPC/auth shell; no database or chain.
 * Invariants: LIVE_ROOT_IS_CHAIN_AUTHORITY, DESCENDANT_ONLY, CUMULATIVE_DELTA.
 * Side-effects: none
 * Links: app/src/app/api/v1/attribution/epochs/[id]/distribution-tx/route.ts
 * @public
 */

import { NextRequest } from "next/server";
import { decodeFunctionData } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPublishProbeData,
  classifyPublishPermission,
  DAO_ABI,
} from "@/features/governance/lib/proposal-abis";

const NODE_ID = "00000000-0000-4000-a000-000000000001";
const LIVE_ROOT =
  "0x1100000000000000000000000000000000000000000000000000000000000000";
const TARGET_ROOT =
  "0x3300000000000000000000000000000000000000000000000000000000000000";
const TOKEN = "0x1111111111111111111111111111111111111111";
const DISTRIBUTOR = "0x2222222222222222222222222222222222222222";

const { store, readLiveRoot } = vi.hoisted(() => ({
  store: {
    getEpoch: vi.fn(),
    getLatestSettlementRevision: vi.fn(),
    getSettlementRevisionByMerkleRoot: vi.fn(),
    getSettlementRevision: vi.fn(),
  },
  readLiveRoot: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ attributionStore: store }),
}));

vi.mock("@/bootstrap/settlement-runtime", () => ({
  readLiveDistributionMerkleRoot: readLiveRoot,
}));

vi.mock("@/app/api/v1/attribution/_lib/approver-guard", () => ({
  checkApprover: vi.fn(() => null),
}));

vi.mock("@/shared/config", () => ({
  getDaoConfig: () => ({
    dao_contract: "0x4444444444444444444444444444444444444444",
    plugin_contract: "0x5555555555555555555555555555555555555555",
  }),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (
        ctx: { log: { info: ReturnType<typeof vi.fn> } },
        request: NextRequest,
        user: { walletAddress: string },
        context: { params: Promise<{ id: string }> }
      ) => Promise<Response>
    ) =>
    (request: NextRequest, context: { params: Promise<{ id: string }> }) =>
      handler(
        { log: { info: vi.fn() } },
        request,
        { walletAddress: "0x6666666666666666666666666666666666666666" },
        context
      ),
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

import { GET } from "@/app/api/v1/attribution/epochs/[id]/distribution-tx/route";

function revision(args: {
  id: string;
  sequence: bigint;
  previousRevisionId: string | null;
  merkleRoot: string;
  cumulativeTotal: bigint;
}) {
  return {
    ...args,
    nodeId: NODE_ID,
    scopeId: "default",
    previousMerkleRoot: null,
    distributionId: `distribution-${args.id}`,
    statementHash: `statement-${args.id}`,
    chainId: 8453,
    tokenAddress: "0x7777777777777777777777777777777777777777",
    distributorAddress: "0x8888888888888888888888888888888888888888",
    mintDelta: 100n,
    triggerKind: "epoch_finalize",
    triggerRef: "2",
    createdAt: new Date("2026-08-17T00:00:00Z"),
  };
}

async function callRoute() {
  return GET(new NextRequest("http://localhost/distribution-tx"), {
    params: Promise.resolve({ id: "2" }),
  });
}

describe("GET epoch distribution-tx", () => {
  const r1 = revision({
    id: "r1",
    sequence: 1n,
    previousRevisionId: null,
    merkleRoot: LIVE_ROOT,
    cumulativeTotal: 100n,
  });
  const r2 = revision({
    id: "r2",
    sequence: 2n,
    previousRevisionId: "r1",
    merkleRoot:
      "0x2200000000000000000000000000000000000000000000000000000000000000",
    cumulativeTotal: 200n,
  });
  const r3 = revision({
    id: "r3",
    sequence: 3n,
    previousRevisionId: "r2",
    merkleRoot: TARGET_ROOT,
    cumulativeTotal: 350n,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    store.getEpoch.mockResolvedValue({
      id: 2n,
      nodeId: NODE_ID,
      scopeId: "default",
      status: "finalized",
    });
    store.getLatestSettlementRevision.mockResolvedValue(r3);
    readLiveRoot.mockResolvedValue(LIVE_ROOT);
    store.getSettlementRevisionByMerkleRoot.mockResolvedValue(r1);
    store.getSettlementRevision.mockImplementation(async (id: string) =>
      id === "r2" ? r2 : id === "r1" ? r1 : null
    );
  });

  it("mints the cumulative difference across unpublished descendant revisions", async () => {
    const response = await callRoute();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      epochId: "2",
      settlementRevisionId: "r3",
      settlementSequence: 3,
      merkleRoot: TARGET_ROOT,
      mintDelta: "250",
      alreadyExecutedRoot: LIVE_ROOT,
    });
  });

  it("fails closed when the live root is absent from settlement history", async () => {
    store.getSettlementRevisionByMerkleRoot.mockResolvedValue(null);
    const response = await callRoute();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "live_root_unknown",
      merkleRoot: LIVE_ROOT,
    });
  });
});

describe("publish CAS calldata", () => {
  it("encodes the live root and only accepts strict compare-and-swap authority", () => {
    const validData = buildPublishProbeData(TOKEN, DISTRIBUTOR, LIVE_ROOT, 0n);
    const invalidFailureData = buildPublishProbeData(
      TOKEN,
      DISTRIBUTOR,
      LIVE_ROOT,
      1n
    );
    const valid = decodeFunctionData({ abi: DAO_ABI, data: validData });
    const invalidFailure = decodeFunctionData({
      abi: DAO_ABI,
      data: invalidFailureData,
    });

    expect(valid.functionName).toBe("execute");
    expect(valid.args?.[0]).toBe(LIVE_ROOT);
    expect(valid.args?.[2]).toBe(0n);
    expect(invalidFailure.args?.[2]).toBe(1n);
    expect(classifyPublishPermission(true, false)).toBe("authorized");
    expect(classifyPublishPermission(true, true)).toBe("none");
    expect(classifyPublishPermission(false, false)).toBe("none");
  });
});

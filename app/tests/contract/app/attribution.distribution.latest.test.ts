// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/attribution.distribution.latest`
 * Purpose: Contract tests for GET /api/v1/public/attribution/distribution/latest — the CUMULATIVE claim read route.
 * Scope: Exercises the real wrapPublicRoute() handler with a mocked attributionStore; verifies 400 on missing account, claim:null when no finalized-with-manifest epoch, and the cumulative claim DTO shape. Does NOT hit a real DB.
 * Invariants: CUMULATIVE_MODEL (amount = leaf cumulativeAmount, string), PUBLIC_READS_FINALIZED_ONLY, PROOF_HEX_ARRAY, DISTRIBUTOR_NULLABLE.
 * Side-effects: none (container + node-id + rate limiter mocked)
 * Links: src/app/api/v1/public/attribution/distribution/latest/route, contracts/attribution.latest-distribution.v1.contract
 * @public
 */

import { latestDistributionOperation } from "@cogni/node-contracts";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TEST_NODE_ID = "00000000-0000-4000-a000-000000000001";
const TEST_ACCOUNT = "0x1111111111111111111111111111111111111111";

// --- Mocks ---

const mockAttributionStore = {
  getLatestSettlementRevision: vi.fn(),
  getSettlementRevisionByMerkleRoot: vi.fn(),
  getSettlementClaimForAccount: vi.fn(),
};

const { mockReadLiveRoot } = vi.hoisted(() => ({
  mockReadLiveRoot: vi.fn(),
}));

// wrapPublicRoute + its logging wrapper read container.{log,clock,config};
// the route reads container.attributionStore.
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log: {
      child: vi.fn(() => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      })),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    clock: { now: vi.fn(() => new Date("2025-01-01T00:00:00Z")) },
    config: {
      rateLimitBypass: {
        enabled: true,
        headerName: "x-stack-test",
        headerValue: "1",
      },
      DEPLOY_ENVIRONMENT: "test",
      unhandledErrorPolicy: "rethrow",
    },
    attributionStore: mockAttributionStore,
  })),
}));

vi.mock("@/shared/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/config")>();
  return {
    ...actual,
    getNodeId: vi.fn(() => TEST_NODE_ID),
    getScopeId: vi.fn(() => "default"),
  };
});

vi.mock("@/bootstrap/settlement-runtime", () => ({
  readLiveDistributionMerkleRoot: mockReadLiveRoot,
}));

// Always allow in contract tests (no real IP rate limiting).
vi.mock("@/bootstrap/http/rateLimiter", () => ({
  publicApiLimiter: { consume: vi.fn(() => true) },
  extractClientIp: vi.fn(() => "test-ip"),
  TokenBucketRateLimiter: vi.fn(),
}));

// Import after mocks.
import { GET } from "@/app/api/v1/public/attribution/distribution/latest/route";

function makeRevision() {
  return {
    id: "revision-3",
    nodeId: TEST_NODE_ID,
    scopeId: "default",
    sequence: 3n,
    previousRevisionId: "revision-2",
    distributionId: "settlement-3",
    statementHash: "0xstatement",
    merkleRoot:
      "0x9f00000000000000000000000000000000000000000000000000000000000000",
    chainId: 8453,
    tokenAddress: "0x0166Db3d42603E790Fb685059DcAa37087B032c8",
    mintDelta: 1000n,
    cumulativeTotal: 5000000000000000000n,
    distributorAddress: "0x717a747df71111a678202BfCD2E3B0081A9aeB56",
    triggerKind: "identity_binding",
    triggerRef: "event-1",
    createdAt: new Date("2025-01-08T00:00:00Z"),
  };
}

describe("GET /api/v1/public/attribution/distribution/latest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when the account query param is missing", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/v1/public/attribution/distribution/latest"
    );

    const res = await GET(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toHaveProperty("error");
    // Store is never touched when the account param is absent.
    expect(
      mockAttributionStore.getLatestSettlementRevision
    ).not.toHaveBeenCalled();
  });

  it("returns { claim: null } when no settlement revision exists", async () => {
    mockAttributionStore.getLatestSettlementRevision.mockResolvedValue(null);

    const req = new NextRequest(
      `http://localhost:3000/api/v1/public/attribution/distribution/latest?account=${TEST_ACCOUNT}`
    );

    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=0, stale-while-revalidate=0"
    );

    const body = await res.json();
    const parsed = latestDistributionOperation.output.parse(body);
    expect(parsed.claim).toBeNull();

    expect(
      mockAttributionStore.getLatestSettlementRevision
    ).toHaveBeenCalledWith(TEST_NODE_ID, "default");
    expect(
      mockAttributionStore.getSettlementClaimForAccount
    ).not.toHaveBeenCalled();
  });

  it("returns the cumulative claim DTO from the live settlement revision", async () => {
    const revision = makeRevision();
    mockAttributionStore.getLatestSettlementRevision.mockResolvedValue(
      revision
    );
    mockReadLiveRoot.mockResolvedValue(revision.merkleRoot);
    mockAttributionStore.getSettlementRevisionByMerkleRoot.mockResolvedValue(
      revision
    );
    mockAttributionStore.getSettlementClaimForAccount.mockResolvedValue({
      revision,
      leaf: {
        index: 0,
        claimantKey: "user-1",
        account: TEST_ACCOUNT,
        cumulativeAmount: 5000000000000000000n,
        deltaAmount: 5000000000000000000n,
        receiptIds: ["receipt-1"],
        leafHash: "0xleaf",
        proof: [
          "0xabc0000000000000000000000000000000000000000000000000000000000000",
          "0xdef0000000000000000000000000000000000000000000000000000000000000",
        ],
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/v1/public/attribution/distribution/latest?account=${TEST_ACCOUNT}`
    );

    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = latestDistributionOperation.output.parse(body);

    expect(parsed.claim).not.toBeNull();
    const claim = parsed.claim as NonNullable<typeof parsed.claim>;
    expect(claim.settlementRevisionId).toBe("revision-3");
    expect(claim.settlementSequence).toBe(3);
    expect(claim.epochId).toBeNull();
    expect(claim.root).toBe(
      "0x9f00000000000000000000000000000000000000000000000000000000000000"
    );
    expect(claim.distributor).toBe(
      "0x717a747df71111a678202BfCD2E3B0081A9aeB56"
    );
    expect(claim.chainId).toBe(8453);
    expect(claim.tokenAddress).toBe(
      "0x0166Db3d42603E790Fb685059DcAa37087B032c8"
    );
    expect(claim.account).toBe(TEST_ACCOUNT);
    // ALL_MATH_BIGINT: cumulative amount serialized as a decimal string.
    expect(claim.amount).toBe("5000000000000000000");
    expect(typeof claim.amount).toBe("string");
    expect(claim.proof).toEqual([
      "0xabc0000000000000000000000000000000000000000000000000000000000000",
      "0xdef0000000000000000000000000000000000000000000000000000000000000",
    ]);

    expect(
      mockAttributionStore.getSettlementClaimForAccount
    ).toHaveBeenCalledWith("revision-3", TEST_ACCOUNT);
  });

  it("returns { claim: null } when the live revision has no leaf for the account", async () => {
    const revision = makeRevision();
    mockAttributionStore.getLatestSettlementRevision.mockResolvedValue(
      revision
    );
    mockReadLiveRoot.mockResolvedValue(revision.merkleRoot);
    mockAttributionStore.getSettlementRevisionByMerkleRoot.mockResolvedValue(
      revision
    );
    mockAttributionStore.getSettlementClaimForAccount.mockResolvedValue(null);

    const req = new NextRequest(
      `http://localhost:3000/api/v1/public/attribution/distribution/latest?account=${TEST_ACCOUNT}`
    );

    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = latestDistributionOperation.output.parse(body);
    expect(parsed.claim).toBeNull();
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/attribution/epochs/[id]/distribution/route`
 * Purpose: Compatibility endpoint serving a claimant's proof for the exact settlement root live on-chain.
 * Scope: Requires the requested epoch to be finalized, but resolves the proof by live settlement revision; the epoch id is request context, not revision ownership.
 * Invariants: NODE_SCOPED, LIVE_ROOT_IS_CHAIN_AUTHORITY, ALL_MATH_BIGINT, VALIDATE_IO, PUBLIC_READS_FINALIZED_ONLY, NO_SECRETS.
 * Side-effects: IO (HTTP response, database read)
 * Links: contracts/attribution.epoch-distribution.v1.contract, packages/aragon-osx/src/token-distribution.ts
 * @public
 */

import { epochDistributionOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapPublicRoute } from "@/bootstrap/http";
import { readLiveDistributionMerkleRoot } from "@/bootstrap/settlement-runtime";

export const dynamic = "force-dynamic";

export const GET = wrapPublicRoute(
  {
    routeId: "ledger.epoch-distribution.public",
    // A root rotation immediately invalidates proofs from the prior revision.
    cacheTtlSeconds: 0,
    staleWhileRevalidateSeconds: 0,
  },
  async (_ctx, request, context) => {
    const { id } = await (context as { params: Promise<{ id: string }> })
      .params;
    let epochId: bigint;
    try {
      epochId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "Invalid epoch ID" }, { status: 400 });
    }

    const url = new URL(request.url);
    const accountParam = url.searchParams.get("account");
    if (!accountParam) {
      return NextResponse.json(
        { error: "account query param is required" },
        { status: 400 }
      );
    }
    const { account } = epochDistributionOperation.input.parse({
      account: accountParam,
    });

    const store = getContainer().attributionStore;

    // PUBLIC_READS_FINALIZED_ONLY: verify epoch is finalized
    const epoch = await store.getEpoch(epochId);
    if (!epoch || epoch.status !== "finalized") {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    const latest = await store.getLatestSettlementRevision(
      epoch.nodeId,
      epoch.scopeId
    );
    if (!latest || !latest.distributorAddress) {
      return NextResponse.json({ error: "Claim not found" }, { status: 404 });
    }

    const liveRoot = await readLiveDistributionMerkleRoot(
      latest.chainId,
      latest.distributorAddress
    );
    if (liveRoot === null) {
      return NextResponse.json(
        { error: "live_root_unavailable" },
        { status: 503 }
      );
    }
    const liveRevision = await store.getSettlementRevisionByMerkleRoot(
      epoch.nodeId,
      epoch.scopeId,
      liveRoot
    );
    if (!liveRevision) {
      return NextResponse.json({ error: "Claim not found" }, { status: 404 });
    }

    const claim = await store.getSettlementClaimForAccount(
      liveRevision.id,
      account
    );
    if (!claim) {
      return NextResponse.json({ error: "Claim not found" }, { status: 404 });
    }

    return NextResponse.json(
      epochDistributionOperation.output.parse({
        claim: {
          settlementRevisionId: claim.revision.id,
          settlementSequence: Number(claim.revision.sequence),
          epochId: epochId.toString(),
          root: claim.revision.merkleRoot,
          distributor: claim.revision.distributorAddress,
          chainId: claim.revision.chainId,
          tokenAddress: claim.revision.tokenAddress,
          index: claim.leaf.index,
          account: claim.leaf.account,
          amount: claim.leaf.cumulativeAmount.toString(),
          proof: [...claim.leaf.proof],
        },
      })
    );
  }
);

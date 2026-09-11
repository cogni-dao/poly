// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/attribution/distribution/latest/route`
 * Purpose: Public endpoint serving an account's cumulative claim for the exact settlement root live on-chain.
 * Scope: Resolves the distributor's live root to an append-only settlement revision, then returns that revision's account leaf or claim:null.
 * Invariants: NODE_SCOPED, LIVE_ROOT_IS_CHAIN_AUTHORITY, CUMULATIVE_MODEL, ALL_MATH_BIGINT, VALIDATE_IO, NO_SECRETS.
 * Side-effects: IO (HTTP response, database read)
 * Links: packages/node-contracts/src/attribution.latest-distribution.v1.contract.ts, packages/cogni-contracts/src/cumulative-merkle-distributor/abi.ts
 * @public
 */

import {
  epochDistributionOperation,
  latestDistributionOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapPublicRoute } from "@/bootstrap/http";
import { readLiveDistributionMerkleRoot } from "@/bootstrap/settlement-runtime";
import { getNodeId, getScopeId } from "@/shared/config";

export const dynamic = "force-dynamic";

export const GET = wrapPublicRoute(
  {
    routeId: "ledger.latest-distribution.public",
    // A root rotation immediately invalidates proofs from the prior revision.
    cacheTtlSeconds: 0,
    staleWhileRevalidateSeconds: 0,
  },
  async (_ctx, request) => {
    const url = new URL(request.url);
    const accountParam = url.searchParams.get("account");
    if (!accountParam) {
      return NextResponse.json(
        { error: "account query param is required" },
        { status: 400 }
      );
    }
    // Reuse the distribution input validator (normalizes the EVM address).
    const { account } = epochDistributionOperation.input.parse({
      account: accountParam,
    });

    const store = getContainer().attributionStore;

    const nodeId = getNodeId();
    const scopeId = getScopeId();
    const latest = await store.getLatestSettlementRevision(nodeId, scopeId);
    if (!latest || !latest.distributorAddress) {
      return NextResponse.json(
        latestDistributionOperation.output.parse({ claim: null })
      );
    }

    // LIVE_ROOT_IS_CHAIN_AUTHORITY: a proof for a newer DB revision is invalid
    // until that exact root is published. Resolve the claim from the live root.
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
      nodeId,
      scopeId,
      liveRoot
    );
    if (!liveRevision) {
      return NextResponse.json(
        latestDistributionOperation.output.parse({ claim: null })
      );
    }

    const claim = await store.getSettlementClaimForAccount(
      liveRevision.id,
      account
    );
    if (!claim) {
      return NextResponse.json(
        latestDistributionOperation.output.parse({ claim: null })
      );
    }

    return NextResponse.json(
      latestDistributionOperation.output.parse({
        claim: {
          settlementRevisionId: claim.revision.id,
          settlementSequence: Number(claim.revision.sequence),
          epochId: null,
          root: claim.revision.merkleRoot,
          distributor: claim.revision.distributorAddress,
          chainId: claim.revision.chainId,
          tokenAddress: claim.revision.tokenAddress,
          account: claim.leaf.account,
          amount: claim.leaf.cumulativeAmount.toString(),
          proof: [...claim.leaf.proof],
        },
      })
    );
  }
);

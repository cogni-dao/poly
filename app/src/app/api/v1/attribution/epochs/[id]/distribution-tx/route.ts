// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/[id]/distribution-tx/route`
 * Purpose: Serve the EXECUTE payload that advances the distributor from its live on-chain root to
 *   the newest append-only settlement revision. The finalized epoch id is retained as the approver-
 *   gated UI context; settlement revisions advance independently when late identities link.
 * Scope: Thin authed read shell — SIWE + approver-gated, revision/store reads, live root read, and
 *   this node's repo-spec governance addresses. No transaction is sent here.
 * Invariants:
 *   - NODE_SCOPED (single-node): governance addresses come from THIS node's repo-spec, never a nodes-table row.
 *   - ALL_MATH_BIGINT (mintDelta serialized as a decimal string), VALIDATE_IO.
 *   - READ_ONLY_SERVES_SETTLEMENT: returns only persisted revision + repo-spec addresses; never
 *     mutates state and never signs/sends a transaction.
 *   - FINALIZED_AND_RECORDED: gated on epoch finalized + revision exists + distributorAddress
 *     recorded; otherwise 409 (nothing to execute yet).
 *   - LIVE_ROOT_IS_CHAIN_AUTHORITY: target must descend from the live root; mintDelta is the exact
 *     cumulative-total difference. Unknown/diverged/unreadable roots fail closed.
 *   - APPROVER_GATED: node ledger approver (repo-spec) authorizes the read.
 * Side-effects: IO (HTTP response, database read, viem RPC read of the live merkle root)
 * Links: docs/spec/attribution-ledger.md, packages/attribution-ledger/src/store.ts (SettlementStore)
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { checkApprover } from "@/app/api/v1/attribution/_lib/approver-guard";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { readLiveDistributionMerkleRoot } from "@/bootstrap/settlement-runtime";
import { getDaoConfig } from "@/shared/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE_ID = "ledger.distribution-tx";

const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** DTO the ExecuteDistributionPanel consumes to build the direct DAO.execute actions. */
interface DistributionTxDto {
  readonly epochId: string;
  readonly settlementRevisionId: string;
  readonly settlementSequence: number;
  readonly merkleRoot: string;
  /** Exact cumulative-total delta from live root to target revision. */
  readonly mintDelta: string;
  readonly distributorAddress: string;
  readonly tokenAddress: string;
  readonly daoAddress: string;
  readonly pluginAddress: string;
  readonly chainId: number;
  /** On-chain root the distributor currently carries. */
  readonly alreadyExecutedRoot: string;
}

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: ROUTE_ID,
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    let epochId: bigint;
    try {
      epochId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "invalid epoch id" }, { status: 400 });
    }

    const store = getContainer().attributionStore;

    // FINALIZED_AND_RECORDED: the epoch must be finalized before a distribution exists.
    const epoch = await store.getEpoch(epochId);
    if (!epoch) {
      return NextResponse.json({ error: "epoch_not_found" }, { status: 404 });
    }

    // APPROVER_GATED: node ledger approver (repo-spec) may read. Mirrors the finalize
    // route's approver gate — checks against the epoch's pinned approvers when present.
    const denied = checkApprover(ctx, sessionUser?.walletAddress, epoch);
    if (denied) return denied;

    if (epoch.status !== "finalized") {
      return NextResponse.json(
        { error: "epoch_not_finalized", currentStatus: epoch.status },
        { status: 409 }
      );
    }

    const target = await store.getLatestSettlementRevision(
      epoch.nodeId,
      epoch.scopeId
    );
    if (!target) {
      return NextResponse.json(
        { error: "no_settlement_revision" },
        { status: 409 }
      );
    }
    if (!target.distributorAddress) {
      // R2/R3 must have recorded the distributor before a mint+setRoot can target it.
      return NextResponse.json(
        { error: "distributor_not_recorded" },
        { status: 409 }
      );
    }

    // NODE_SCOPED (single-node): the DAO + TokenVoting plugin governance addresses come
    // from THIS node's OWN repo-spec — no operator gateway, no nodes-table row.
    const dao = getDaoConfig();
    if (!dao) {
      return NextResponse.json(
        { error: "node_missing_governance" },
        { status: 409 }
      );
    }
    const daoAddress = dao.dao_contract;
    const pluginAddress = dao.plugin_contract;

    // LIVE_ROOT_IS_CHAIN_AUTHORITY: publish the newest descendant of the root
    // currently accepted by the distributor. Never derive minting from epoch order.
    const alreadyExecutedRoot = await readLiveDistributionMerkleRoot(
      target.chainId,
      target.distributorAddress
    );
    if (alreadyExecutedRoot === null) {
      return NextResponse.json(
        { error: "live_root_unavailable" },
        { status: 503 }
      );
    }
    if (alreadyExecutedRoot.toLowerCase() === target.merkleRoot.toLowerCase()) {
      return NextResponse.json(
        { error: "already_published", merkleRoot: target.merkleRoot },
        { status: 409 }
      );
    }

    const liveRevision =
      alreadyExecutedRoot.toLowerCase() === ZERO_ROOT
        ? null
        : await store.getSettlementRevisionByMerkleRoot(
            epoch.nodeId,
            epoch.scopeId,
            alreadyExecutedRoot
          );
    if (alreadyExecutedRoot.toLowerCase() !== ZERO_ROOT && !liveRevision) {
      return NextResponse.json(
        { error: "live_root_unknown", merkleRoot: alreadyExecutedRoot },
        { status: 409 }
      );
    }
    if (
      liveRevision &&
      !(await isRevisionDescendantOf(store, target, liveRevision.id))
    ) {
      return NextResponse.json(
        { error: "live_root_not_ancestor", merkleRoot: alreadyExecutedRoot },
        { status: 409 }
      );
    }

    const mintDelta =
      target.cumulativeTotal - (liveRevision?.cumulativeTotal ?? 0n);

    if (mintDelta < 0n) {
      // A cumulative total should never shrink. Refuse rather than emit a bad mint.
      return NextResponse.json(
        { error: "negative_mint_delta" },
        { status: 409 }
      );
    }

    const dto: DistributionTxDto = {
      epochId: epochId.toString(),
      settlementRevisionId: target.id,
      settlementSequence: Number(target.sequence),
      merkleRoot: target.merkleRoot,
      mintDelta: mintDelta.toString(),
      distributorAddress: target.distributorAddress,
      tokenAddress: target.tokenAddress,
      daoAddress,
      pluginAddress,
      chainId: target.chainId,
      alreadyExecutedRoot,
    };

    ctx.log.info(
      {
        event: "ledger.distribution_tx.served",
        routeId: ROUTE_ID,
        nodeId: epoch.nodeId,
        epochId: dto.epochId,
        chainId: dto.chainId,
        settlementRevisionId: dto.settlementRevisionId,
        settlementSequence: dto.settlementSequence,
      },
      "distribution-tx: execute payload served"
    );

    return NextResponse.json(dto);
  }
);

async function isRevisionDescendantOf(
  store: ReturnType<typeof getContainer>["attributionStore"],
  target: Awaited<ReturnType<typeof store.getLatestSettlementRevision>>,
  ancestorRevisionId: string
): Promise<boolean> {
  let cursor = target;
  while (cursor) {
    if (cursor.id === ancestorRevisionId) return true;
    cursor = cursor.previousRevisionId
      ? await store.getSettlementRevision(cursor.previousRevisionId)
      : null;
  }
  return false;
}

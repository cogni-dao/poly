// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/settlement/run-reconcile-settlements`
 * Purpose: Resolve durable claimant liabilities to wallets and append one cumulative settlement revision.
 * Scope: Runtime-neutral orchestration over injected ledger/wallet ports. Builds and persists revisions; never publishes on-chain.
 * Invariants:
 * - LIABILITY_AMOUNT_FIXED: every settled delta is the immutable signed-line liability amount.
 * - SETTLEMENT_EXACTLY_ONCE: the store atomically appends the revision and marks each liability settled.
 * - LINK_AFTER_FINALIZE: unresolved liabilities remain pending and are retried independently of epoch lifecycle.
 * - HEAD_CONFLICT_RETRY: a stale snapshot is rebuilt from the new head; it is never force-written.
 * Side-effects: IO through injected ports only.
 * Links: docs/spec/attribution-ledger.md, docs/spec/tokenomics.md
 * @public
 */

import {
  buildDaoTokenCumulativeDistribution,
  type ClaimantWalletResolver,
  type HexAddress,
} from "@cogni/aragon-osx";
import type {
  ClaimantLiabilityRecord,
  SettlementStore,
} from "@cogni/attribution-ledger";
import { keccak256, stringToHex } from "viem";

const MAX_HEAD_CONFLICT_RETRIES = 3;

export type SettlementReconcileTrigger =
  | { readonly kind: "epoch_finalize"; readonly epochId: string }
  | { readonly kind: "identity_binding"; readonly eventId?: string }
  | { readonly kind: "collect_retry" };

export interface SettlementLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface RunReconcileSettlementsDeps {
  readonly settlementStore: SettlementStore;
  readonly walletResolver: ClaimantWalletResolver | null;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly chainId: number;
  readonly tokenAddress: string | null;
  readonly distributorAddress: string | null;
  readonly logger: SettlementLogger;
}

export type ReconcileSettlementsResult =
  | {
      readonly status: "noop";
      readonly reason:
        | "distribution_inactive"
        | "no_pending_liabilities"
        | "no_resolvable_liabilities";
      readonly pendingLiabilityCount: number;
      readonly unresolvedLiabilityCount: number;
    }
  | {
      readonly status: "appended";
      readonly revisionId: string;
      readonly sequence: bigint;
      readonly distributionId: string;
      readonly merkleRoot: string;
      readonly mintDelta: bigint;
      readonly cumulativeTotal: bigint;
      readonly leafCount: number;
      readonly liabilityCount: number;
      readonly unresolvedLiabilityCount: number;
    };

function triggerRef(trigger: SettlementReconcileTrigger): string {
  switch (trigger.kind) {
    case "epoch_finalize":
      return trigger.epochId;
    case "identity_binding":
      return trigger.eventId ?? "binding";
    case "collect_retry":
      return "scheduled";
  }
}

function liabilitySetHash(
  liabilities: readonly ClaimantLiabilityRecord[]
): string {
  const canonical = [...liabilities]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((liability) =>
      [
        liability.sourceEpochId.toString(),
        liability.statementId,
        liability.id,
        liability.claimantKey,
        liability.amountAtomic.toString(),
        [...liability.receiptIds].sort().join(","),
      ].join(":")
    )
    .join("\n");
  return keccak256(stringToHex(canonical));
}

/**
 * Reconcile every currently wallet-resolvable pending liability into one revision.
 * A caller may invoke this after finalize, after a binding commit, or from a periodic
 * collect pass. All three paths are safe to retry.
 */
export async function runReconcileSettlements(
  deps: RunReconcileSettlementsDeps,
  trigger: SettlementReconcileTrigger
): Promise<ReconcileSettlementsResult> {
  const {
    settlementStore,
    walletResolver,
    nodeId,
    scopeId,
    chainId,
    tokenAddress,
    distributorAddress,
    logger,
  } = deps;

  if (!tokenAddress || !distributorAddress || !walletResolver) {
    return {
      status: "noop",
      reason: "distribution_inactive",
      pendingLiabilityCount: 0,
      unresolvedLiabilityCount: 0,
    };
  }

  for (let attempt = 1; attempt <= MAX_HEAD_CONFLICT_RETRIES; attempt += 1) {
    const pending = await settlementStore.listPendingClaimantLiabilities(
      nodeId,
      scopeId
    );
    if (pending.length === 0) {
      return {
        status: "noop",
        reason: "no_pending_liabilities",
        pendingLiabilityCount: 0,
        unresolvedLiabilityCount: 0,
      };
    }

    for (const liability of pending) {
      if (liability.amountAtomic <= 0n) {
        throw new Error(
          `settlement liability ${liability.id} must have a positive amount`
        );
      }
    }

    const claimantKeys = [...new Set(pending.map((item) => item.claimantKey))];
    const resolutions = await walletResolver.resolveWallets(claimantKeys);
    const byClaimantKey = new Map(
      resolutions.map((resolution) => [resolution.claimantKey, resolution])
    );
    const resolvable = pending.flatMap((liability) => {
      const resolution = byClaimantKey.get(liability.claimantKey);
      return resolution?.wallet && resolution.userId
        ? [
            {
              liability,
              userId: resolution.userId,
              wallet: resolution.wallet,
            },
          ]
        : [];
    });
    const unresolvedLiabilityCount = pending.length - resolvable.length;

    if (resolvable.length === 0) {
      logger.info(
        { nodeId, scopeId, pendingLiabilityCount: pending.length },
        "Settlement reconciliation deferred — no pending claimant has a wallet"
      );
      return {
        status: "noop",
        reason: "no_resolvable_liabilities",
        pendingLiabilityCount: pending.length,
        unresolvedLiabilityCount,
      };
    }

    const previous = await settlementStore.getLatestSettlementRevision(
      nodeId,
      scopeId
    );
    const previousLeaves = previous
      ? await settlementStore.getSettlementLeavesForRevision(previous.id)
      : [];
    const nextSequence = (previous?.sequence ?? 0n) + 1n;
    const distributionId = `settlement-${nodeId}-${scopeId}-${nextSequence.toString()}`;
    const settledLiabilities = resolvable.map(({ liability }) => liability);
    const distribution = buildDaoTokenCumulativeDistribution({
      distributionId,
      nodeId,
      scopeId,
      statementHash: liabilitySetHash(settledLiabilities),
      chainId,
      tokenAddress: tokenAddress as HexAddress,
      priorCumulative: previousLeaves.map((leaf) => ({
        account: leaf.account as HexAddress,
        cumulativeAmount: leaf.cumulativeAmount,
      })),
      epochDeltas: resolvable.map(({ liability, wallet }) => ({
        claimantKey: liability.claimantKey,
        account: wallet,
        deltaAmount: liability.amountAtomic,
        receiptIds: liability.receiptIds,
      })),
    });
    const priorLeafByAccount = new Map(
      previousLeaves.map((leaf) => [leaf.account.toLowerCase(), leaf])
    );

    const append = await settlementStore.appendSettlementRevisionAtomic({
      nodeId,
      scopeId,
      expectedPreviousRevisionId: previous?.id ?? null,
      distributionId: distribution.distributionId,
      statementHash: distribution.statementHash,
      merkleRoot: distribution.merkleRoot,
      chainId: distribution.chainId,
      tokenAddress: distribution.tokenAddress,
      distributorAddress,
      mintDelta: distribution.mintDelta,
      cumulativeTotal: distribution.cumulativeTotal,
      triggerKind: trigger.kind,
      triggerRef: triggerRef(trigger),
      leaves: distribution.leaves.map((leaf) => {
        const priorLeaf = priorLeafByAccount.get(leaf.account.toLowerCase());
        return {
          index: leaf.index,
          claimantKey:
            leaf.claimantKey.startsWith("account:") && priorLeaf
              ? priorLeaf.claimantKey
              : leaf.claimantKey,
          account: leaf.account,
          cumulativeAmount: leaf.cumulativeAmount,
          deltaAmount: leaf.deltaAmount,
          // Receipt IDs are non-Merkle lineage metadata, but each append persists a
          // COMPLETE cumulative snapshot. Preserve prior evidence while adding the
          // newly settled liability receipts for this account.
          receiptIds: [
            ...new Set([...(priorLeaf?.receiptIds ?? []), ...leaf.receiptIds]),
          ].sort(),
          leafHash: leaf.leafHash,
          proof: leaf.proof,
        };
      }),
      resolutions: resolvable.map(({ liability, userId, wallet }) => ({
        liabilityId: liability.id,
        resolvedUserId: userId,
        account: wallet,
      })),
    });

    if (append.status === "conflict") {
      logger.warn(
        { nodeId, scopeId, attempt },
        "Settlement head changed during reconciliation — rebuilding from latest"
      );
      continue;
    }

    logger.info(
      {
        nodeId,
        scopeId,
        revisionId: append.revision.id,
        sequence: append.revision.sequence,
        liabilityCount: resolvable.length,
        unresolvedLiabilityCount,
        mintDelta: distribution.mintDelta.toString(),
      },
      "Settlement revision appended"
    );
    return {
      status: "appended",
      revisionId: append.revision.id,
      sequence: append.revision.sequence,
      distributionId: distribution.distributionId,
      merkleRoot: distribution.merkleRoot,
      mintDelta: distribution.mintDelta,
      cumulativeTotal: distribution.cumulativeTotal,
      leafCount: distribution.leaves.length,
      liabilityCount: resolvable.length,
      unresolvedLiabilityCount,
    };
  }

  throw new Error(
    `settlement head changed ${MAX_HEAD_CONFLICT_RETRIES} consecutive times for ${nodeId}/${scopeId}`
  );
}

/** Controlled self-healing entrypoint for the normal collection cadence. */
export function retryPendingSettlements(
  deps: RunReconcileSettlementsDeps
): Promise<ReconcileSettlementsResult> {
  return runReconcileSettlements(deps, { kind: "collect_retry" });
}

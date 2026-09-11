// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/finalize/run-finalize-epoch`
 * Purpose: Runtime-agnostic epoch finalization — sign-verify → atomic statement/liability seal → settlement reconciliation.
 * Scope: One pure-DI async function. Performs I/O only through injected ports and never sends on-chain transactions.
 * Invariants:
 *   - EPOCH_FINALIZE_IDEMPOTENT: already-finalized epoch → repair via finalizeEpochAtomic, returns existing statement.
 *   - FINALIZE_CLAIMANT_AWARE: loads locked claimant rows, dispatches the pinned allocator, explodes to claimant allocations.
 *   - FINALIZE_MATERIALIZES_LIABILITIES: every positive signed line becomes one fixed atomic liability in the finalize transaction.
 *   - LATE_BINDING_SETTLES: reconciliation is independent of epoch lifecycle; unresolved liabilities remain pending.
 *   - bug.5020 execute-guard: a non-production runtime refuses to build a distribution against the production Cogni DAO; fail-closed on a null emissions holder (baked-fallback path).
 *   - FOLD_NEVER_UNDOES_FINALIZE: the cumulative fold runs AFTER the atomic off-chain finalize commits, in try/catch — a fold failure leaves the signed statement intact.
 * Side-effects: IO (AttributionStore DB, viem EIP-712 verification, optional HTTP/in-process config resolver).
 * Links: docs/spec/attribution-ledger.md, packages/aragon-osx/src/epoch-distribution-service.ts
 * @public
 */

import { type ClaimantWalletResolver } from "@cogni/aragon-osx";
import {
  type AttributionEpoch,
  type AttributionStore,
  applyReceiptWeightOverrides,
  buildEIP712TypedData,
  buildReceiptWeightOverrideSnapshots,
  claimantKey,
  computeApproverSetHash,
  computeAttributionStatementLines,
  computeFinalClaimantAllocationSetHash,
  explodeToClaimants,
  parseEIP712DeploymentEnvironment,
  toReviewSubjectOverrides,
} from "@cogni/attribution-ledger";
import { dispatchAllocator } from "@cogni/attribution-pipeline-contracts";
import { verifyTypedData } from "viem";

import type { DefaultRegistries } from "../registry";
import { assertSettlementGovernanceTargetSafe } from "../settlement/governance-target-guard";
import {
  runReconcileSettlements,
  type SettlementReconcileTrigger,
} from "../settlement/run-reconcile-settlements";

/**
 * 18-decimal base-unit scale for the GovernanceERC20. Each immutable signed
 * credit becomes one whole-token liability (× 10^18 base units).
 */
const TOKEN_BASE_UNITS = 10n ** 18n;

/**
 * Codes for CLIENT/REQUEST-STATE finalize failures — the caller can fix these (wrong
 * epoch state, unknown signer, invalid signature). The finalize route maps them to HTTP
 * 422, keeping them OUT of the 500 "internal" alarm bucket (FAULT_PARTY_BEFORE_BUCKET,
 * error-handling.md). Genuine server faults (data-integrity mismatch, DB failure) throw
 * a plain Error → 500, so `internal` stays the alarm, not the dump.
 */
export type FinalizeEpochErrorCode =
  | "epoch_not_found"
  | "epoch_not_in_review"
  | "config_not_locked"
  | "no_approvers"
  | "signer_not_approver"
  | "no_pool_components"
  | "missing_base_issuance"
  | "no_locked_claimants"
  | "no_claimant_allocations"
  | "signature_invalid";

/** A finalize failure the caller can fix (bad request state / signer / signature). */
export class FinalizeEpochError extends Error {
  readonly code: FinalizeEpochErrorCode;
  constructor(code: FinalizeEpochErrorCode, message: string) {
    super(message);
    this.name = "FinalizeEpochError";
    this.code = code;
  }
}

/** Type guard — the route uses this to translate to HTTP 422 (never string-matches). */
export function isFinalizeEpochError(err: unknown): err is FinalizeEpochError {
  return err instanceof FinalizeEpochError;
}

/** Structural logger — pino-compatible, avoids a pino dep in this neutral package. */
export interface FinalizeLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Reads the FINALIZING node's distribution config (token / emissions holder /
 * distributor) from that node's OWN repo-spec — bug.5020. Structural port so BOTH
 * the worker's HTTP `DistributionConfigHttpClient` AND the operator app's in-process
 * gateway resolver are assignable without this package depending on either runtime.
 */
export interface FinalizeDistributionConfigResolver {
  /**
   * @returns `distribution: null` ⇔ distributions not activated for this node —
   *   the fold no-ops. @throws (retryable) on a transient failure — the caller
   *   falls back to the baked config for its own node (a blip must never masquerade
   *   as "inactive").
   */
  resolveForNode(nodeId: string): Promise<{
    readonly distribution: {
      readonly tokenAddress: string | null;
      readonly distributorAddress: string | null;
      readonly emissionsHolderAddress: string | null;
    } | null;
    readonly reason?: string;
  }>;
}

/**
 * Dependencies injected into `runFinalizeEpoch`. Mirrors the finalize subset of the
 * worker's `AttributionActivityDeps` (minus `sourceRegistrations`, unused at finalize)
 * so the same deps object satisfies both the Temporal activity and the node route.
 */
export interface RunFinalizeEpochDeps {
  readonly attributionStore: AttributionStore;
  readonly registries: DefaultRegistries;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly chainId: number;
  /** GovernanceERC20 token address; null until the node activates distributions. */
  readonly tokenAddress: string | null;
  /** The ONE per-node cumulative distributor recorded at R2 activation; null until recorded. */
  readonly distributorAddress: string | null;
  /**
   * DAO that mints + owns the distributor (governance.emissions_holder), baked from
   * the runtime's OWN repo-spec; null until activated. Lets the bug.5020 execute-guard
   * assert the governance target on the baked-fallback path (no gateway).
   */
  readonly emissionsHolderAddress?: string | null;
  /**
   * Read-only resolver: attribution claimant key → contributor wallet. Null disables
   * cumulative-root building (off-chain ledger still finalizes).
   */
  readonly walletResolver: ClaimantWalletResolver | null;
  /**
   * bug.5020 per-node distribution-config gateway. Resolves the FINALIZING node's
   * governance from ITS OWN repo-spec (SPECS_GIT_AUTHORITATIVE). Null (or a transient
   * failure) falls back to the baked config above for the runtime's OWN node only.
   */
  readonly distributionConfigClient?: FinalizeDistributionConfigResolver | null;
  /**
   * Server-injected deploy environment for EIP-712 v2 and the bug.5020 execute
   * guard. Missing/unsupported values abort finalization before any mutation.
   * Explicitly `| undefined` keeps misconfiguration representable so the
   * runtime guard—not a client/default—owns the fail-closed decision.
   */
  readonly deploymentEnvironment?: string | undefined;
  readonly logger: FinalizeLogger;
}

/** Input for finalizeEpoch. */
export interface FinalizeEpochInput {
  readonly epochId: string; // bigint serialized
  readonly signature: string; // EIP-712 hex
  readonly signerAddress: string; // from SIWE session
}

async function verifyFinalizeAuthorization(params: {
  readonly epoch: AttributionEpoch;
  readonly input: FinalizeEpochInput;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly deploymentEnvironment: ReturnType<
    typeof parseEIP712DeploymentEnvironment
  >;
  readonly finalAllocationSetHash: string;
  readonly poolTotalCredits: bigint;
  readonly chainId: number;
}): Promise<void> {
  const {
    epoch,
    input,
    nodeId,
    scopeId,
    deploymentEnvironment,
    finalAllocationSetHash,
    poolTotalCredits,
    chainId,
  } = params;

  if (!epoch.approvers || epoch.approvers.length === 0) {
    throw new FinalizeEpochError(
      "no_approvers",
      `finalizeEpoch: epoch ${input.epochId} has no pinned approvers (APPROVERS_PINNED_AT_REVIEW violated)`
    );
  }
  const signerLower = input.signerAddress.toLowerCase();
  const approversLower = epoch.approvers.map((approver) =>
    approver.toLowerCase()
  );
  if (!approversLower.includes(signerLower)) {
    throw new FinalizeEpochError(
      "signer_not_approver",
      `finalizeEpoch: signer ${input.signerAddress} not in approvers`
    );
  }

  const pinnedApproverSetHash = await computeApproverSetHash(epoch.approvers);
  if (epoch.approverSetHash !== pinnedApproverSetHash) {
    throw new Error(
      `finalizeEpoch: approver set hash integrity failure — stored hash ${epoch.approverSetHash} does not match recomputed ${pinnedApproverSetHash}`
    );
  }

  const typedData = buildEIP712TypedData({
    nodeId,
    scopeId,
    epochId: input.epochId,
    deploymentEnvironment,
    finalAllocationSetHash,
    poolTotalCredits: poolTotalCredits.toString(),
    chainId,
  });
  const isValid = await verifyTypedData({
    address: input.signerAddress as `0x${string}`,
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature: input.signature as `0x${string}`,
  });
  if (!isValid) {
    throw new FinalizeEpochError(
      "signature_invalid",
      `finalizeEpoch: signature verification failed for signer ${input.signerAddress}`
    );
  }
}

/** Output from finalizeEpoch. */
export interface FinalizeEpochOutput {
  readonly statementId: string;
  readonly poolTotalCredits: string; // bigint serialized
  readonly finalAllocationSetHash: string;
  readonly statementLineCount: number;
  /**
   * Settlement revision appended after the atomic finalize. Null when distributions
   * are inactive or every new liability is still unresolved. BUILT, never published.
   */
  readonly cumulativeDistribution: {
    readonly distributionId: string;
    readonly merkleRoot: string;
    readonly mintDelta: string; // bigint serialized — DAO mints exactly this
    readonly cumulativeTotal: string; // bigint serialized — total supply to date
    readonly leafCount: number;
    readonly tokenAddress: string;
    readonly chainId: number;
    /** Existing per-node distributor (null until R2 activation records it). */
    readonly distributorAddress: string | null;
  } | null;
}

function toEvaluationPayloadMap(
  evaluations: ReadonlyArray<{
    readonly evaluationRef: string;
    readonly payloadJson: Record<string, unknown> | null;
  }>
): ReadonlyMap<string, Record<string, unknown>> {
  const payloads = new Map<string, Record<string, unknown>>();
  for (const evaluation of evaluations) {
    if (evaluation.payloadJson) {
      payloads.set(evaluation.evaluationRef, evaluation.payloadJson);
    }
  }
  return payloads;
}

/**
 * Finalize an epoch: verify the approver's EIP-712 signature, atomically write the
 * off-chain statement + signature, then fold this epoch's deltas onto the cumulative
 * distribution manifest (R3). Idempotent — a re-POST repairs. Runtime-agnostic:
 * called from the Temporal activity (worker) and the node's finalize route (in-process).
 */
export async function runFinalizeEpoch(
  deps: RunFinalizeEpochDeps,
  input: FinalizeEpochInput
): Promise<FinalizeEpochOutput> {
  const {
    attributionStore,
    registries,
    nodeId,
    scopeId,
    chainId,
    tokenAddress,
    distributorAddress: repoSpecDistributorAddress,
    emissionsHolderAddress: repoSpecEmissionsHolderAddress,
    walletResolver,
    distributionConfigClient,
    deploymentEnvironment: unvalidatedDeploymentEnvironment,
    logger,
  } = deps;

  // SIGNATURE_DEPLOYMENT_BOUND: this is server-injected runtime config, never
  // finalize request input. Missing/unknown values abort before any mutation.
  const deploymentEnvironment = parseEIP712DeploymentEnvironment(
    unvalidatedDeploymentEnvironment
  );

  /**
   * Resolve the effective per-node distribution config for THIS runtime's node at fold
   * time (bug.5020). Order: (1) the per-node gateway (authoritative — the finalizing
   * node's own repo-spec); (2) on a transient gateway failure, the baked config (prod
   * continuity — a network blip must never skip a real distribution); (3) when the
   * gateway is unwired (null client), the baked config. A gateway that authoritatively
   * reports `distribution: null` (not activated) returns nulls here — NOT the baked
   * fallback — so a non-activated node correctly no-ops.
   */
  async function resolveEffectiveDistributionConfig(epochId: bigint): Promise<{
    readonly tokenAddress: string | null;
    readonly distributorAddress: string | null;
    readonly emissionsHolderAddress: string | null;
  }> {
    const baked = {
      tokenAddress,
      distributorAddress: repoSpecDistributorAddress,
      emissionsHolderAddress: repoSpecEmissionsHolderAddress ?? null,
    };
    if (!distributionConfigClient) {
      return baked;
    }
    try {
      const resolved = await distributionConfigClient.resolveForNode(nodeId);
      if (resolved.distribution) {
        return {
          tokenAddress: resolved.distribution.tokenAddress,
          distributorAddress: resolved.distribution.distributorAddress,
          emissionsHolderAddress: resolved.distribution.emissionsHolderAddress,
        };
      }
      // Authoritative "not activated" — do NOT fall back to baked config.
      logger.info(
        { epochId: epochId.toString(), nodeId, reason: resolved.reason },
        "Per-node distribution config inactive — cumulative fold will no-op"
      );
      return {
        tokenAddress: null,
        distributorAddress: null,
        emissionsHolderAddress: null,
      };
    } catch (err) {
      // TRANSIENT_IS_ERROR_NOT_NULL: the gateway threw (5xx/503/network). Never undo
      // the off-chain finalize; fall back to the baked config for our own node.
      logger.warn(
        {
          epochId: epochId.toString(),
          nodeId,
          err: err instanceof Error ? err.message : String(err),
        },
        "Per-node distribution config fetch failed — falling back to baked config (prod continuity)"
      );
      return baked;
    }
  }

  async function reconcileSettlementAfterFinalize(
    epochId: bigint,
    trigger: SettlementReconcileTrigger
  ): Promise<FinalizeEpochOutput["cumulativeDistribution"]> {
    const effective = await resolveEffectiveDistributionConfig(epochId);
    if (
      !effective.tokenAddress ||
      !effective.distributorAddress ||
      !walletResolver
    ) {
      logger.info(
        { epochId: epochId.toString(), nodeId },
        "Settlement reconciliation skipped — distributions not activated"
      );
      return null;
    }

    assertSettlementGovernanceTargetSafe({
      deploymentEnvironment,
      emissionsHolderAddress: effective.emissionsHolderAddress,
      context: `epoch ${epochId.toString()}`,
    });
    const result = await runReconcileSettlements(
      {
        settlementStore: attributionStore,
        walletResolver,
        nodeId,
        scopeId,
        chainId,
        tokenAddress: effective.tokenAddress,
        distributorAddress: effective.distributorAddress,
        logger,
      },
      trigger
    );
    if (result.status === "noop") return null;

    return {
      distributionId: result.distributionId,
      merkleRoot: result.merkleRoot,
      mintDelta: result.mintDelta.toString(),
      cumulativeTotal: result.cumulativeTotal.toString(),
      leafCount: result.leafCount,
      tokenAddress: effective.tokenAddress,
      chainId,
      distributorAddress: effective.distributorAddress,
    };
  }

  const epochId = BigInt(input.epochId);

  logger.info(
    { epochId: input.epochId, signerAddress: input.signerAddress },
    "Finalizing epoch"
  );

  // 1. Load epoch — verify exists and is review (or finalized for idempotency)
  const epoch = await attributionStore.getEpoch(epochId);
  if (!epoch) {
    throw new FinalizeEpochError(
      "epoch_not_found",
      `finalizeEpoch: epoch ${input.epochId} not found`
    );
  }

  // EPOCH_FINALIZE_IDEMPOTENT: already finalized → repair via atomic method
  if (epoch.status === "finalized") {
    logger.info(
      { epochId: input.epochId },
      "Epoch already finalized — repairing via finalizeEpochAtomic"
    );
    const existing = await attributionStore.getStatementForEpoch(epochId);
    if (!existing) {
      throw new Error(
        `finalizeEpoch: epoch ${input.epochId} is finalized but no statement found`
      );
    }

    // A repair may add a missing signature, so it must satisfy the exact same
    // pinned-approver and EIP-712 checks as the original finalization. The
    // already-signed statement is the immutable message being authorized.
    await verifyFinalizeAuthorization({
      epoch,
      input,
      nodeId,
      scopeId,
      deploymentEnvironment,
      finalAllocationSetHash: existing.finalAllocationSetHash,
      poolTotalCredits: existing.poolTotalCredits,
      chainId,
    });

    // Repair: ensure this signer's signature exists via atomic method
    await attributionStore.finalizeEpochAtomic({
      epochId,
      poolTotal: existing.poolTotalCredits,
      finalClaimantAllocations: await attributionStore
        .getFinalClaimantAllocationsForEpoch(epochId)
        .then((allocations) =>
          allocations.map((allocation) => ({
            nodeId: allocation.nodeId,
            epochId: allocation.epochId,
            claimantKey: allocation.claimantKey,
            claimant: allocation.claimant,
            finalUnits: allocation.finalUnits,
            receiptIds: allocation.receiptIds,
          }))
        ),
      statement: {
        nodeId,
        finalAllocationSetHash: existing.finalAllocationSetHash,
        poolTotalCredits: existing.poolTotalCredits,
        statementLines: existing.statementLines,
      },
      claimantLiabilities: existing.statementLines
        .filter((line) => BigInt(line.credit_amount) > 0n)
        .map((line) => ({
          claimantKey: line.claimant_key,
          amountAtomic: BigInt(line.credit_amount) * TOKEN_BASE_UNITS,
          receiptIds: [...line.receipt_ids].sort(),
        })),
      signature: {
        nodeId,
        signerWallet: input.signerAddress,
        signature: input.signature,
        signedAt: new Date(),
      },
      expectedFinalAllocationSetHash: existing.finalAllocationSetHash,
    });

    // Repair also materializes any missing liabilities and retries reconciliation.
    let repairCumulative: FinalizeEpochOutput["cumulativeDistribution"] = null;
    try {
      repairCumulative = await reconcileSettlementAfterFinalize(epochId, {
        kind: "epoch_finalize",
        epochId: epochId.toString(),
      });
    } catch (err) {
      logger.error(
        {
          epochId: input.epochId,
          err: err instanceof Error ? err.message : String(err),
        },
        "Cumulative distribution repair failed — epoch stays finalized"
      );
    }

    return {
      statementId: existing.id,
      poolTotalCredits: existing.poolTotalCredits.toString(),
      finalAllocationSetHash: existing.finalAllocationSetHash,
      statementLineCount: existing.statementLines.length,
      cumulativeDistribution: repairCumulative,
    };
  }

  if (epoch.status !== "review") {
    throw new FinalizeEpochError(
      "epoch_not_in_review",
      `finalizeEpoch: epoch ${input.epochId} is '${epoch.status}', expected 'review'`
    );
  }

  // 2. CONFIG_LOCKED_AT_REVIEW: verify config is locked
  if (!epoch.allocationAlgoRef || !epoch.weightConfigHash) {
    throw new FinalizeEpochError(
      "config_not_locked",
      `finalizeEpoch: epoch ${input.epochId} missing allocation_algo_ref or weight_config_hash (CONFIG_LOCKED_AT_REVIEW violated)`
    );
  }

  // 3. Load pool components → pool_total = SUM(amount_credits)
  const poolComponents =
    await attributionStore.getPoolComponentsForEpoch(epochId);
  if (poolComponents.length === 0) {
    throw new FinalizeEpochError(
      "no_pool_components",
      `finalizeEpoch: epoch ${input.epochId} has no pool components (POOL_REQUIRES_BASE)`
    );
  }
  const hasBaseIssuance = poolComponents.some(
    (c) => c.componentId === "base_issuance"
  );
  if (!hasBaseIssuance) {
    throw new FinalizeEpochError(
      "missing_base_issuance",
      `finalizeEpoch: epoch ${input.epochId} missing base_issuance component (POOL_REQUIRES_BASE)`
    );
  }

  const poolTotal = poolComponents.reduce(
    (sum, c) => sum + c.amountCredits,
    0n
  );

  // 4. Load locked claimants + receipt weights + overrides → explode to claimant allocations
  const lockedClaimants = await attributionStore.loadLockedClaimants(epochId);
  if (lockedClaimants.length === 0) {
    throw new FinalizeEpochError(
      "no_locked_claimants",
      `finalizeEpoch: epoch ${input.epochId} has no locked claimant rows`
    );
  }

  const [selections, overrideRecords] = await Promise.all([
    attributionStore.getSelectedReceiptsForAllocation(epochId),
    attributionStore.getReviewSubjectOverridesForEpoch(epochId),
  ]);
  const rawWeights = await dispatchAllocator(
    registries.allocators,
    epoch.allocationAlgoRef,
    {
      receipts: selections,
      weightConfig: epoch.weightConfig,
      evaluations: toEvaluationPayloadMap(
        await attributionStore.getEvaluationsForEpoch(epochId, "locked")
      ),
      profileConfig: null,
    }
  );
  const overrides = toReviewSubjectOverrides(overrideRecords);
  const receiptWeights = applyReceiptWeightOverrides(rawWeights, overrides);

  const finalClaimantAllocations = explodeToClaimants(
    receiptWeights,
    lockedClaimants,
    overrides
  );
  if (finalClaimantAllocations.length === 0) {
    throw new FinalizeEpochError(
      "no_claimant_allocations",
      `finalizeEpoch: epoch ${input.epochId} has no claimant allocations`
    );
  }

  // Build override audit trail for statement persistence
  const reviewOverrideSnapshots = buildReceiptWeightOverrideSnapshots(
    rawWeights,
    lockedClaimants,
    overrides
  );

  // 5. Compute statement lines from final allocations
  const statementLines = computeAttributionStatementLines(
    finalClaimantAllocations,
    poolTotal
  );

  // 6. Compute allocation set hash (deterministic)
  const finalAllocationSetHash = await computeFinalClaimantAllocationSetHash(
    finalClaimantAllocations
  );

  // 7. Verify the pinned signer and EIP-712 authorization.
  await verifyFinalizeAuthorization({
    epoch,
    input,
    nodeId,
    scopeId,
    deploymentEnvironment,
    finalAllocationSetHash,
    poolTotalCredits: poolTotal,
    chainId,
  });

  // 8. Atomic finalize — epoch transition + statement + signature in one transaction
  const { epoch: finalizedEpoch, statement } =
    await attributionStore.finalizeEpochAtomic({
      epochId,
      poolTotal,
      finalClaimantAllocations: finalClaimantAllocations.map((allocation) => ({
        nodeId,
        epochId,
        claimantKey: claimantKey(allocation.claimant),
        claimant: allocation.claimant,
        finalUnits: allocation.finalUnits,
        receiptIds: [...(allocation.receiptIds ?? [])],
      })),
      statement: {
        nodeId,
        finalAllocationSetHash,
        poolTotalCredits: poolTotal,
        statementLines: statementLines.map((line) => ({
          claimant_key: line.claimantKey,
          claimant: line.claimant,
          final_units: line.finalUnits.toString(),
          pool_share: line.poolShare,
          credit_amount: line.creditAmount.toString(),
          receipt_ids: [...line.receiptIds],
        })),
        reviewOverrides:
          reviewOverrideSnapshots.length > 0 ? reviewOverrideSnapshots : null,
      },
      claimantLiabilities: statementLines
        .filter((line) => line.creditAmount > 0n)
        .map((line) => ({
          claimantKey: line.claimantKey,
          amountAtomic: line.creditAmount * TOKEN_BASE_UNITS,
          receiptIds: [...line.receiptIds].sort(),
        })),
      signature: {
        nodeId,
        signerWallet: input.signerAddress,
        signature: input.signature,
        signedAt: new Date(),
      },
      expectedFinalAllocationSetHash: finalAllocationSetHash,
    });

  logger.info(
    {
      epochId: input.epochId,
      statementId: statement.id,
      poolTotalCredits: poolTotal.toString(),
      finalAllocationSetHash: `${finalAllocationSetHash.slice(0, 12)}...`,
      statementLineCount: statementLines.length,
      status: finalizedEpoch.status,
    },
    "Epoch finalized"
  );

  // Reconciliation runs after the atomic seal. A resolver/build failure cannot undo
  // the signed statement or its durable liabilities; normal retries can heal it.
  let cumulativeDistribution: FinalizeEpochOutput["cumulativeDistribution"] =
    null;
  try {
    cumulativeDistribution = await reconcileSettlementAfterFinalize(epochId, {
      kind: "epoch_finalize",
      epochId: epochId.toString(),
    });
  } catch (err) {
    logger.error(
      {
        epochId: input.epochId,
        err: err instanceof Error ? err.message : String(err),
      },
      "Cumulative distribution build failed AFTER finalize — epoch stays finalized; retry/repair on next finalize call"
    );
  }

  return {
    statementId: statement.id,
    poolTotalCredits: poolTotal.toString(),
    finalAllocationSetHash,
    statementLineCount: statementLines.length,
    cumulativeDistribution,
  };
}

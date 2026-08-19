// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/settlement-runtime`
 * Purpose: Composition-root wiring for settlement reconciliation and live distributor reads.
 * Scope: Builds concrete settlement dependencies from this node's service DB/repo spec and reads merkleRoot on-chain. Contains no HTTP or auth-flow policy.
 * Invariants: NODE_SCOPED, BINDING_COMMIT_PRECEDES_RECONCILE, LIVE_ROOT_IS_CHAIN_AUTHORITY.
 * Side-effects: IO (service DB and EVM RPC).
 * Links: packages/attribution-pipeline-plugins/src/settlement/run-reconcile-settlements.ts
 * @public
 */

import {
  assertSettlementGovernanceTargetSafe,
  type ReconcileSettlementsResult,
  retryPendingSettlements,
  type RunReconcileSettlementsDeps,
  runReconcileSettlements,
  type SettlementLogger,
} from "@cogni/attribution-pipeline-plugins";
import {
  DrizzleAttributionAdapter,
  DrizzleClaimantWalletResolver,
} from "@cogni/db-client";
import { CHAINS } from "@cogni/node-shared";
import { type Address, createPublicClient, http } from "viem";
import { base, sepolia } from "viem/chains";

import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import {
  getEmissionsHolderAddress,
  getNodeId,
  getNodeTokenomicsConfig,
  getScopeId,
} from "@/shared/config";
import { serverEnv } from "@/shared/env";

const VIEM_CHAINS_BY_ID: Record<number, typeof base | typeof sepolia> = {
  [CHAINS.BASE.chainId]: base,
  [CHAINS.SEPOLIA.chainId]: sepolia,
};

const MERKLE_ROOT_ABI = [
  {
    type: "function",
    name: "merkleRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

function buildSettlementReconcileDeps(
  logger: SettlementLogger
): RunReconcileSettlementsDeps {
  const serviceDb = getServiceDb();
  const tokenomics = getNodeTokenomicsConfig();
  const walletResolver = tokenomics.tokenAddress
    ? new DrizzleClaimantWalletResolver(serviceDb)
    : null;
  if (
    tokenomics.tokenAddress &&
    tokenomics.distributorAddress &&
    walletResolver
  ) {
    assertSettlementGovernanceTargetSafe({
      deploymentEnvironment: serverEnv().DEPLOY_ENVIRONMENT,
      emissionsHolderAddress: getEmissionsHolderAddress(),
      context: "settlement reconciliation",
    });
  }
  return {
    settlementStore: new DrizzleAttributionAdapter(serviceDb, getScopeId()),
    walletResolver,
    nodeId: getNodeId(),
    scopeId: getScopeId(),
    chainId: tokenomics.chainId,
    tokenAddress: tokenomics.tokenAddress,
    distributorAddress: tokenomics.distributorAddress,
    logger,
  };
}

/** Best-effort repair trigger after a newly committed identity binding. */
export function reconcileSettlementsAfterBinding(
  eventId: string,
  logger: SettlementLogger
): Promise<ReconcileSettlementsResult> {
  return runReconcileSettlements(buildSettlementReconcileDeps(logger), {
    kind: "identity_binding",
    eventId,
  });
}

/** Controlled retry hook for the node's normal collection cadence. */
export function reconcilePendingSettlements(
  logger: SettlementLogger
): Promise<ReconcileSettlementsResult> {
  return retryPendingSettlements(buildSettlementReconcileDeps(logger));
}

/**
 * Read the root currently accepted by the distributor. Null means the chain
 * authority could not be established; money-moving callers must fail closed.
 */
export async function readLiveDistributionMerkleRoot(
  chainId: number,
  distributorAddress: string
): Promise<string | null> {
  const viemChain = VIEM_CHAINS_BY_ID[chainId];
  const rpcUrl = serverEnv().EVM_RPC_URL;
  if (!viemChain || !rpcUrl) return null;

  try {
    const client = createPublicClient({
      chain: viemChain,
      transport: http(rpcUrl),
    });
    return await client.readContract({
      address: distributorAddress as Address,
      abi: MERKLE_ROOT_ABI,
      functionName: "merkleRoot",
    });
  } catch {
    return null;
  }
}

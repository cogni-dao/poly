// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/hooks/useExecuteDistribution`
 * Purpose: React hooks powering the two-state distribution PUBLISH surface.
 *   - `useExecuteDistribution` fetches the publish payload for a finalized epoch — the mint delta,
 *     new merkle root, distributor/token/DAO/plugin addresses, and chain — so the owner's wallet can
 *     build the mint + setMerkleRoot actions. Read-only: the write is the caller's wagmi hook.
 *   - `useHasExecutePermission` uses paired permission probes so only strict compare-and-swap
 *     authority may expose publish; every other permission shape fails closed.
 * Scope: Client-side. SINGLE-NODE — the payload fetch hits THIS node's authed epoch route
 *   (`/api/v1/attribution/epochs/[id]/distribution-tx`) same-origin with the session cookie; there is
 *   no `nodes/[id]` gateway segment. The permission read is a pure on-chain view call. Neither
 *   performs DB access or write txs.
 * Invariants:
 *   - NODE_SCOPED (single-node): the route resolves governance addresses from THIS node's repo-spec.
 *   - ALL_MATH_BIGINT: mintDelta arrives as a decimal string; callers BigInt() it before display/tx.
 *   - READ_ONLY_SERVES_R3: the payload is exactly what R3 persisted; the hook never mutates state.
 *   - CALMLY_NULL_ON_NOT_READY: 404 (epoch) and 409 (not finalized / no manifest / no distributor)
 *     resolve to a typed not-ready reason rather than throwing, so the panel can render a quiet
 *     "not ready yet" state.
 *   - PERMISSION_GATES_UI: strict CAS returns valid=true/allowFailure=true? false; every other
 *     permission shape fails closed and sends setup back to the canonical operator surface.
 * Side-effects: IO (HTTP GET to the authed distribution-tx route; on-chain hasPermission read).
 * Links: src/app/api/v1/attribution/epochs/[id]/distribution-tx/route.ts,
 *   src/features/governance/lib/proposal-abis.ts
 * @public
 */

import { useQuery } from "@tanstack/react-query";
import { parseAbi } from "viem";
import { useReadContract } from "wagmi";

import {
  buildPublishProbeData,
  classifyPublishPermission,
  type PublishPermissionState,
  DAO_ABI,
  EXECUTE_PERMISSION_ID,
} from "@/features/governance/lib/proposal-abis";

const DISTRIBUTOR_ROOT_ABI = parseAbi([
  "function merkleRoot() view returns (bytes32)",
]);

export interface ExecuteDistributionPayload {
  readonly epochId: string;
  readonly settlementRevisionId: string;
  readonly settlementSequence: number;
  readonly merkleRoot: `0x${string}`;
  /** Cumulative-delta to mint, in base units (decimal string). BigInt() before use. */
  readonly mintDelta: string;
  readonly distributorAddress: `0x${string}`;
  readonly tokenAddress: `0x${string}`;
  readonly daoAddress: `0x${string}`;
  readonly pluginAddress: `0x${string}`;
  readonly chainId: number;
  /** Expected previous root encoded as DAO.execute callId for CAS V2. */
  readonly alreadyExecutedRoot: `0x${string}`;
}

/** A distribution can't be executed yet (finalized-but-unrecorded, etc.). */
export type NotReadyReason =
  | "epoch_not_found"
  | "node_not_found"
  | "epoch_not_finalized"
  | "no_settlement_revision"
  | "distributor_not_recorded"
  | "node_missing_governance"
  | "negative_mint_delta"
  | "live_root_unavailable"
  | "live_root_unknown"
  | "live_root_not_ancestor"
  | "already_published";

interface ExecuteDistributionResult {
  readonly payload: ExecuteDistributionPayload | null;
  readonly notReady: NotReadyReason | null;
}

async function fetchExecutePayload(
  epochId: string
): Promise<ExecuteDistributionResult> {
  const res = await fetch(
    `/api/v1/attribution/epochs/${encodeURIComponent(epochId)}/distribution-tx`,
    {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    }
  );

  if (res.status === 404 || res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { payload: null, notReady: (body.error ?? null) as NotReadyReason };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }

  const payload = (await res.json()) as ExecuteDistributionPayload;
  return { payload, notReady: null };
}

export interface UseExecuteDistribution {
  readonly payload: ExecuteDistributionPayload | null;
  readonly notReady: NotReadyReason | null;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly refetch: () => void;
}

/**
 * Resolve the execute payload for `epochId` (single-node: THIS node's epoch route). `enabled` gates
 * the fetch (e.g. only run when the epoch is finalized and a distributor is recorded).
 */
export function useExecuteDistribution(
  epochId: string | undefined,
  enabled = true
): UseExecuteDistribution {
  const active = enabled && Boolean(epochId);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["governance", "execute-distribution", epochId],
    queryFn: () => fetchExecutePayload(epochId as string),
    enabled: active,
    staleTime: 30_000,
  });

  return {
    payload: data?.payload ?? null,
    notReady: data?.notReady ?? null,
    isLoading,
    error: error as Error | null,
    refetch: () => {
      void refetch();
    },
  };
}

export interface UseHasExecutePermission {
  /** True only for the CAS V2 condition. Legacy/unconditional grants fail closed. */
  readonly hasPermission: boolean | undefined;
  readonly permissionState: PublishPermissionState;
  readonly isLoading: boolean;
  readonly error: Error | null;
  /** Re-read after the authorize tx confirms so the UI advances to Publish. */
  readonly refetch: () => void;
}

/**
 * Read `DAO.hasPermission(_where=DAO, _who=wallet, EXECUTE_PERMISSION, <publish probe>)` on
 * chain. The grant is SCOPED via `DistributionPublishCondition`, so the probe `_data` must be
 * a representative publish call (`execute([mint(distributor,0), setMerkleRoot(0)])`) or the
 * condition denies it — see `buildPublishProbeData`. Gates the publish surface: false ⇒ show
 * the one-time authorize step, true ⇒ show the per-epoch direct execute. Disabled (undefined)
 * until DAO + wallet + token + distributor are all present.
 */
export function useHasExecutePermission(params: {
  daoAddress: `0x${string}` | undefined;
  wallet: `0x${string}` | undefined;
  tokenAddress: `0x${string}` | undefined | null;
  distributorAddress: `0x${string}` | undefined | null;
  chainId: number | undefined;
}): UseHasExecutePermission {
  const { daoAddress, wallet, tokenAddress, distributorAddress, chainId } =
    params;
  const enabled =
    Boolean(daoAddress) &&
    Boolean(wallet) &&
    Boolean(tokenAddress) &&
    Boolean(distributorAddress);

  const {
    data: liveRoot,
    isLoading: isRootLoading,
    error: rootError,
    refetch: refetchRoot,
  } = useReadContract({
    abi: DISTRIBUTOR_ROOT_ABI,
    address: distributorAddress ?? undefined,
    functionName: "merkleRoot",
    chainId,
    query: { enabled },
  });
  const expectedRoot = typeof liveRoot === "string" ? liveRoot : undefined;
  const rootReady = expectedRoot !== undefined;
  const validProbeData =
    tokenAddress && distributorAddress && expectedRoot
      ? buildPublishProbeData(
          tokenAddress,
          distributorAddress,
          expectedRoot,
          0n
        )
      : "0x";
  const invalidFailureProbeData =
    tokenAddress && distributorAddress && expectedRoot
      ? buildPublishProbeData(
          tokenAddress,
          distributorAddress,
          expectedRoot,
          1n
        )
      : "0x";

  const validProbe = useReadContract({
    abi: DAO_ABI,
    address: daoAddress,
    functionName: "hasPermission",
    // _where=DAO, _who=wallet, _permissionId=EXECUTE_PERMISSION, _data=<publish probe>
    args: [
      daoAddress ?? "0x0000000000000000000000000000000000000000",
      wallet ?? "0x0000000000000000000000000000000000000000",
      EXECUTE_PERMISSION_ID,
      validProbeData,
    ],
    chainId,
    query: { enabled: enabled && rootReady },
  });
  const invalidFailureProbe = useReadContract({
    abi: DAO_ABI,
    address: daoAddress,
    functionName: "hasPermission",
    args: [
      daoAddress ?? "0x0000000000000000000000000000000000000000",
      wallet ?? "0x0000000000000000000000000000000000000000",
      EXECUTE_PERMISSION_ID,
      invalidFailureProbeData,
    ],
    chainId,
    query: { enabled: enabled && rootReady },
  });

  const permissionState = classifyPublishPermission(
    validProbe.data as boolean | undefined,
    invalidFailureProbe.data as boolean | undefined
  );

  return {
    hasPermission:
      permissionState === "loading"
        ? undefined
        : permissionState === "authorized",
    permissionState,
    isLoading:
      isRootLoading || validProbe.isLoading || invalidFailureProbe.isLoading,
    error: (rootError ??
      validProbe.error ??
      invalidFailureProbe.error ??
      null) as Error | null,
    refetch: () => {
      void refetchRoot();
      void validProbe.refetch();
      void invalidFailureProbe.refetch();
    },
  };
}

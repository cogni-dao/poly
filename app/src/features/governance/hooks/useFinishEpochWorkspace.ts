// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/hooks/useFinishEpochWorkspace`
 * Purpose: Select and load the single oldest governance action that an epoch admin should finish next.
 * Scope: Client-side reads and pure selection only. Reuses existing review, finalize, and publish writers.
 * Invariants: REVIEW_BEFORE_OPEN_BEFORE_PUBLISH, OLDEST_FIRST, UNKNOWN_PUBLICATION_FAILS_CLOSED.
 * Side-effects: IO (authenticated epoch and settlement lifecycle reads)
 * Links: packages/node-contracts/src/attribution.settlement-lifecycle.v1.contract.ts, task.5038
 * @public
 */

import { type UseQueryResult, useQuery } from "@tanstack/react-query";

import type {
  ApiIngestionReceipt,
  EpochDto,
  UserProjectionDto,
} from "@/features/governance/lib/compose-epoch";
import { composeEpochView } from "@/features/governance/lib/compose-epoch";
import type { EpochView } from "@/features/governance/types";

export interface AdminEpochDto extends EpochDto {
  readonly approvers: readonly string[] | null;
}

export interface EpochSettlementLifecycle {
  readonly epochId: string;
  readonly liabilityCount: number;
  readonly settledLiabilityCount: number;
  readonly publishedLiabilityCount: number | null;
}

export interface SettlementLifecycle {
  readonly publicationEvidence: "matched" | "not_published" | "unknown";
  readonly liveRevision: {
    readonly sequence: string;
    readonly merkleRoot: string;
    readonly cumulativeTotal: string;
  } | null;
  readonly latestRevision: {
    readonly sequence: string;
    readonly merkleRoot: string;
    readonly cumulativeTotal: string;
  } | null;
  readonly epochs: readonly EpochSettlementLifecycle[];
}

export type FinishEpochWorkKind = "open_review" | "finalize" | "publish";

export interface FinishEpochSelection {
  readonly kind: FinishEpochWorkKind;
  readonly epoch: AdminEpochDto;
  readonly lifecycle: EpochSettlementLifecycle | null;
}

export interface FinishEpochWorkspaceData {
  readonly selection: FinishEpochSelection | null;
  readonly epochView: EpochView | null;
  readonly lifecycleUnavailable: boolean;
}

function oldestFirst(a: AdminEpochDto, b: AdminEpochDto): number {
  const periodOrder = Date.parse(a.periodEnd) - Date.parse(b.periodEnd);
  if (periodOrder !== 0) return periodOrder;
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

function latestSettlementIsPending(
  lifecycle: SettlementLifecycle | null
): boolean {
  if (!lifecycle?.latestRevision) return false;
  if (lifecycle.publicationEvidence === "unknown") return false;
  if (lifecycle.publicationEvidence === "not_published") return true;
  if (!lifecycle.liveRevision) return false;
  return (
    lifecycle.liveRevision.merkleRoot.toLowerCase() !==
    lifecycle.latestRevision.merkleRoot.toLowerCase()
  );
}

/** Pure priority policy used by the Review workspace and its unit tests. */
export function selectFinishEpochWork(
  epochs: readonly AdminEpochDto[],
  lifecycle: SettlementLifecycle | null,
  nowMs: number
): FinishEpochSelection | null {
  const ordered = [...epochs].sort(oldestFirst);
  const review = ordered.find((epoch) => epoch.status === "review");
  if (review) return { kind: "finalize", epoch: review, lifecycle: null };

  const endedOpen = ordered.find(
    (epoch) =>
      epoch.status === "open" &&
      Number.isFinite(Date.parse(epoch.periodEnd)) &&
      Date.parse(epoch.periodEnd) <= nowMs
  );
  if (endedOpen) {
    return { kind: "open_review", epoch: endedOpen, lifecycle: null };
  }

  if (!latestSettlementIsPending(lifecycle) || !lifecycle) return null;
  const lifecycleByEpoch = new Map(
    lifecycle.epochs.map((epoch) => [epoch.epochId, epoch])
  );
  const publishEpoch = [...ordered].reverse().find((epoch) => {
    if (epoch.status !== "finalized") return false;
    const progress = lifecycleByEpoch.get(epoch.id);
    if (!progress || progress.settledLiabilityCount === 0) return false;
    return (
      progress.publishedLiabilityCount === null ||
      progress.publishedLiabilityCount < progress.settledLiabilityCount
    );
  });

  return publishEpoch
    ? {
        kind: "publish",
        epoch: publishEpoch,
        lifecycle: lifecycleByEpoch.get(publishEpoch.id) ?? null,
      }
    : null;
}

/** Current approvers open review; an epoch's pinned set owns later actions. */
export function isEligibleForFinishEpochWork(params: {
  readonly selection: FinishEpochSelection;
  readonly walletAddress: string | null;
  readonly isCurrentApprover: boolean;
}): boolean {
  if (!params.walletAddress) return false;
  if (params.selection.kind === "open_review") {
    return params.isCurrentApprover;
  }
  const pinned = params.selection.epoch.approvers;
  if (!pinned || pinned.length === 0) return params.isCurrentApprover;
  const wallet = params.walletAddress.toLowerCase();
  return pinned.some((approver) => approver.toLowerCase() === wallet);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  return response.json() as Promise<T>;
}

async function composeSelectedEpoch(epoch: AdminEpochDto): Promise<EpochView> {
  const [projections, activity] = await Promise.all([
    fetchJson<{ userProjections: UserProjectionDto[] }>(
      `/api/v1/attribution/epochs/${epoch.id}/user-projections`
    ),
    fetchJson<{ events: ApiIngestionReceipt[] }>(
      `/api/v1/attribution/epochs/${epoch.id}/activity?limit=200`
    ),
  ]);
  return composeEpochView(epoch, projections.userProjections, activity.events);
}

async function fetchFinishEpochWorkspace(): Promise<FinishEpochWorkspaceData> {
  const [epochResponse, lifecycleResponse] = await Promise.all([
    fetchJson<{ epochs: AdminEpochDto[] }>(
      "/api/v1/attribution/epochs?limit=200"
    ),
    fetchJson<SettlementLifecycle>(
      "/api/v1/attribution/settlement-lifecycle"
    ).then(
      (value) => ({ value, unavailable: false as const }),
      () => ({ value: null, unavailable: true as const })
    ),
  ]);

  const selection = selectFinishEpochWork(
    epochResponse.epochs,
    lifecycleResponse.value,
    Date.now()
  );
  const epochView =
    selection?.kind === "open_review" || selection?.kind === "finalize"
      ? await composeSelectedEpoch(selection.epoch)
      : null;

  return {
    selection,
    epochView,
    lifecycleUnavailable:
      lifecycleResponse.unavailable ||
      lifecycleResponse.value?.publicationEvidence === "unknown",
  };
}

export function useFinishEpochWorkspace(): UseQueryResult<
  FinishEpochWorkspaceData,
  Error
> {
  return useQuery({
    queryKey: ["governance", "finish-epoch"],
    queryFn: fetchFinishEpochWorkspace,
    staleTime: 15_000,
  });
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/domain/target-book`
 * Purpose: Immutable v1 contract between target-book reads and position-gap allocation.
 * Scope: Types only. Data-API and cache implementations live in the Polymarket adapter.
 * Invariants: COMPLETE_BINARY_BOOK, STRUCTURAL_TRUTH_ONLY, NO_EXECUTION_CONSTRAINTS.
 * Side-effects: none
 * Links: story.5015, task.1791070972
 * @public
 */

/** One outcome token in a cursor-complete binary Polymarket condition. */
export type TargetBookTokenV1 = Readonly<{
  tokenId: string;
  oppositeTokenId: string;
  outcomeIndex: number;
  shares: number;
  markPrice: number;
  averagePrice: number;
}>;

/**
 * One structurally OPEN binary condition.
 *
 * `endDate` is metadata only. Date-only values never decide eligibility because
 * Polymarket sports markets routinely remain orderable after UTC midnight.
 */
export type TargetBookConditionV1 = Readonly<{
  conditionId: string;
  status: "OPEN";
  redeemable: false;
  endDate: string | null;
  negativeRisk: boolean;
  tokens: readonly [TargetBookTokenV1, TargetBookTokenV1];
}>;

/** Bounded evidence describing the refresh that published this snapshot. */
export type TargetBookRefreshStatsV1 = Readonly<{
  kind: "full" | "dirty";
  discoveryRows: number;
  conditionCount: number;
  dataApiCalls: number;
}>;

/** A complete, immutable target book. Partial snapshots are unrepresentable. */
export type TargetBookSnapshotV1 = Readonly<{
  version: 1;
  snapshotId: string;
  targetWallet: string;
  fullRefreshAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  complete: true;
  refreshStats: TargetBookRefreshStatsV1;
  conditions: readonly TargetBookConditionV1[];
}>;

/** Stable fail-closed reasons suitable for logs, metrics, and agent reads. */
export type TargetBookRefreshFailureReasonV1 =
  | "aborted"
  | "condition_limit"
  | "incomplete"
  | "malformed"
  | "missing_snapshot"
  | "request_budget"
  | "stale_snapshot"
  | "upstream";

/**
 * Refreshes publish atomically. A failure names the retained last-good snapshot
 * explicitly so callers cannot mistake stale retained data for fresh success.
 */
export type TargetBookRefreshResultV1 =
  | Readonly<{
      published: true;
      snapshot: TargetBookSnapshotV1;
    }>
  | Readonly<{
      published: false;
      reason: TargetBookRefreshFailureReasonV1;
      retainedSnapshotId: string | null;
    }>;

export type TargetBookRefreshOptionsV1 = Readonly<{
  signal?: AbortSignal;
}>;

/** Passive cache/provider contract; scheduling and triggers belong to runtime. */
export interface TargetBookProviderV1 {
  /** Zero-I/O read. Missing or expired snapshots return `null`. */
  readFresh(targetWallet: string): TargetBookSnapshotV1 | null;
  refreshFull(
    targetWallet: string,
    options?: TargetBookRefreshOptionsV1
  ): Promise<TargetBookRefreshResultV1>;
  refreshDirty(
    targetWallet: string,
    conditionIds: readonly string[],
    options?: TargetBookRefreshOptionsV1
  ): Promise<TargetBookRefreshResultV1>;
  invalidate(targetWallet: string): void;
}

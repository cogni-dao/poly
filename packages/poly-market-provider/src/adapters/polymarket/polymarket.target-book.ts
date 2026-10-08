// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/adapters/polymarket/polymarket.target-book`
 * Purpose: Bounded, immutable last-good target-book cache over Data API V2.
 * Scope: Structural target holdings only; no allocation or venue execution truth.
 * Invariants: COMPLETE_BINARY_BOOK, ATOMIC_PUBLISH, FAIL_CLOSED, BOUNDED_REFRESH.
 * Side-effects: Data API reads and process-local cache mutation.
 * Links: story.5015, task.1791070972
 * @public
 */

import type {
  TargetBookConditionV1,
  TargetBookProviderV1,
  TargetBookRefreshFailureReasonV1,
  TargetBookRefreshOptionsV1,
  TargetBookRefreshResultV1,
  TargetBookSnapshotV1,
  TargetBookTokenV1,
} from "../../domain/target-book.js";
import type { PolymarketUserPositionV2 } from "./polymarket.data-api-v2.types.js";
import {
  PolyDataApiPositionsV2Error,
  type PolymarketPositionsV2Walk,
} from "./polymarket.data-api.client.js";

const CONDITION_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TOKEN_ID_PATTERN = /^\d+$/;
const MAX_CONDITIONS = 500;
const MAX_DIRTY_CONDITIONS = 100;
const MAX_FULL_DATA_API_CALLS = 30;
const MAX_DIRTY_DATA_API_CALLS = 5;
const DEFAULT_TTL_MS = 10 * 60 * 1_000;

export interface PolymarketTargetBookDataSourceV1 {
  listPositiveOpenUserPositionsV2(
    wallet: string,
    params?: { signal?: AbortSignal | undefined }
  ): Promise<PolymarketPositionsV2Walk>;
  listUserPositionsV2Raw(
    wallet: string,
    params: {
      conditions: readonly string[];
      includeArchived?: boolean;
      maxRequests?: number;
      signal?: AbortSignal | undefined;
    }
  ): Promise<PolymarketPositionsV2Walk>;
}

export interface PolymarketTargetBookProviderV1Config {
  dataSource: PolymarketTargetBookDataSourceV1;
  now?: () => number;
  ttlMs?: number;
}

export function createPolymarketTargetBookProviderV1(
  config: PolymarketTargetBookProviderV1Config
): TargetBookProviderV1 {
  const now = config.now ?? Date.now;
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Target-book ttlMs must be positive and finite");
  }

  const snapshots = new Map<string, TargetBookSnapshotV1>();
  let revision = 0;

  function retainedId(wallet: string): string | null {
    return snapshots.get(wallet)?.snapshotId ?? null;
  }

  function failed(
    wallet: string,
    reason: TargetBookRefreshFailureReasonV1
  ): TargetBookRefreshResultV1 {
    return {
      published: false,
      reason,
      retainedSnapshotId: retainedId(wallet),
    };
  }

  function publish(
    wallet: string,
    snapshot: Omit<TargetBookSnapshotV1, "snapshotId">
  ): TargetBookRefreshResultV1 {
    revision += 1;
    const complete = deepFreeze({
      ...snapshot,
      snapshotId: `${wallet}:${snapshot.updatedAtMs}:${revision}`,
    });
    snapshots.set(wallet, complete);
    return { published: true, snapshot: complete };
  }

  return {
    readFresh(targetWallet) {
      const wallet = normalizeWallet(targetWallet);
      const snapshot = snapshots.get(wallet);
      return snapshot && now() <= snapshot.expiresAtMs ? snapshot : null;
    },

    async refreshFull(targetWallet, options) {
      const wallet = tryNormalizeWallet(targetWallet);
      if (!wallet) {
        return {
          published: false,
          reason: "malformed",
          retainedSnapshotId: null,
        };
      }
      try {
        options?.signal?.throwIfAborted();
        const discovery =
          await config.dataSource.listPositiveOpenUserPositionsV2(wallet, {
            signal: options?.signal,
          });
        assertActiveDiscovery(discovery.positions);
        const conditionIds = uniqueConditionIds(discovery.positions);
        if (conditionIds.length > MAX_CONDITIONS) {
          return failed(wallet, "condition_limit");
        }
        if (discovery.requestCount > MAX_FULL_DATA_API_CALLS) {
          return failed(wallet, "request_budget");
        }

        const hydration =
          conditionIds.length === 0
            ? { positions: [], requestCount: 0 }
            : await config.dataSource.listUserPositionsV2Raw(wallet, {
                conditions: conditionIds,
                includeArchived: false,
                maxRequests:
                  MAX_FULL_DATA_API_CALLS - discovery.requestCount,
                signal: options?.signal,
              });
        const dataApiCalls = discovery.requestCount + hydration.requestCount;
        if (dataApiCalls > MAX_FULL_DATA_API_CALLS) {
          return failed(wallet, "request_budget");
        }
        assertRowsInCohort(hydration.positions, conditionIds);
        const conditions = buildConditions(hydration.positions);
        const timestamp = now();
        return publish(wallet, {
          version: 1,
          targetWallet: wallet,
          fullRefreshAtMs: timestamp,
          updatedAtMs: timestamp,
          expiresAtMs: timestamp + ttlMs,
          complete: true,
          refreshStats: {
            kind: "full",
            discoveryRows: discovery.positions.length,
            conditionCount: conditions.length,
            dataApiCalls,
          },
          conditions,
        });
      } catch (error) {
        return failed(wallet, classifyFailure(error, options));
      }
    },

    async refreshDirty(targetWallet, conditionIds, options) {
      const wallet = tryNormalizeWallet(targetWallet);
      if (!wallet) {
        return {
          published: false,
          reason: "malformed",
          retainedSnapshotId: null,
        };
      }
      const retained = snapshots.get(wallet);
      if (!retained) return failed(wallet, "missing_snapshot");
      if (now() > retained.expiresAtMs) return failed(wallet, "stale_snapshot");

      try {
        options?.signal?.throwIfAborted();
        const dirtyIds = normalizeConditionIds(conditionIds);
        if (dirtyIds.length > MAX_DIRTY_CONDITIONS) {
          return failed(wallet, "condition_limit");
        }
        if (dirtyIds.length === 0) {
          return { published: true, snapshot: retained };
        }
        const hydration = await config.dataSource.listUserPositionsV2Raw(
          wallet,
          {
            conditions: dirtyIds,
            includeArchived: false,
            maxRequests: MAX_DIRTY_DATA_API_CALLS,
            signal: options?.signal,
          }
        );
        if (hydration.requestCount > MAX_DIRTY_DATA_API_CALLS) {
          return failed(wallet, "request_budget");
        }
        assertRowsInCohort(hydration.positions, dirtyIds);
        const replacements = new Map(
          buildConditions(hydration.positions).map((condition) => [
            condition.conditionId,
            condition,
          ])
        );
        const dirtySet = new Set(dirtyIds);
        const nextConditions = retained.conditions
          .filter((condition) => !dirtySet.has(condition.conditionId))
          .concat([...replacements.values()])
          .sort(compareCondition);
        return publish(wallet, {
          version: 1,
          targetWallet: wallet,
          fullRefreshAtMs: retained.fullRefreshAtMs,
          updatedAtMs: now(),
          expiresAtMs: retained.expiresAtMs,
          complete: true,
          refreshStats: {
            kind: "dirty",
            discoveryRows: retained.refreshStats.discoveryRows,
            conditionCount: nextConditions.length,
            dataApiCalls: hydration.requestCount,
          },
          conditions: nextConditions,
        });
      } catch (error) {
        return failed(wallet, classifyFailure(error, options));
      }
    },

    invalidate(targetWallet) {
      snapshots.delete(normalizeWallet(targetWallet));
    },
  };
}

function uniqueConditionIds(rows: readonly PolymarketUserPositionV2[]): string[] {
  return normalizeConditionIds(rows.map((row) => row.condition_id));
}

function assertActiveDiscovery(rows: readonly PolymarketUserPositionV2[]): void {
  if (
    rows.some(
      (row) =>
        row.status !== "OPEN" ||
        row.redeemable === true ||
        row.archived === true ||
        row.current_value <= 0
    )
  ) {
    throw new PolyDataApiPositionsV2Error(
      "positive OPEN discovery contained an ineligible row"
    );
  }
}

function assertRowsInCohort(
  rows: readonly PolymarketUserPositionV2[],
  conditionIds: readonly string[]
): void {
  const cohort = new Set(conditionIds);
  if (
    rows.some(
      (row) =>
        !cohort.has(row.condition_id.toLowerCase()) || row.archived === true
    )
  ) {
    throw new PolyDataApiPositionsV2Error(
      "hydration returned a row outside the active condition cohort"
    );
  }
}

function normalizeConditionIds(values: readonly string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.toLowerCase()))];
  if (normalized.some((value) => !CONDITION_ID_PATTERN.test(value))) {
    throw new PolyDataApiPositionsV2Error("invalid condition id");
  }
  return normalized.sort();
}

function buildConditions(
  rows: readonly PolymarketUserPositionV2[]
): TargetBookConditionV1[] {
  const grouped = new Map<string, PolymarketUserPositionV2[]>();
  for (const row of rows) {
    if (row.status !== "OPEN" || row.redeemable === true) continue;
    const conditionId = row.condition_id.toLowerCase();
    const group = grouped.get(conditionId) ?? [];
    group.push(row);
    grouped.set(conditionId, group);
  }

  const conditions: TargetBookConditionV1[] = [];
  for (const [conditionId, conditionRows] of grouped) {
    // A hydrated condition with no positive-value leg has exited the candidate
    // book. Keep a zero-valued counterpart only when another leg proves the
    // condition remains economically relevant.
    if (!conditionRows.some((row) => row.current_value > 0)) continue;
    conditions.push(buildCondition(conditionId, conditionRows));
  }
  return conditions.sort(compareCondition);
}

function buildCondition(
  conditionId: string,
  rows: readonly PolymarketUserPositionV2[]
): TargetBookConditionV1 {
  if (!CONDITION_ID_PATTERN.test(conditionId) || rows.length < 1 || rows.length > 2) {
    throw new PolyDataApiPositionsV2Error(
      `condition ${conditionId} was not a valid binary tuple`
    );
  }
  const first = rows[0];
  if (!first) throw new PolyDataApiPositionsV2Error("missing condition row");
  const negativeRisk = first.negative_risk === true;
  const endDate = first.end_date ?? null;
  for (const row of rows) {
    if (
      row.condition_id.toLowerCase() !== conditionId ||
      row.status !== "OPEN" ||
      row.redeemable === true ||
      (row.negative_risk === true) !== negativeRisk ||
      (row.end_date ?? null) !== endDate
    ) {
      throw new PolyDataApiPositionsV2Error(
        `condition ${conditionId} contained inconsistent metadata`
      );
    }
  }

  const tokens = rows.map(toToken);
  let pair: [TargetBookTokenV1, TargetBookTokenV1];
  if (tokens.length === 1) {
    const held = tokens[0];
    if (!held || held.oppositeTokenId === held.tokenId) {
      throw new PolyDataApiPositionsV2Error(
        `condition ${conditionId} lacked a distinct opposite token proof`
      );
    }
    pair = [
      held,
      {
        tokenId: held.oppositeTokenId,
        oppositeTokenId: held.tokenId,
        outcomeIndex: held.outcomeIndex === 0 ? 1 : 0,
        shares: 0,
        markPrice: 0,
        averagePrice: 0,
      },
    ];
  } else {
    const left = tokens[0];
    const right = tokens[1];
    if (
      !left ||
      !right ||
      left.tokenId === right.tokenId ||
      left.oppositeTokenId !== right.tokenId ||
      right.oppositeTokenId !== left.tokenId ||
      left.outcomeIndex === right.outcomeIndex
    ) {
      throw new PolyDataApiPositionsV2Error(
        `condition ${conditionId} lacked a mutual binary token proof`
      );
    }
    pair = [left, right];
  }
  pair.sort(compareToken);
  if (pair[0].outcomeIndex !== 0 || pair[1].outcomeIndex !== 1) {
    throw new PolyDataApiPositionsV2Error(
      `condition ${conditionId} did not contain outcome indexes 0 and 1`
    );
  }

  return {
    conditionId,
    status: "OPEN",
    redeemable: false,
    endDate,
    negativeRisk,
    tokens: pair,
  };
}

function toToken(row: PolymarketUserPositionV2): TargetBookTokenV1 {
  const opposite = row.opposite_token_id;
  if (
    !TOKEN_ID_PATTERN.test(row.token_id) ||
    !opposite ||
    !TOKEN_ID_PATTERN.test(opposite) ||
    (row.outcome_index !== 0 && row.outcome_index !== 1)
  ) {
    throw new PolyDataApiPositionsV2Error(
      `token ${row.token_id} lacked binary identity metadata`
    );
  }
  return {
    tokenId: row.token_id,
    oppositeTokenId: opposite,
    outcomeIndex: row.outcome_index,
    shares: row.current_size,
    markPrice: row.current_price,
    averagePrice: row.avg_price,
  };
}

function classifyFailure(
  error: unknown,
  options?: TargetBookRefreshOptionsV1
): TargetBookRefreshFailureReasonV1 {
  if (options?.signal?.aborted) return "aborted";
  if (error instanceof PolyDataApiPositionsV2Error) return error.reason;
  return "upstream";
}

function normalizeWallet(wallet: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    throw new Error(`Invalid wallet address: ${wallet}`);
  }
  return wallet.toLowerCase();
}

function tryNormalizeWallet(wallet: string): string | null {
  try {
    return normalizeWallet(wallet);
  } catch {
    return null;
  }
}

function compareCondition(
  left: TargetBookConditionV1,
  right: TargetBookConditionV1
): number {
  return left.conditionId.localeCompare(right.conditionId);
}

function compareToken(left: TargetBookTokenV1, right: TargetBookTokenV1): number {
  return left.outcomeIndex - right.outcomeIndex;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

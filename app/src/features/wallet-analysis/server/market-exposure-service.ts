// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/market-exposure-service`
 * Purpose: Build the dashboard market aggregation read model from our live
 *   execution positions plus observed active copy-target current positions,
 *   pivoted into one row per (wallet, conditionId) with a primary leg + an
 *   optional hedge leg + a `net` summary, plus the rate-gap / size-scaled-gap
 *   pair that drives the alpha-leak sort.
 * Scope: Feature service. Caller injects DB and already-fetched live positions.
 *   No upstream Polymarket calls.
 * Invariants:
 *   - OUR_POSITIONS_ANCHOR_GROUPS: only markets/events where the caller holds a
 *     live position are returned.
 *   - HEDGE_IS_RELATIVE_POSITION: a hedge is the smaller cost-basis leg of a
 *     two-token active condition for one wallet, not a persisted flag.
 *   - SERVER_SIDE_PIVOT: per-participant primary/hedge/net shape is computed
 *     here, never client-side. Same shape will feed Research views once
 *     `poly_market_outcomes` is populated.
 *   - SNAPSHOTS_ARE_DURABLE_TRUTH: target legs are anchored on
 *     `poly_trader_position_snapshots` (append-only history) rather than
 *     `poly_trader_current_positions`, because the sync deactivates and zeros
 *     out target rows once Polymarket Data API stops returning a position
 *     (post-resolution / post-redeem). Snapshots preserve the last observed
 *     `(shares, cost_basis_usdc, current_value_usdc)` so attribution survives
 *     target exit by any means.
 *   - LIVE_MARK_FROM_CURRENT_POSITIONS (task.5012): snapshots are written
 *     only on position-defining changes (`hashPosition` excludes
 *     currentValue/curPrice), so a still-held position's latest snapshot has
 *     a stale mark. `readTargetLegs` joins `poly_trader_current_positions`
 *     and uses its `current_value_usdc` while the row is `active`, falling
 *     back to the snapshot's last-observed value once deactivated. Shares /
 *     cost basis / avg price stay snapshot-sourced — they are hash-covered
 *     and therefore always fresh in the latest snapshot.
 *   - TARGET_LEGS_FROM_SNAPSHOTS: every active copy-target whose latest
 *     snapshot covers a condition we hold surfaces as a leg. A soft-disabled
 *     target remains observable only where authoritative realized fill
 *     lineage proves it created a held/closed local position. Disable stops
 *     execution; it never erases the comparison needed to explain holdings.
 *   - SERVER_SIDE_LIFECYCLE: a leg's lifecycle is `"active"` if its
 *     current-positions row is active with positive live value (snapshot
 *     value fallback when no current-positions row exists), otherwise
 *     `"inactive"` (target observed but no longer held). Once `poly_market_outcomes` is
 *     populated, resolved legs get joined in to promote `active`/`inactive`
 *     → `winner`/`loser`/`resolved`.
 *   - SINGLE_BASIS_SNAPSHOT_COST: per-position cost basis, P/L, and return %
 *     all derive from `Σ snapshot.cost_basis_usdc` (Polymarket vendor's
 *     FIFO-allocated cost of *currently held* shares). The snapshot is
 *     canonically durable in two ways: (a) Polymarket's vendor accounting
 *     deducts cost as shares leave the position via SELL, negRisk merge
 *     (YES + NO pair → 1 USDC), or redemption, so the held-cost number on
 *     a still-active position is correct; (b) the snapshot table itself is
 *     append-only and the writer at trader-observation-service.ts inserts
 *     only positive-share rows from Polymarket's `/positions` page — once
 *     Polymarket drops the position post-redemption, the writer stops
 *     inserting and the last pre-redemption row persists, preserving the
 *     final cost + last-marked value for historical attribution (held P/L
 *     remains the resolved-but-not-redeemed mark, which equals the
 *     redemption value). The earlier `max(rollup, snapshot)` policy was
 *     abandoned because for market-maker targets (swisstony being canonical)
 *     it inflated entry by 10× — every BUY fill counted, even on shares
 *     merged back to USDC seconds later. P/L on this basis is "held P/L"
 *     (`value − cost`); realized cash from SELL fills is intentionally NOT
 *     folded into the numerator because we don't track the analogous merge
 *     / redeem cash flows yet — partial inclusion would mis-rank market-
 *     makers vs directional traders. `grossBuyNotionalUsdc` (rollup BUY
 *     total) is exposed as a SEPARATE field for callers who want lifetime-
 *     volume visibility; it must never be conflated with cost basis.
 *   - KNOWN_GAP_FULLY_EXITED_TARGETS: a wallet that BOTH (a) fully exited
 *     a condition via SELL fills before we ever started observing it (so
 *     no snapshot row ever existed) AND (b) had its BUY fills predate our
 *     `poly_trader_fills` backfill horizon (so the rollup is also empty)
 *     will render with `totalBuyNotional = 0 → returnPct = null → no Δ`.
 *     This does NOT hit currently-tracked targets (RN1, swisstony) because
 *     our observer captured at-least-one snapshot per condition they
 *     touched while alive, and that latest row preserves cost+value.
 *     The gap fires only for prospective targets added to comparisons
 *     AFTER they've already cleared markets. Future remedy: index
 *     NegRiskAdapter MERGE + ConditionalTokens PayoutRedemption events
 *     as realized cash flows; Modified-Dietz on rollup BUY + all cash
 *     recoveries gives a clean answer even without a held position.
 *   - EDGE_GAP_NULL_WITHOUT_TARGETS: `edgeGapUsdc` and `edgeGapPct` are null
 *     on lines/groups with zero target legs that have positive buy notional.
 *     "Edge gap vs. nobody" is undefined, not `-ourPnl`.
 *   - SIGN_TARGET_AHEAD_POSITIVE: `edgeGapPct = targetReturnPct − ourReturnPct`
 *     (in fractional pp, internally `rateGapPct`); positive = target ahead =
 *     alpha leaking from us. `edgeGapUsdc = edgeGapPct × ourTotalBuyNotional`
 *     (internally `sizeScaledGapUsdc`) — bounded by our book, never the
 *     legacy divide-by-zero `−1.7M%` artifact. Default sort descending by
 *     `edgeGapUsdc` puts the worst leak on top.
 * Side-effects: DB read across `poly_copy_trade_targets`,
 *   `poly_trader_wallets`, `poly_trader_position_snapshots`,
 *   `poly_trader_fill_rollups_daily` (+ the unrolled `poly_trader_fills`
 *   tail). No upstream Polymarket calls.
 * Links: docs/spec/poly-copy-trade-execution.md
 * @internal
 */

import type {
  WalletDashboardComparisonCoverage,
  WalletDashboardComparisonCoverageLeaf,
  WalletDashboardComparisonCoverageReason,
  WalletExecutionMarketGroup,
  WalletExecutionMarketLeg,
  WalletExecutionMarketLineStatus,
  WalletExecutionMarketParticipantRow,
  WalletExecutionPosition,
} from "@cogni/poly-node-contracts";
import { type SQL, sql } from "drizzle-orm";

import { EPOCH_ISO, windowedFillFlowsSelect } from "./fill-rollup-service";
import { liveCurrentPositionSql } from "./current-position-staleness";
import {
  blendTargetReturns,
  computeRealizedPnl,
  edgeGap,
  type MarketOutcome,
  positionReturnPct,
} from "./market-return-math";

type Db = {
  execute(query: SQL): Promise<unknown>;
};

type ParticipantSide = WalletExecutionMarketParticipantRow["side"];
type ParticipantSource = WalletExecutionMarketParticipantRow["source"];

type RawLeg = {
  side: ParticipantSide;
  source: ParticipantSource;
  label: string;
  walletAddress: string;
  conditionId: string;
  tokenId: string;
  marketTitle: string;
  eventTitle: string | null;
  marketSlug: string | null;
  eventSlug: string | null;
  outcome: string;
  shares: number;
  costBasisUsdc: number;
  currentValueUsdc: number;
  vwap: number | null;
  avgPrice: number | null;
  lifecycle: WalletExecutionMarketLeg["lifecycle"];
  lastObservedAt: string | null;
  /**
   * Status of the originating position when `side === "our_wallet"`.
   * `null` for `copy_target` legs (they have no caller-position concept).
   */
  ourPositionStatus: WalletExecutionMarketLineStatus | null;
  /**
   * Realized P/L for the leg computed from
   * `poly_trader_fills` + `poly_market_outcomes` via `computeRealizedPnl`.
   * Always present; falls back to `currentValueUsdc − costBasisUsdc` when
   * the rollup is missing (target leg observed only via snapshot,
   * fresh-pre-backfill our wallet).
   */
  pnlUsdc: number;
  /**
   * CTF redemption credit contributed by this leg ($1 × winning shares
   * already burned). 0 for losers, open winners, and any leg whose
   * `currentValueUsdc` still reflects on-chain shares.
   */
  redemptionProceedsUsdc: number;
};

/** @internal — exported for the rollup parity tests only. */
export type FillRollup = {
  totalBuyNotional: number;
  realizedCash: number;
  netShares: number;
  marketOutcome: MarketOutcome;
};

type TargetPositionRow = {
  wallet_address: string | null;
  label: string | null;
  condition_id: string | null;
  token_id: string | null;
  market_title: string | null;
  event_title: string | null;
  market_slug: string | null;
  event_slug: string | null;
  outcome: string | null;
  shares: string | number | null;
  cost_basis_usdc: string | number | null;
  current_value_usdc: string | number | null;
  avg_price: string | number | null;
  last_observed_at: Date | string | null;
  lifecycle: string | null;
};

type BoundedTargetParticipantRow = {
  total_participants: string | number | null;
  group_truncated: boolean | null;
  group_key: string | null;
  wallet_address: string | null;
  label: string | null;
  condition_id: string | null;
  legs: unknown;
};

type BoundedTargetLeg = Omit<
  TargetPositionRow,
  "wallet_address" | "label" | "condition_id"
>;

export type BoundedMarketExposureRead = {
  groups: WalletExecutionMarketGroup[];
  truncated: boolean;
};

export type ComparisonReadDiagnostics = {
  comparisonBundleQueryMs?: number;
  comparisonFillRollupMs?: number;
  comparisonFallbackTargetMs?: number;
  comparisonFallbackFillRollupMs?: number;
  bundleQueryFailureClass?: ComparisonReadFailureClass;
  bundleFillRollupFailureClass?: ComparisonReadFailureClass;
  fallbackFillRollupFailureClass?: ComparisonReadFailureClass;
  fallbackTargetFailureClass?: ComparisonReadFailureClass;
};

export type ComparisonReadFailureClass =
  | "statement_timeout"
  | "database_error"
  | "unexpected_error";

export type BoundedMarketExposureCoverageRead = {
  market: BoundedMarketExposureRead;
  counts: ComparisonCoverageCountRow[];
  positionClassifications: PositionComparisonClassification[];
};

type PositionComparisonClassification =
  WalletDashboardComparisonCoverage["positionClassifications"][number];

export type ComparisonCoverageCountRow = {
  entity: "markets" | "positions";
  status: WalletExecutionMarketLineStatus;
  eligible: string | number | null;
  comparable: string | number | null;
  ambiguous: string | number | null;
  source_ambiguous: boolean | null;
};

type ComparisonBundleRow = Partial<
  ComparisonCoverageCountRow & BoundedTargetParticipantRow
> & {
  record_kind: "classification" | "count" | "participant";
  token_id?: string | null;
  classification?: PositionComparisonClassification["result"] | null;
};

const BOUNDED_GROUP_LIMIT = 200;
const BOUNDED_TARGETS_PER_GROUP = 10;
const BOUNDED_PARTICIPANT_ROW_LIMIT = 2_200;
const VISIBLE_LIVE_POSITION_LIMIT = 500;
const VISIBLE_CLOSED_POSITION_LIMIT = 30;

type BoundedOurExposureSelection = {
  allOurLegs: RawLeg[];
  ourLegs: RawLeg[];
  conditionGroup: Map<string, string>;
  conditionStatus: Map<string, WalletExecutionMarketLineStatus>;
  ownParticipantRows: number;
  groupedCount: number;
};

export async function buildMarketExposureGroups(params: {
  db: Db;
  billingAccountId: string;
  walletAddress: string;
  livePositions: readonly WalletExecutionPosition[];
  closedPositions?: readonly WalletExecutionPosition[];
}): Promise<WalletExecutionMarketGroup[]> {
  const closedPositions = params.closedPositions ?? [];
  if (params.livePositions.length === 0 && closedPositions.length === 0) {
    return [];
  }

  const ourLegs = [
    ...buildOurLegs(params.livePositions, params.walletAddress, "live"),
    ...buildOurLegs(closedPositions, params.walletAddress, "closed"),
  ];
  const conditions = [...new Set(ourLegs.map((leg) => leg.conditionId))];
  const conditionStatus = conditionStatusFromLegs(ourLegs);
  const targetLegs = await readTargetLegs({
    db: params.db,
    billingAccountId: params.billingAccountId,
    conditions,
    conditionStatus,
  });
  const rawLegs = [...ourLegs, ...targetLegs];
  const wallets = [...new Set(rawLegs.map((leg) => leg.walletAddress))];
  const rollups = await readFillRollups({
    db: params.db,
    conditions,
    walletAddresses: wallets,
  });
  const enrichedLegs = rawLegs.map((leg) => enrichLegWithRollup(leg, rollups));

  return groupParticipants(enrichedLegs, rollups);
}

/**
 * Dashboard-only bounded variant. It preserves the default reader's exact
 * cost/P-L/primary+hedge semantics, but selects target participants in SQL
 * before any target legs or rollups cross into V8.
 */
export async function buildBoundedMarketExposureGroups(params: {
  db: Db;
  billingAccountId: string;
  walletAddress: string;
  livePositions: readonly WalletExecutionPosition[];
  closedPositions?: readonly WalletExecutionPosition[];
  diagnostics?: ComparisonReadDiagnostics;
}): Promise<BoundedMarketExposureRead> {
  const closedPositions = params.closedPositions ?? [];
  const selection = selectBoundedOurExposure({
    walletAddress: params.walletAddress,
    livePositions: params.livePositions,
    closedPositions,
  });
  if (selection.allOurLegs.length === 0) {
    return { groups: [], truncated: false };
  }
  const targetBudget = Math.max(
    0,
    BOUNDED_PARTICIPANT_ROW_LIMIT - selection.ownParticipantRows
  );
  const targetStartedAt = performance.now();
  let targetRead: Awaited<ReturnType<typeof readBoundedTargetLegs>>;
  try {
    targetRead = await readBoundedTargetLegs({
      db: params.db,
      billingAccountId: params.billingAccountId,
      conditionGroup: selection.conditionGroup,
      participantLimit: targetBudget,
    });
  } catch (error) {
    recordComparisonDiagnostic(
      params.diagnostics,
      "fallbackTargetFailureClass",
      classifyComparisonReadFailure(error)
    );
    throw error;
  } finally {
    recordComparisonDiagnostic(
      params.diagnostics,
      "comparisonFallbackTargetMs",
      elapsedMs(targetStartedAt)
    );
  }
  targetRead = {
    ...targetRead,
    legs: targetRead.legs.filter(
      (leg) =>
        selection.conditionStatus.get(leg.conditionId) === "closed" ||
        leg.lifecycle === "active"
    ),
  };
  const rawLegs = [...selection.ourLegs, ...targetRead.legs];
  const fillStartedAt = performance.now();
  let rollups: Awaited<ReturnType<typeof readFillRollups>>;
  try {
    rollups = await readFillRollups({
      db: params.db,
      conditions: [...selection.conditionGroup.keys()],
      walletAddresses: [...new Set(rawLegs.map((leg) => leg.walletAddress))],
      positionKeys: rawLegs.map((leg) => ({
        walletAddress: leg.walletAddress,
        conditionId: leg.conditionId,
        tokenId: leg.tokenId,
      })),
    });
  } catch (error) {
    recordComparisonDiagnostic(
      params.diagnostics,
      "fallbackFillRollupFailureClass",
      classifyComparisonReadFailure(error)
    );
    throw error;
  } finally {
    recordComparisonDiagnostic(
      params.diagnostics,
      "comparisonFallbackFillRollupMs",
      elapsedMs(fillStartedAt)
    );
  }
  const enrichedLegs = rawLegs.map((leg) => enrichLegWithRollup(leg, rollups));
  return {
    groups: groupParticipants(enrichedLegs, rollups).slice(
      0,
      BOUNDED_GROUP_LIMIT
    ),
    truncated:
      selection.groupedCount > BOUNDED_GROUP_LIMIT ||
      targetRead.totalParticipants > targetRead.hydratedParticipants ||
      targetRead.groupTruncated,
  };
}

function selectBoundedOurExposure(params: {
  walletAddress: string;
  livePositions: readonly WalletExecutionPosition[];
  closedPositions: readonly WalletExecutionPosition[];
}): BoundedOurExposureSelection {
  const allOurLegs = [
    ...buildOurLegs(params.livePositions, params.walletAddress, "live"),
    ...buildOurLegs(params.closedPositions, params.walletAddress, "closed"),
  ];
  const grouped = new Map<string, RawLeg[]>();
  for (const leg of allOurLegs) {
    const key = leg.eventSlug
      ? `event:${leg.eventSlug}`
      : `condition:${leg.conditionId}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(leg);
    grouped.set(key, bucket);
  }
  const selected = [...grouped.entries()]
    .sort(
      (left, right) =>
        sumValue(right[1]) - sumValue(left[1]) ||
        left[0].localeCompare(right[0])
    )
    .slice(0, BOUNDED_GROUP_LIMIT);
  const ourLegs = selected.flatMap(([, legs]) => legs);
  const conditionGroup = new Map<string, string>();
  for (const [groupKey, legs] of selected) {
    for (const leg of legs) conditionGroup.set(leg.conditionId, groupKey);
  }
  return {
    allOurLegs,
    ourLegs,
    conditionGroup,
    conditionStatus: conditionStatusFromLegs(allOurLegs),
    ownParticipantRows: new Set(
      ourLegs.map((leg) => `${leg.walletAddress}:${leg.conditionId}`)
    ).size,
    groupedCount: grouped.size,
  };
}

function conditionStatusFromLegs(
  legs: readonly RawLeg[]
): Map<string, WalletExecutionMarketLineStatus> {
  const statuses = new Map<string, WalletExecutionMarketLineStatus>();
  for (const leg of legs) {
    const current = statuses.get(leg.conditionId);
    statuses.set(
      leg.conditionId,
      current === "live" || leg.ourPositionStatus === "live"
        ? "live"
        : "closed"
    );
  }
  return statuses;
}

/**
 * One-query non-empty dashboard comparison path. The full-population
 * coverage aggregate and the bounded target preview share one materialized
 * target-snapshot source, while the existing grouping and fill math remain
 * unchanged.
 */
export async function buildBoundedMarketExposureWithCoverage(params: {
  db: Db;
  billingAccountId: string;
  walletAddress: string;
  livePositions: readonly WalletExecutionPosition[];
  closedPositions?: readonly WalletExecutionPosition[];
  diagnostics?: ComparisonReadDiagnostics;
}): Promise<BoundedMarketExposureCoverageRead> {
  const selection = selectBoundedOurExposure({
    walletAddress: params.walletAddress,
    livePositions: params.livePositions,
    closedPositions: params.closedPositions ?? [],
  });
  const targetBudget = Math.max(
    0,
    BOUNDED_PARTICIPANT_ROW_LIMIT - selection.ownParticipantRows
  );
  const queryStartedAt = performance.now();
  let rows: ComparisonBundleRow[];
  try {
    rows = await readComparisonBundleRows({
      db: params.db,
      billingAccountId: params.billingAccountId,
      walletAddress: params.walletAddress,
      conditionGroup: selection.conditionGroup,
      participantLimit: targetBudget,
      selectedPositionKeys: [
        ...params.livePositions
          .slice(0, VISIBLE_LIVE_POSITION_LIMIT)
          .map((position) => ({
            conditionId: canonicalIdentity(position.conditionId),
            tokenId: position.asset,
            status: "live" as const,
          })),
        ...(params.closedPositions ?? [])
          .slice(0, VISIBLE_CLOSED_POSITION_LIMIT)
          .map((position) => ({
            conditionId: canonicalIdentity(position.conditionId),
            tokenId: position.asset,
            status: "closed" as const,
          })),
      ],
    });
  } catch (error) {
    recordComparisonDiagnostic(
      params.diagnostics,
      "bundleQueryFailureClass",
      classifyComparisonReadFailure(error)
    );
    throw error;
  } finally {
    recordComparisonDiagnostic(
      params.diagnostics,
      "comparisonBundleQueryMs",
      elapsedMs(queryStartedAt)
    );
  }
  const counts = countRowsFromBundle(rows);
  const targetRead = boundedTargetReadFromRows(participantRowsFromBundle(rows));
  const rawLegs = [...selection.ourLegs, ...targetRead.legs];
  const fillStartedAt = performance.now();
  let rollups: Awaited<ReturnType<typeof readFillRollups>>;
  try {
    rollups = await readFillRollups({
      db: params.db,
      conditions: [...selection.conditionGroup.keys()],
      walletAddresses: [...new Set(rawLegs.map((leg) => leg.walletAddress))],
      positionKeys: rawLegs.map((leg) => ({
        walletAddress: leg.walletAddress,
        conditionId: leg.conditionId,
        tokenId: leg.tokenId,
      })),
    });
  } catch (error) {
    recordComparisonDiagnostic(
      params.diagnostics,
      "bundleFillRollupFailureClass",
      classifyComparisonReadFailure(error)
    );
    throw error;
  } finally {
    recordComparisonDiagnostic(
      params.diagnostics,
      "comparisonFillRollupMs",
      elapsedMs(fillStartedAt)
    );
  }
  const enrichedLegs = rawLegs.map((leg) => enrichLegWithRollup(leg, rollups));
  return {
    counts,
    positionClassifications: classificationRowsFromBundle(rows),
    market: {
      groups: groupParticipants(enrichedLegs, rollups).slice(
        0,
        BOUNDED_GROUP_LIMIT
      ),
      truncated:
        selection.groupedCount > BOUNDED_GROUP_LIMIT ||
        targetRead.totalParticipants > targetRead.hydratedParticipants ||
        targetRead.groupTruncated,
    },
  };
}

function recordComparisonDiagnostic<K extends keyof ComparisonReadDiagnostics>(
  diagnostics: ComparisonReadDiagnostics | undefined,
  key: K,
  value: ComparisonReadDiagnostics[K]
): void {
  if (!diagnostics) return;
  try {
    diagnostics[key] = value;
  } catch {
    // Diagnostics are fail-open and can never affect the dashboard result.
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function classifyComparisonReadFailure(
  error: unknown
): ComparisonReadFailureClass {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!candidate || typeof candidate !== "object") break;
    const record = candidate as { code?: unknown; cause?: unknown };
    if (record.code === "57014") return "statement_timeout";
    if (typeof record.code === "string") return "database_error";
    candidate = record.cause;
  }
  return "unexpected_error";
}

/**
 * Constant-cardinality identity check for an authoritatively empty inventory.
 * It intentionally uses all physical wallet rows, including disabled/kind
 * siblings, matching the full coverage query's ambiguity authority.
 */
export async function readComparisonSourceIdentityAmbiguity(params: {
  db: Db;
  billingAccountId: string;
  walletAddress: string;
}): Promise<boolean> {
  const rows = (await params.db.execute(sql`
    WITH canonical_wallet_identity AS (
      SELECT count(*) > 1 AS identity_ambiguous
      FROM poly_trader_wallets w
      WHERE lower(w.wallet_address) = lower(${params.walletAddress})
    ), active_target_candidates AS (
      SELECT
        lower(t.target_wallet) AS wallet_key,
        (
          count(*) OVER (PARTITION BY lower(t.target_wallet)) > 1
          OR min(t.target_wallet) OVER (PARTITION BY lower(t.target_wallet)) <>
            max(t.target_wallet) OVER (PARTITION BY lower(t.target_wallet))
          OR min(w.wallet_address) OVER (PARTITION BY lower(t.target_wallet)) <>
            max(w.wallet_address) OVER (PARTITION BY lower(t.target_wallet))
        ) AS identity_ambiguous
      FROM poly_copy_trade_targets t
      JOIN poly_trader_wallets w
        ON lower(w.wallet_address) = lower(t.target_wallet)
      WHERE t.billing_account_id = ${params.billingAccountId}
        AND t.disabled_at IS NULL
    )
    SELECT
      own.identity_ambiguous OR
        COALESCE(bool_or(target.identity_ambiguous), false) AS identity_ambiguous
    FROM canonical_wallet_identity own
    LEFT JOIN active_target_candidates target ON TRUE
    GROUP BY own.identity_ambiguous
  `)) as unknown as Array<{ identity_ambiguous: boolean | null }>;
  if (typeof rows[0]?.identity_ambiguous !== "boolean") {
    throw new Error("Comparison identity preflight returned no authority row.");
  }
  return rows[0].identity_ambiguous;
}

export function emptyComparisonCoverageCounts(
  sourceAmbiguous: boolean
): ComparisonCoverageCountRow[] {
  return (["positions", "markets"] as const).flatMap((entity) =>
    (["live", "closed"] as const).map((status) => ({
      entity,
      status,
      eligible: 0,
      comparable: 0,
      ambiguous: 0,
      source_ambiguous: sourceAmbiguous,
    }))
  );
}

/**
 * Exact, constant-cardinality comparison counts for the full saved inventory.
 * The query mirrors `groupParticipants`' nullability rule: a delta exists only
 * when our cost basis and at least one active target's cost basis are positive.
 * Physical case variants are deterministically collapsed but fail closed as
 * ambiguous instead of being silently certified as comparable.
 */
export async function readFullComparisonCoverageCounts(params: {
  db: Db;
  billingAccountId: string;
  walletAddress: string;
}): Promise<ComparisonCoverageCountRow[]> {
  const rows = await readComparisonBundleRows({
    ...params,
    conditionGroup: new Map(),
    participantLimit: 0,
    selectedPositionKeys: [],
  });
  return countRowsFromBundle(rows);
}

async function readComparisonBundleRows(params: {
  db: Db;
  billingAccountId: string;
  walletAddress: string;
  conditionGroup: ReadonlyMap<string, string>;
  participantLimit: number;
  selectedPositionKeys: readonly {
    conditionId: string;
    tokenId: string;
    status: WalletExecutionMarketLineStatus;
  }[];
}): Promise<ComparisonBundleRow[]> {
  // This bounded relation is consumed only by preview_* CTEs below. The
  // eligible/position_eval/market_eval coverage chain remains full-population.
  const selectedConditions =
    params.conditionGroup.size === 0
      ? sql`SELECT NULL::text AS condition_id, NULL::text AS group_key WHERE FALSE`
      : sql`VALUES ${sql.join(
          [...params.conditionGroup.entries()].map(
            ([conditionId, groupKey]) => sql`(${conditionId}, ${groupKey})`
          ),
          sql`, `
        )}`;
  const selectedPositionKeys =
    params.selectedPositionKeys.length === 0
      ? sql`SELECT NULL::text AS condition_id, NULL::text AS token_id,
          NULL::text AS status WHERE FALSE`
      : sql`VALUES ${sql.join(
          params.selectedPositionKeys.map(
            (key) => sql`(${key.conditionId}, ${key.tokenId}, ${key.status})`
          ),
          sql`, `
        )}`;
  return (await params.db.execute(sql`
    WITH selected_conditions(condition_id, group_key) AS (
      ${selectedConditions}
    ), selected_position_keys(condition_id, token_id, status) AS (
      ${selectedPositionKeys}
    ), canonical_wallet_identity AS (
      SELECT count(*) > 1 AS identity_ambiguous
      FROM poly_trader_wallets w
      WHERE lower(w.wallet_address) = lower(${params.walletAddress})
    ), wallet_scope AS (
      SELECT
        w.*,
        canonical.identity_ambiguous
      FROM poly_trader_wallets w
      CROSS JOIN canonical_wallet_identity canonical
      WHERE lower(w.wallet_address) = lower(${params.walletAddress})
        AND w.kind = 'cogni_wallet'
        AND w.active_for_research = true
        AND w.disabled_at IS NULL
    ), our_identity AS (
      SELECT COALESCE(bool_or(identity_ambiguous), false) AS identity_ambiguous
      FROM wallet_scope
    ), live_ranked AS (
      SELECT
        p.*,
        lower(p.condition_id) AS condition_key,
        w.identity_ambiguous AS wallet_identity_ambiguous,
        row_number() OVER (
          PARTITION BY lower(p.condition_id), p.token_id
          ORDER BY p.last_observed_at DESC, w.updated_at DESC,
            w.created_at DESC, w.id, p.condition_id
        ) AS identity_rank,
        min(p.condition_id) OVER (
          PARTITION BY lower(p.condition_id), p.token_id
        ) <> max(p.condition_id) OVER (
          PARTITION BY lower(p.condition_id), p.token_id
        ) AS identity_ambiguous
      FROM poly_trader_current_positions p
      JOIN wallet_scope w ON w.id = p.trader_wallet_id
    ), live_latest AS (
      SELECT *
      FROM live_ranked p
      WHERE identity_rank = 1
        AND ${liveCurrentPositionSql("p")}
    ), closed_source AS (
      SELECT
        COALESCE(
          NULLIF(f.attributes->>'condition_id', ''),
          NULLIF(regexp_replace(f.market_id, '^prediction-market:polymarket:', ''), ''),
          f.fill_id
        ) AS physical_condition,
        COALESCE(NULLIF(f.attributes->>'token_id', ''), f.client_order_id) AS token_id,
        f.position_lifecycle,
        f.observed_at,
        f.updated_at,
        f.client_order_id,
        NULLIF(f.attributes->>'event_slug', '') AS event_slug,
        CASE
          WHEN COALESCE(f.attributes->>'position_gap_version', '') = '3'
            AND COALESCE(f.attributes->>'realized_fill_source', '') NOT IN ('clob_associated_trades', 'data_api_activity_position')
            THEN NULL
          WHEN COALESCE(f.attributes->>'filled_size_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (f.attributes->>'filled_size_usdc')::numeric
          WHEN COALESCE(f.attributes->>'size_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (f.attributes->>'size_usdc')::numeric
          ELSE 0
        END AS own_cost
      FROM poly_copy_trade_fills f
      WHERE f.billing_account_id = ${params.billingAccountId}
    ), closed_ranked AS (
      SELECT
        s.*,
        lower(s.physical_condition) AS condition_key,
        row_number() OVER (
          PARTITION BY lower(s.physical_condition), s.token_id
          ORDER BY s.observed_at DESC, s.updated_at DESC, s.client_order_id DESC
        ) AS identity_rank,
        min(s.physical_condition) OVER (
          PARTITION BY lower(s.physical_condition), s.token_id
        ) <> max(s.physical_condition) OVER (
          PARTITION BY lower(s.physical_condition), s.token_id
        ) AS identity_ambiguous
      FROM closed_source s
      WHERE s.physical_condition IS NOT NULL AND s.token_id IS NOT NULL
    ), relevant_conditions AS (
      SELECT DISTINCT condition_key FROM live_latest
      UNION
      SELECT DISTINCT condition_key FROM closed_ranked WHERE identity_rank = 1
    ), outcome_ranked AS (
      SELECT
        lower(o.condition_id) AS condition_key,
        o.token_id,
        o.outcome,
        row_number() OVER (
          PARTITION BY lower(o.condition_id), o.token_id
          ORDER BY o.updated_at DESC, o.condition_id
        ) AS identity_rank,
        min(o.condition_id) OVER (
          PARTITION BY lower(o.condition_id), o.token_id
        ) <> max(o.condition_id) OVER (
          PARTITION BY lower(o.condition_id), o.token_id
        ) AS identity_ambiguous
      FROM poly_market_outcomes o
      JOIN relevant_conditions c ON c.condition_key = lower(o.condition_id)
    ), outcomes AS (
      SELECT * FROM outcome_ranked WHERE identity_rank = 1
    ), metadata_ranked AS (
      SELECT
        lower(m.condition_id) AS condition_key,
        m.market_title,
        m.event_title,
        m.market_slug,
        m.event_slug,
        m.end_date,
        row_number() OVER (
          PARTITION BY lower(m.condition_id)
          ORDER BY m.fetched_at DESC, m.condition_id
        ) AS identity_rank,
        min(m.condition_id) OVER (
          PARTITION BY lower(m.condition_id)
        ) <> max(m.condition_id) OVER (
          PARTITION BY lower(m.condition_id)
        ) AS identity_ambiguous
      FROM poly_market_metadata m
      JOIN relevant_conditions c ON c.condition_key = lower(m.condition_id)
    ), metadata AS (
      SELECT * FROM metadata_ranked WHERE identity_rank = 1
    ), redeem_ranked AS (
      SELECT
        lower(r.funder_address) AS wallet_key,
        lower(r.condition_id) AS condition_key,
        r.position_id,
        r.lifecycle_state,
        row_number() OVER (
          PARTITION BY lower(r.funder_address), lower(r.condition_id), r.position_id
          ORDER BY r.updated_at DESC, r.condition_id, r.funder_address, r.id
        ) AS identity_rank,
        (
          min(r.funder_address) OVER (
            PARTITION BY lower(r.funder_address), lower(r.condition_id), r.position_id
          ) <> max(r.funder_address) OVER (
            PARTITION BY lower(r.funder_address), lower(r.condition_id), r.position_id
          )
          OR min(r.condition_id) OVER (
            PARTITION BY lower(r.funder_address), lower(r.condition_id), r.position_id
          ) <> max(r.condition_id) OVER (
            PARTITION BY lower(r.funder_address), lower(r.condition_id), r.position_id
          )
        ) AS identity_ambiguous
      FROM poly_redeem_jobs r
      JOIN relevant_conditions c ON c.condition_key = lower(r.condition_id)
      WHERE lower(r.funder_address) = lower(${params.walletAddress})
    ), redeem AS (
      SELECT * FROM redeem_ranked WHERE identity_rank = 1
    ), live_inventory AS (
      SELECT
        'live'::text AS status,
        p.condition_key,
        p.token_id,
        CASE
          WHEN COALESCE(NULLIF(m.event_slug, ''), NULLIF(p.raw->>'eventSlug', '')) IS NOT NULL
            THEN 'event:' || COALESCE(NULLIF(m.event_slug, ''), NULLIF(p.raw->>'eventSlug', ''))
          ELSE 'condition:' || p.condition_key
        END AS group_key,
        p.cost_basis_usdc::numeric AS own_cost,
        (
          p.wallet_identity_ambiguous
          OR p.identity_ambiguous
          OR COALESCE(o.identity_ambiguous, false)
          OR COALESCE(m.identity_ambiguous, false)
          OR COALESCE(r.identity_ambiguous, false)
        ) AS identity_ambiguous
      FROM live_latest p
      LEFT JOIN outcomes o
        ON o.condition_key = p.condition_key AND o.token_id = p.token_id
      LEFT JOIN metadata m ON m.condition_key = p.condition_key
      LEFT JOIN redeem r
        ON r.wallet_key = lower(${params.walletAddress})
       AND r.condition_key = p.condition_key
       AND r.position_id = p.token_id
      WHERE p.current_value_usdc > 0
        AND (
          (o.outcome = 'winner' AND r.lifecycle_state IS DISTINCT FROM 'redeemed')
          OR (
            coalesce(o.outcome, 'unknown') NOT IN ('winner', 'loser')
            AND coalesce(r.lifecycle_state, '') NOT IN ('redeemed', 'loser', 'dust', 'closed')
          )
        )
    ), closed_inventory AS (
      SELECT
        'closed'::text AS status,
        condition_key,
        token_id,
        COALESCE('event:' || event_slug, 'condition:' || condition_key) AS group_key,
        own_cost,
        identity_ambiguous
      FROM closed_ranked
      WHERE identity_rank = 1
        AND position_lifecycle IN ('closed', 'redeemed', 'loser', 'dust')
    ), eligible_positions AS (
      SELECT * FROM live_inventory
      UNION ALL
      SELECT * FROM closed_inventory
    ), realized_copy_lineage AS MATERIALIZED (
      SELECT DISTINCT
        lower(NULLIF(f.attributes->>'target_wallet', '')) AS wallet_key,
        lower(COALESCE(
          NULLIF(f.attributes->>'condition_id', ''),
          NULLIF(regexp_replace(
            f.market_id,
            '^prediction-market:polymarket:',
            ''
          ), '')
        )) AS condition_key,
        NULLIF(f.attributes->>'token_id', '') AS token_id
      FROM poly_copy_trade_fills f
      JOIN eligible_positions p
        ON p.condition_key = lower(COALESCE(
          NULLIF(f.attributes->>'condition_id', ''),
          NULLIF(regexp_replace(
            f.market_id,
            '^prediction-market:polymarket:',
            ''
          ), '')
        ))
       AND p.token_id = NULLIF(f.attributes->>'token_id', '')
      WHERE f.billing_account_id = ${params.billingAccountId}
        AND f.order_id IS NOT NULL
        AND f.mode = 'live'
        AND (
          COALESCE(f.attributes->>'position_gap_version', '') <> '3'
          OR f.attributes->>'realized_fill_source' IN ('clob_associated_trades', 'data_api_activity_position')
        )
        AND (
          COALESCE(f.shares, 0) > 0
          OR f.status = 'filled'
          OR (
            COALESCE(f.attributes->>'filled_size_usdc', '')
              ~ '^[0-9]+(\\.[0-9]+)?$'
            AND (f.attributes->>'filled_size_usdc')::numeric > 0
          )
        )
    ), observable_target_wallets AS (
      SELECT
        lower(t.target_wallet) AS wallet_key,
        bool_or(t.disabled_at IS NULL) AS execution_active,
        min(t.target_wallet) <> max(t.target_wallet)
          AS target_identity_ambiguous
      FROM poly_copy_trade_targets t
      WHERE t.billing_account_id = ${params.billingAccountId}
        AND (
          t.disabled_at IS NULL
          OR EXISTS (
            SELECT 1
            FROM realized_copy_lineage lineage
            WHERE lineage.wallet_key = lower(t.target_wallet)
          )
        )
      GROUP BY lower(t.target_wallet)
    ), observable_target_candidates AS (
      -- Coverage authority includes every physical wallet sibling, including
      -- disabled/kind variants. Target-row enablement is intentionally absent:
      -- disabled targets reached this point only through authoritative lineage.
      SELECT
        target.wallet_key,
        target.execution_active,
        w.id AS trader_wallet_id,
        COALESCE(NULLIF(w.label, ''), 'Copy target') AS label,
        (w.disabled_at IS NULL) AS preview_eligible,
        (
          target.target_identity_ambiguous
          OR count(*) OVER (PARTITION BY target.wallet_key) > 1
          OR min(w.wallet_address) OVER (PARTITION BY target.wallet_key) <>
            max(w.wallet_address) OVER (PARTITION BY target.wallet_key)
        ) AS identity_ambiguous
      FROM observable_target_wallets target
      JOIN poly_trader_wallets w
        ON lower(w.wallet_address) = target.wallet_key
    ), observable_targets AS (
      SELECT DISTINCT wallet_key, execution_active, trader_wallet_id, label,
        preview_eligible, identity_ambiguous
      FROM observable_target_candidates
    ), source_identity AS (
      SELECT
        o.identity_ambiguous OR COALESCE(bool_or(a.identity_ambiguous), false)
          AS identity_ambiguous
      FROM our_identity o
      LEFT JOIN observable_targets a ON TRUE
      GROUP BY o.identity_ambiguous
    ), target_snapshot_source AS MATERIALIZED (
      SELECT
        s.id AS snapshot_id,
        a.wallet_key,
        s.trader_wallet_id,
        a.label,
        a.preview_eligible,
        lower(s.condition_id) AS condition_key,
        s.condition_id AS physical_condition,
        s.token_id,
        s.cost_basis_usdc::numeric AS cost_basis_usdc,
        s.captured_at,
        EXISTS (
          SELECT 1
          FROM poly_trader_current_positions current_position
          WHERE current_position.trader_wallet_id = s.trader_wallet_id
            AND lower(current_position.condition_id) = lower(s.condition_id)
            AND current_position.token_id = s.token_id
            AND ${liveCurrentPositionSql("current_position")}
        ) AS current_active,
        a.identity_ambiguous AS wallet_identity_ambiguous
      FROM poly_trader_position_snapshots s
      JOIN observable_targets a ON a.trader_wallet_id = s.trader_wallet_id
      WHERE lower(s.condition_id) IN (
        SELECT DISTINCT condition_key FROM eligible_positions
      )
        AND (
          a.execution_active
          OR EXISTS (
            SELECT 1
            FROM realized_copy_lineage lineage
            WHERE lineage.wallet_key = a.wallet_key
              AND lineage.condition_key = lower(s.condition_id)
              AND lineage.token_id = s.token_id
          )
        )
    ), target_snapshot_ranked AS (
      SELECT
        s.*,
        row_number() OVER (
          PARTITION BY s.wallet_key, s.condition_key, s.token_id
          ORDER BY s.captured_at DESC, s.physical_condition, s.trader_wallet_id
        ) AS identity_rank,
        min(s.physical_condition) OVER (
          PARTITION BY s.wallet_key, s.condition_key, s.token_id
        ) <> max(s.physical_condition) OVER (
          PARTITION BY s.wallet_key, s.condition_key, s.token_id
        ) AS condition_identity_ambiguous
      FROM target_snapshot_source s
    ), target_by_position AS (
      SELECT
        condition_key,
        token_id,
        SUM(cost_basis_usdc) AS target_cost,
        bool_or(current_active) AS current_active,
        bool_or(wallet_identity_ambiguous OR condition_identity_ambiguous)
          AS identity_ambiguous
      FROM target_snapshot_ranked
      WHERE identity_rank = 1
      GROUP BY condition_key, token_id
    ), target_by_condition AS (
      SELECT
        condition_key,
        SUM(target_cost) AS target_cost,
        SUM(target_cost) FILTER (WHERE current_active) AS active_target_cost,
        bool_or(current_active) AS current_active,
        bool_or(identity_ambiguous) AS identity_ambiguous
      FROM target_by_position
      GROUP BY condition_key
    ), lines AS (
      SELECT
        p.condition_key,
        CASE WHEN bool_or(p.status = 'live') THEN 'live' ELSE 'closed' END AS status,
        min(p.group_key) AS group_key,
        SUM(p.own_cost) AS own_cost,
        CASE
          WHEN bool_or(p.status = 'live') THEN COALESCE(t.active_target_cost, 0)
          ELSE COALESCE(t.target_cost, 0)
        END AS target_cost,
        (
          bool_or(p.identity_ambiguous)
          OR min(p.group_key) <> max(p.group_key)
          OR COALESCE(t.identity_ambiguous, false)
          OR s.identity_ambiguous
        ) AS identity_ambiguous
      FROM eligible_positions p
      LEFT JOIN target_by_condition t ON t.condition_key = p.condition_key
      CROSS JOIN source_identity s
      GROUP BY p.condition_key, t.target_cost, t.active_target_cost,
        t.identity_ambiguous,
        s.identity_ambiguous
    ), position_eval AS (
      SELECT
        p.status,
        p.condition_key,
        p.token_id,
        (
          p.status = l.status
          AND l.own_cost > 0
          AND COALESCE(t.target_cost, 0) > 0
          AND (p.status = 'closed' OR COALESCE(t.current_active, false))
          AND NOT (
            p.identity_ambiguous
            OR l.identity_ambiguous
            OR COALESCE(t.identity_ambiguous, false)
          )
        ) AS comparable,
        (
          p.identity_ambiguous
          OR l.identity_ambiguous
          OR COALESCE(t.identity_ambiguous, false)
        ) AS ambiguous,
        CASE
          WHEN (
            p.identity_ambiguous
            OR l.identity_ambiguous
            OR COALESCE(t.identity_ambiguous, false)
          ) THEN 'identity_ambiguous'
          WHEN p.status <> l.status THEN 'status_mismatch'
          WHEN l.own_cost IS NULL OR l.own_cost <= 0 THEN 'local_entry_unavailable'
          WHEN tc.condition_key IS NULL
            OR (p.status = 'live' AND NOT COALESCE(tc.current_active, false))
            THEN 'no_target_position'
          WHEN t.condition_key IS NULL THEN 'exact_token_missing'
          WHEN p.status = 'live' AND NOT COALESCE(t.current_active, false)
            THEN 'exact_token_missing'
          WHEN t.target_cost <= 0 THEN 'target_entry_unavailable'
          ELSE 'comparable'
        END AS classification
      FROM eligible_positions p
      JOIN lines l ON l.condition_key = p.condition_key
      LEFT JOIN target_by_position t
        ON t.condition_key = p.condition_key
       AND t.token_id = p.token_id
      LEFT JOIN target_by_condition tc ON tc.condition_key = p.condition_key
    ), market_eval AS (
      SELECT
        CASE WHEN bool_or(l.status = 'live') THEN 'live' ELSE 'closed' END AS status,
        (
          SUM(l.own_cost) > 0
          AND SUM(l.target_cost) > 0
          AND NOT bool_or(l.identity_ambiguous)
        ) AS comparable,
        bool_or(l.identity_ambiguous) AS ambiguous
      FROM lines l
      GROUP BY l.group_key
    ), preview_snapshot_ranked AS (
      SELECT
        s.*,
        sc.group_key,
        row_number() OVER (
          PARTITION BY sc.group_key, s.wallet_key, s.condition_key, s.token_id
          ORDER BY s.captured_at DESC NULLS LAST, s.physical_condition,
            s.trader_wallet_id
        ) AS preview_identity_rank
      FROM target_snapshot_source s
      JOIN selected_conditions sc ON sc.condition_id = s.condition_key
      WHERE s.preview_eligible
    ), preview_latest AS (
      SELECT * FROM preview_snapshot_ranked WHERE preview_identity_rank = 1
    ), preview_projected AS (
      SELECT
        l.group_key,
        l.wallet_key AS wallet_address,
        l.label,
        l.condition_key AS condition_id,
        l.token_id,
        COALESCE(NULLIF(m.market_title, ''), NULLIF(d.raw->>'title', ''), 'Polymarket')
          AS market_title,
        COALESCE(NULLIF(m.event_title, ''), NULLIF(d.raw->>'eventTitle', ''))
          AS event_title,
        COALESCE(NULLIF(m.market_slug, ''), NULLIF(d.raw->>'slug', ''))
          AS market_slug,
        COALESCE(NULLIF(m.event_slug, ''), NULLIF(d.raw->>'eventSlug', ''))
          AS event_slug,
        COALESCE(NULLIF(d.raw->>'outcome', ''), 'UNKNOWN') AS outcome,
        d.shares::numeric AS shares,
        l.cost_basis_usdc,
        CASE WHEN cp.active THEN cp.current_value_usdc::numeric
             ELSE d.current_value_usdc::numeric END AS current_value_usdc,
        d.avg_price::numeric AS avg_price,
        CASE WHEN cp.active THEN cp.last_observed_at
             ELSE l.captured_at END AS last_observed_at,
        CASE
          WHEN cp.active IS TRUE THEN 'active'
          WHEN cp.active IS FALSE THEN 'inactive'
          ELSE 'inactive'
        END AS lifecycle,
        row_number() OVER (
          PARTITION BY l.group_key, l.wallet_key, l.condition_key
          ORDER BY l.cost_basis_usdc DESC, l.token_id
        ) AS leg_rank
      FROM preview_latest l
      JOIN lines comparison_line ON comparison_line.condition_key = l.condition_key
      JOIN poly_trader_position_snapshots d ON d.id = l.snapshot_id
      LEFT JOIN LATERAL (
        SELECT (${liveCurrentPositionSql("candidate")}) AS active,
          candidate.current_value_usdc,
          candidate.last_observed_at
        FROM poly_trader_current_positions candidate
        JOIN observable_targets candidate_wallet
          ON candidate_wallet.trader_wallet_id = candidate.trader_wallet_id
         AND candidate_wallet.wallet_key = l.wallet_key
         AND candidate_wallet.preview_eligible
        WHERE lower(candidate.condition_id) = l.condition_key
          AND candidate.token_id = l.token_id
        ORDER BY candidate.last_observed_at DESC, candidate.condition_id,
          candidate.trader_wallet_id
        LIMIT 1
      ) cp ON TRUE
      LEFT JOIN metadata m ON m.condition_key = l.condition_key
      WHERE comparison_line.status = 'closed' OR cp.active IS TRUE
    ), preview_participants AS (
      SELECT
        group_key,
        wallet_address,
        label,
        condition_id,
        SUM(current_value_usdc) AS participant_value,
        jsonb_agg(
          jsonb_build_object(
            'token_id', token_id,
            'market_title', market_title,
            'event_title', event_title,
            'market_slug', market_slug,
            'event_slug', event_slug,
            'outcome', outcome,
            'shares', shares,
            'cost_basis_usdc', cost_basis_usdc,
            'current_value_usdc', current_value_usdc,
            'avg_price', avg_price,
            'last_observed_at', last_observed_at,
            'lifecycle', lifecycle
          ) ORDER BY cost_basis_usdc DESC, token_id
        ) FILTER (WHERE leg_rank <= 2) AS legs
      FROM preview_projected
      WHERE leg_rank <= 2
      GROUP BY group_key, wallet_address, label, condition_id
    ), preview_participants_ranked AS (
      SELECT
        preview_participants.*,
        row_number() OVER (
          PARTITION BY group_key
          ORDER BY participant_value DESC, wallet_address, condition_id
        ) AS group_rank,
        count(*) OVER (PARTITION BY group_key) AS group_participant_count
      FROM preview_participants
    ), preview_per_group_bounded AS (
      SELECT * FROM preview_participants_ranked
      WHERE group_rank <= ${BOUNDED_TARGETS_PER_GROUP}
    ), preview_counted AS (
      SELECT
        preview_per_group_bounded.*,
        count(*) OVER () AS total_participants,
        bool_or(group_participant_count > ${BOUNDED_TARGETS_PER_GROUP}) OVER ()
          AS group_truncated
      FROM preview_per_group_bounded
    ), buckets(entity, status) AS (
      VALUES
        ('positions'::text, 'live'::text),
        ('positions'::text, 'closed'::text),
        ('markets'::text, 'live'::text),
        ('markets'::text, 'closed'::text)
    ), counted AS (
      SELECT
        'positions'::text AS entity,
        status,
        count(*)::int AS eligible,
        count(*) FILTER (WHERE comparable)::int AS comparable,
        count(*) FILTER (WHERE ambiguous)::int AS ambiguous
      FROM position_eval
      GROUP BY status
      UNION ALL
      SELECT
        'markets'::text AS entity,
        status,
        count(*)::int AS eligible,
        count(*) FILTER (WHERE comparable)::int AS comparable,
        count(*) FILTER (WHERE ambiguous)::int AS ambiguous
      FROM market_eval
      GROUP BY status
    ), count_output AS (
      SELECT
        b.entity,
        b.status,
        COALESCE(c.eligible, 0)::int AS eligible,
        COALESCE(c.comparable, 0)::int AS comparable,
        COALESCE(c.ambiguous, 0)::int AS ambiguous,
        s.identity_ambiguous AS source_ambiguous
      FROM buckets b
      LEFT JOIN counted c ON c.entity = b.entity AND c.status = b.status
      CROSS JOIN source_identity s
    ), preview_output AS (
      SELECT *
      FROM preview_counted
      ORDER BY participant_value DESC, wallet_address, condition_id
      LIMIT ${Math.max(0, Math.trunc(params.participantLimit))}
    )
    SELECT
      'count'::text AS record_kind,
      c.entity,
      c.status,
      c.eligible,
      c.comparable,
      c.ambiguous,
      c.source_ambiguous,
      NULL::bigint AS total_participants,
      NULL::boolean AS group_truncated,
      NULL::text AS group_key,
      NULL::text AS wallet_address,
      NULL::text AS label,
      NULL::text AS condition_id,
      NULL::text AS token_id,
      NULL::text AS classification,
      NULL::jsonb AS legs
    FROM count_output c
    UNION ALL
    SELECT
      'participant'::text AS record_kind,
      NULL::text AS entity,
      NULL::text AS status,
      NULL::int AS eligible,
      NULL::int AS comparable,
      NULL::int AS ambiguous,
      NULL::boolean AS source_ambiguous,
      p.total_participants,
      p.group_truncated,
      p.group_key,
      p.wallet_address,
      p.label,
      p.condition_id,
      NULL::text AS token_id,
      NULL::text AS classification,
      p.legs
    FROM preview_output p
    UNION ALL
    SELECT
      'classification'::text AS record_kind,
      NULL::text AS entity,
      p.status,
      NULL::int AS eligible,
      NULL::int AS comparable,
      NULL::int AS ambiguous,
      NULL::boolean AS source_ambiguous,
      NULL::bigint AS total_participants,
      NULL::boolean AS group_truncated,
      NULL::text AS group_key,
      NULL::text AS wallet_address,
      NULL::text AS label,
      p.condition_key AS condition_id,
      p.token_id,
      p.classification,
      NULL::jsonb AS legs
    FROM position_eval p
    JOIN selected_position_keys selected
      ON selected.condition_id = p.condition_key
     AND selected.token_id = p.token_id
     AND selected.status = p.status
    ORDER BY record_kind, entity, status, group_key, wallet_address,
      condition_id, token_id
  `)) as unknown as ComparisonBundleRow[];
}

function countRowsFromBundle(
  rows: readonly ComparisonBundleRow[]
): ComparisonCoverageCountRow[] {
  return rows.flatMap((row) =>
    row.record_kind === "count" &&
    (row.entity === "markets" || row.entity === "positions") &&
    (row.status === "live" || row.status === "closed")
      ? [
          {
            entity: row.entity,
            status: row.status,
            eligible: row.eligible ?? null,
            comparable: row.comparable ?? null,
            ambiguous: row.ambiguous ?? null,
            source_ambiguous: row.source_ambiguous ?? null,
          },
        ]
      : []
  );
}

function classificationRowsFromBundle(
  rows: readonly ComparisonBundleRow[]
): PositionComparisonClassification[] {
  const validResults = new Set<PositionComparisonClassification["result"]>([
    "comparable",
    "no_target_position",
    "exact_token_missing",
    "target_entry_unavailable",
    "local_entry_unavailable",
    "identity_ambiguous",
    "status_mismatch",
  ]);
  return rows.flatMap((row) =>
    row.record_kind === "classification" &&
    (row.status === "live" || row.status === "closed") &&
    typeof row.condition_id === "string" &&
    typeof row.token_id === "string" &&
    row.classification !== null &&
    row.classification !== undefined &&
    validResults.has(row.classification)
      ? [
          {
            conditionId: row.condition_id,
            tokenId: row.token_id,
            status: row.status,
            result: row.classification,
          },
        ]
      : []
  );
}

export function unavailableComparisonCoverage(): WalletDashboardComparisonCoverage {
  return {
    markets: {
      live: unavailableCoverageLeaf(),
      closed: unavailableCoverageLeaf(),
    },
    positions: {
      live: unavailableCoverageLeaf(),
      closed: unavailableCoverageLeaf(),
    },
    positionClassifications: [],
  };
}

export function materializeComparisonCoverage(params: {
  counts: readonly ComparisonCoverageCountRow[];
  positionClassifications?: readonly PositionComparisonClassification[];
  groups: readonly WalletExecutionMarketGroup[];
  livePositions: readonly WalletExecutionPosition[];
  closedPositions: readonly WalletExecutionPosition[];
  sourceComplete: boolean;
  previewTruncated: boolean;
}): WalletDashboardComparisonCoverage {
  const countsByBucket = new Map(
    params.counts.map((row) => [`${row.entity}:${row.status}`, row] as const)
  );
  const marketSamples = {
    live: params.groups.filter(
      (group) =>
        group.status === "live" &&
        group.edgeGapPct !== null &&
        Number.isFinite(group.edgeGapPct)
    ).length,
    closed: params.groups.filter(
      (group) =>
        group.status === "closed" &&
        group.edgeGapPct !== null &&
        Number.isFinite(group.edgeGapPct)
    ).length,
  };
  const lineByCondition = new Map<
    string,
    {
      status: WalletExecutionMarketLineStatus;
      edgeGapPct: number | null;
      targetTokenIds: ReadonlySet<string>;
    } | null
  >();
  for (const group of params.groups) {
    for (const line of group.lines) {
      const key = canonicalIdentity(line.conditionId);
      lineByCondition.set(
        key,
        lineByCondition.has(key)
          ? null
          : {
              status: line.status,
              edgeGapPct: line.edgeGapPct,
              targetTokenIds: new Set(
                (line.participants ?? [])
                  .filter((participant) => participant.side === "copy_target")
                  .flatMap((participant) => [
                    participant.primary?.tokenId,
                    participant.hedge?.tokenId,
                  ])
                  .filter(
                    (tokenId): tokenId is string => tokenId !== undefined
                  )
              ),
            }
      );
    }
  }
  const sampledPositions = (
    positions: readonly WalletExecutionPosition[],
    status: WalletExecutionMarketLineStatus
  ): number =>
    positions.filter((position) => {
      const line = lineByCondition.get(canonicalIdentity(position.conditionId));
      return (
        line !== undefined &&
        line !== null &&
        line.status === status &&
        line.targetTokenIds.has(position.asset) &&
        line.edgeGapPct !== null &&
        Number.isFinite(line.edgeGapPct)
      );
    }).length;

  const classificationByVisibleKey = new Map(
    (params.positionClassifications ?? []).map((classification) => [
      `${classification.status}:${canonicalIdentity(classification.conditionId)}:${classification.tokenId}`,
      classification,
    ])
  );
  const visiblePositionClassifications = [
    ...params.livePositions.map(
      (position) => [position, "live" as const] as const
    ),
    ...params.closedPositions.map(
      (position) => [position, "closed" as const] as const
    ),
  ].flatMap(([position, status]) => {
    const classification = classificationByVisibleKey.get(
      `${status}:${canonicalIdentity(position.conditionId)}:${position.asset}`
    );
    return classification === undefined ? [] : [classification];
  });

  const leaf = (
    entity: "markets" | "positions",
    status: WalletExecutionMarketLineStatus,
    sampled: number
  ): WalletDashboardComparisonCoverageLeaf => {
    const row = countsByBucket.get(`${entity}:${status}`);
    if (!row) {
      return unavailableCoverageLeaf();
    }
    const eligible = parseNonnegativeInteger(row.eligible);
    const comparable = parseNonnegativeInteger(row.comparable);
    const ambiguous = parseNonnegativeInteger(row.ambiguous);
    if (
      eligible === null ||
      comparable === null ||
      ambiguous === null ||
      typeof row.source_ambiguous !== "boolean" ||
      comparable > eligible ||
      ambiguous > eligible - comparable ||
      !Number.isSafeInteger(sampled) ||
      sampled < 0
    ) {
      return unavailableCoverageLeaf();
    }
    const dropped = eligible - comparable;
    const identityAmbiguous = ambiguous > 0 || row.source_ambiguous;
    if (!identityAmbiguous && sampled > comparable) {
      return unavailableCoverageLeaf();
    }
    // Ambiguous or incomplete sources do not feed a histogram. `sampled`
    // describes trusted finite values actually supplied to that chart, not
    // merely finite numbers present in the bounded transport payload.
    const trustedSampled =
      identityAmbiguous || !params.sourceComplete ? 0 : sampled;
    const reasons: WalletDashboardComparisonCoverageReason[] = [];
    if (!params.sourceComplete) reasons.push("source_incomplete");
    if (dropped > 0) reasons.push("comparison_missing");
    if (identityAmbiguous) {
      reasons.push("identity_ambiguous");
    }
    if (params.previewTruncated || sampled < comparable) {
      reasons.push("preview_truncated");
    }
    return {
      eligible,
      comparable,
      dropped,
      sampled: trustedSampled,
      complete:
        dropped === 0 && trustedSampled === comparable && reasons.length === 0,
      reasons,
    };
  };

  return {
    markets: {
      live: leaf("markets", "live", marketSamples.live),
      closed: leaf("markets", "closed", marketSamples.closed),
    },
    positions: {
      live: leaf(
        "positions",
        "live",
        sampledPositions(params.livePositions, "live")
      ),
      closed: leaf(
        "positions",
        "closed",
        sampledPositions(params.closedPositions, "closed")
      ),
    },
    positionClassifications: visiblePositionClassifications,
  };
}

/**
 * Fold fill-rollup truth (BUY notional, SELL proceeds, redemption credit)
 * into a `RawLeg`. After this pass every leg carries its realized P/L and
 * a non-zero cost basis whenever the wallet ever bought into the token —
 * preventing closed positions from collapsing to a 0/0 `currentValue −
 * costBasis` artifact in `toContractLeg`.
 */
function enrichLegWithRollup(
  leg: RawLeg,
  rollups: ReadonlyMap<string, FillRollup>
): RawLeg {
  const rollup = rollups.get(
    rollupKey(leg.walletAddress, leg.conditionId, leg.tokenId)
  );
  if (rollup === undefined) {
    return {
      ...leg,
      pnlUsdc: roundMoney(leg.currentValueUsdc - leg.costBasisUsdc),
      redemptionProceedsUsdc: 0,
    };
  }
  const { pnlUsd, redemptionProceeds } = computeRealizedPnl({
    totalBuyNotional: rollup.totalBuyNotional,
    realizedCash: rollup.realizedCash,
    currentMarkValue: leg.currentValueUsdc,
    netShares: rollup.netShares,
    marketOutcome: rollup.marketOutcome,
  });
  const costBasisUsdc =
    leg.costBasisUsdc > 0 ? leg.costBasisUsdc : rollup.totalBuyNotional;
  return {
    ...leg,
    costBasisUsdc,
    pnlUsdc: pnlUsd,
    redemptionProceedsUsdc: redemptionProceeds,
  };
}

function buildOurLegs(
  positions: readonly WalletExecutionPosition[],
  walletAddress: string,
  ourPositionStatus: WalletExecutionMarketLineStatus
): RawLeg[] {
  return positions.map((position) => {
    const costBasisUsdc = costBasisFromExecutionPosition(position);
    const vwap = position.entryPrice > 0 ? position.entryPrice : null;
    return {
      side: "our_wallet",
      source: "ledger",
      label: "Our wallet",
      walletAddress: walletAddress.toLowerCase(),
      conditionId: canonicalIdentity(position.conditionId),
      tokenId: position.asset,
      marketTitle: position.marketTitle,
      eventTitle: position.eventTitle ?? null,
      marketSlug: position.marketSlug ?? null,
      eventSlug: position.eventSlug ?? null,
      outcome: position.outcome,
      shares: position.size,
      costBasisUsdc,
      currentValueUsdc: position.currentValue,
      vwap,
      avgPrice: vwap,
      lifecycle: ourPositionStatus === "closed" ? "inactive" : "active",
      lastObservedAt: position.openedAt,
      ourPositionStatus,
      // Placeholder — `enrichLegWithRollup` overwrites this with the real
      // realized P/L (fills + market outcome). Leaves the pre-fix
      // currentValue-minus-costBasis fallback in case no rollup row exists.
      pnlUsdc: roundMoney(position.currentValue - costBasisUsdc),
      redemptionProceedsUsdc: 0,
    };
  });
}

async function readTargetLegs(params: {
  db: Db;
  billingAccountId: string;
  conditions: readonly string[];
  conditionStatus: ReadonlyMap<string, WalletExecutionMarketLineStatus>;
}): Promise<RawLeg[]> {
  if (params.conditions.length === 0) return [];

  const conditionList = sql.join(
    params.conditions.map((condition) => sql`${condition}`),
    sql`, `
  );
  const rows = (await params.db.execute(sql`
    WITH active_targets AS (
      SELECT
        lower(t.target_wallet) AS wallet_address,
        w.id AS trader_wallet_id,
        COALESCE(NULLIF(w.label, ''), 'Copy target') AS label
      FROM poly_copy_trade_targets t
      JOIN poly_trader_wallets w ON lower(w.wallet_address) = lower(t.target_wallet)
      WHERE t.billing_account_id = ${params.billingAccountId}
        AND t.disabled_at IS NULL
        AND w.disabled_at IS NULL
    ),
    latest_snapshots AS (
      -- Canonical wallet + condition identity leads DISTINCT ON so facts on
      -- differently-cased physical sibling rows collapse deterministically.
      -- Only bounded scalar raw->> projections leave the CTE — never the
      -- whole Data-API raw jsonb blob.
      SELECT DISTINCT ON (a.wallet_address, lower(s.condition_id), s.token_id)
        a.wallet_address,
        a.label,
        s.trader_wallet_id,
        lower(s.condition_id) AS condition_id,
        s.token_id,
        s.shares::numeric AS shares,
        s.cost_basis_usdc::numeric AS cost_basis_usdc,
        s.current_value_usdc::numeric AS current_value_usdc,
        s.avg_price::numeric AS avg_price,
        s.captured_at AS last_observed_at,
        s.raw->>'title' AS raw_title,
        s.raw->>'eventTitle' AS raw_event_title,
        s.raw->>'slug' AS raw_slug,
        s.raw->>'eventSlug' AS raw_event_slug,
        s.raw->>'outcome' AS raw_outcome
      FROM poly_trader_position_snapshots s
      JOIN active_targets a ON a.trader_wallet_id = s.trader_wallet_id
      WHERE lower(s.condition_id) IN (${conditionList})
      -- captured_at is NOT NULL; DESC NULLS LAST documents newest-first and
      -- the remaining physical fields make the selected sibling stable.
      ORDER BY a.wallet_address, lower(s.condition_id), s.token_id,
        s.captured_at DESC NULLS LAST, s.condition_id, s.trader_wallet_id
    )
    SELECT
      ls.wallet_address,
      ls.label,
      ls.condition_id,
      ls.token_id,
      -- Canonical Gamma metadata via poly_market_metadata; fall back to
      -- the legacy raw_* scalar projections (extracted in the CTE above —
      -- never the wholesale raw jsonb) so the first deploy (empty metadata
      -- table) does not regress. Drop the fallback once the metadata
      -- table is fully backfilled.
      COALESCE(
        NULLIF(pmm.market_title, ''),
        NULLIF(ls.raw_title, ''),
        'Polymarket'
      ) AS market_title,
      COALESCE(
        NULLIF(pmm.event_title, ''),
        NULLIF(ls.raw_event_title, '')
      ) AS event_title,
      COALESCE(
        NULLIF(pmm.market_slug, ''),
        NULLIF(ls.raw_slug, '')
      ) AS market_slug,
      COALESCE(
        NULLIF(pmm.event_slug, ''),
        NULLIF(ls.raw_event_slug, '')
      ) AS event_slug,
      COALESCE(NULLIF(ls.raw_outcome, ''), 'UNKNOWN') AS outcome,
      ls.shares,
      ls.cost_basis_usdc,
      -- LIVE_MARK_FROM_CURRENT_POSITIONS (task.5012): snapshots are only
      -- written on position-defining changes, so a still-held position's
      -- latest snapshot carries a stale mark. Prefer the live mark from
      -- poly_trader_current_positions while the row is active; fall back to
      -- the snapshot's last-observed value once the sync deactivates it
      -- (exit/resolution) — SNAPSHOTS_ARE_DURABLE_TRUTH.
      CASE WHEN cp.active THEN cp.current_value_usdc::numeric
           ELSE ls.current_value_usdc END AS current_value_usdc,
      ls.avg_price,
      CASE WHEN cp.active THEN cp.last_observed_at
           ELSE ls.last_observed_at END AS last_observed_at,
      CASE
        WHEN cp.active IS TRUE THEN 'active'
        WHEN cp.active IS FALSE THEN 'inactive'
        ELSE 'inactive'
      END AS lifecycle
    FROM latest_snapshots ls
    LEFT JOIN LATERAL (
      SELECT (${liveCurrentPositionSql("candidate")}) AS active,
        candidate.current_value_usdc,
        candidate.last_observed_at
      FROM poly_trader_current_positions candidate
      JOIN active_targets candidate_wallet
        ON candidate_wallet.trader_wallet_id = candidate.trader_wallet_id
       AND candidate_wallet.wallet_address = ls.wallet_address
      WHERE lower(candidate.condition_id) = ls.condition_id
        AND candidate.token_id = ls.token_id
      ORDER BY candidate.last_observed_at DESC, candidate.condition_id,
        candidate.trader_wallet_id
      LIMIT 1
    ) cp ON TRUE
    LEFT JOIN LATERAL (
      SELECT candidate.market_title, candidate.event_title,
        candidate.market_slug, candidate.event_slug
      FROM poly_market_metadata candidate
      WHERE lower(candidate.condition_id) = ls.condition_id
      ORDER BY candidate.fetched_at DESC, candidate.condition_id
      LIMIT 1
    ) pmm ON TRUE
    ORDER BY current_value_usdc DESC NULLS LAST
  `)) as unknown as TargetPositionRow[];

  return rows.flatMap((row) => {
    if (
      row.wallet_address === null ||
      row.condition_id === null ||
      row.token_id === null
    ) {
      return [];
    }
    const shares = toNumber(row.shares);
    const costBasisUsdc = toNumber(row.cost_basis_usdc);
    const avgPrice = nullableNumber(row.avg_price);
    const lifecycle: WalletExecutionMarketLeg["lifecycle"] =
      row.lifecycle === "inactive" ? "inactive" : "active";
    if (
      params.conditionStatus.get(canonicalIdentity(row.condition_id)) ===
        "live" &&
      lifecycle !== "active"
    ) {
      return [];
    }
    const currentValueUsdc = toNumber(row.current_value_usdc);
    return [
      {
        side: "copy_target",
        source: "trader_current_positions",
        label: row.label ?? "Copy target",
        walletAddress: row.wallet_address.toLowerCase(),
        conditionId: canonicalIdentity(row.condition_id),
        tokenId: row.token_id,
        marketTitle: row.market_title ?? "Polymarket",
        eventTitle: row.event_title,
        marketSlug: row.market_slug,
        eventSlug: row.event_slug,
        outcome: row.outcome ?? "UNKNOWN",
        shares,
        costBasisUsdc,
        currentValueUsdc,
        vwap: positionVwap(costBasisUsdc, shares, avgPrice),
        avgPrice,
        lifecycle,
        lastObservedAt: isoOrNull(row.last_observed_at),
        ourPositionStatus: null,
        // Placeholder — overwritten by `enrichLegWithRollup` once the
        // fill rollup + market outcome are joined in.
        pnlUsdc: roundMoney(currentValueUsdc - costBasisUsdc),
        redemptionProceedsUsdc: 0,
      },
    ];
  });
}

async function readBoundedTargetLegs(params: {
  db: Db;
  billingAccountId: string;
  conditionGroup: ReadonlyMap<string, string>;
  participantLimit: number;
}): Promise<{
  legs: RawLeg[];
  totalParticipants: number;
  hydratedParticipants: number;
  groupTruncated: boolean;
}> {
  if (params.conditionGroup.size === 0 || params.participantLimit <= 0) {
    return {
      legs: [],
      totalParticipants: 0,
      hydratedParticipants: 0,
      groupTruncated: false,
    };
  }
  const selectedConditions = sql.join(
    [...params.conditionGroup.entries()].map(
      ([conditionId, groupKey]) => sql`(${conditionId}, ${groupKey})`
    ),
    sql`, `
  );
  const rows = (await params.db.execute(sql`
    WITH selected_conditions(condition_id, group_key) AS (
      VALUES ${selectedConditions}
    ), active_targets AS (
      SELECT
        lower(t.target_wallet) AS wallet_address,
        w.id AS trader_wallet_id,
        COALESCE(NULLIF(w.label, ''), 'Copy target') AS label
      FROM poly_copy_trade_targets t
      JOIN poly_trader_wallets w ON lower(w.wallet_address) = lower(t.target_wallet)
      WHERE t.billing_account_id = ${params.billingAccountId}
        AND t.disabled_at IS NULL
        AND w.disabled_at IS NULL
    ), latest AS (
      SELECT DISTINCT ON (
        sc.group_key, a.wallet_address, lower(s.condition_id), s.token_id
      )
        sc.group_key,
        a.wallet_address,
        a.label,
        s.trader_wallet_id,
        lower(s.condition_id) AS condition_id,
        s.token_id,
        s.shares::numeric AS shares,
        s.cost_basis_usdc::numeric AS cost_basis_usdc,
        s.current_value_usdc::numeric AS snapshot_value_usdc,
        s.avg_price::numeric AS avg_price,
        s.captured_at,
        s.raw->>'title' AS raw_title,
        s.raw->>'eventTitle' AS raw_event_title,
        s.raw->>'slug' AS raw_slug,
        s.raw->>'eventSlug' AS raw_event_slug,
        s.raw->>'outcome' AS raw_outcome
      FROM selected_conditions sc
      JOIN poly_trader_position_snapshots s
        ON lower(s.condition_id) = sc.condition_id
      JOIN active_targets a ON a.trader_wallet_id = s.trader_wallet_id
      ORDER BY sc.group_key, a.wallet_address, lower(s.condition_id), s.token_id,
        s.captured_at DESC NULLS LAST, s.condition_id, s.trader_wallet_id
    ), projected AS (
      SELECT
        l.group_key,
        l.wallet_address,
        l.label,
        l.condition_id,
        l.token_id,
        COALESCE(NULLIF(pmm.market_title, ''), NULLIF(l.raw_title, ''), 'Polymarket') AS market_title,
        COALESCE(NULLIF(pmm.event_title, ''), NULLIF(l.raw_event_title, '')) AS event_title,
        COALESCE(NULLIF(pmm.market_slug, ''), NULLIF(l.raw_slug, '')) AS market_slug,
        COALESCE(NULLIF(pmm.event_slug, ''), NULLIF(l.raw_event_slug, '')) AS event_slug,
        COALESCE(NULLIF(l.raw_outcome, ''), 'UNKNOWN') AS outcome,
        l.shares,
        l.cost_basis_usdc,
        CASE WHEN cp.active THEN cp.current_value_usdc::numeric ELSE l.snapshot_value_usdc END AS current_value_usdc,
        l.avg_price,
        CASE WHEN cp.active THEN cp.last_observed_at ELSE l.captured_at END AS last_observed_at,
        CASE
          WHEN cp.active IS TRUE THEN 'active'
          WHEN cp.active IS FALSE THEN 'inactive'
          ELSE 'inactive'
        END AS lifecycle,
        ROW_NUMBER() OVER (
          PARTITION BY l.group_key, l.wallet_address, l.condition_id
          ORDER BY l.cost_basis_usdc DESC, l.token_id
        ) AS leg_rank
      FROM latest l
      LEFT JOIN LATERAL (
        SELECT (${liveCurrentPositionSql("candidate")}) AS active,
          candidate.current_value_usdc,
          candidate.last_observed_at
        FROM poly_trader_current_positions candidate
        JOIN active_targets candidate_wallet
          ON candidate_wallet.trader_wallet_id = candidate.trader_wallet_id
         AND candidate_wallet.wallet_address = l.wallet_address
        WHERE lower(candidate.condition_id) = l.condition_id
          AND candidate.token_id = l.token_id
        ORDER BY candidate.last_observed_at DESC, candidate.condition_id,
          candidate.trader_wallet_id
        LIMIT 1
      ) cp ON TRUE
      LEFT JOIN LATERAL (
        SELECT candidate.market_title, candidate.event_title,
          candidate.market_slug, candidate.event_slug
        FROM poly_market_metadata candidate
        WHERE lower(candidate.condition_id) = l.condition_id
        ORDER BY candidate.fetched_at DESC, candidate.condition_id
        LIMIT 1
      ) pmm ON TRUE
    ), participants AS (
      SELECT
        group_key,
        wallet_address,
        label,
        condition_id,
        SUM(current_value_usdc) AS participant_value,
        jsonb_agg(
          jsonb_build_object(
            'token_id', token_id,
            'market_title', market_title,
            'event_title', event_title,
            'market_slug', market_slug,
            'event_slug', event_slug,
            'outcome', outcome,
            'shares', shares,
            'cost_basis_usdc', cost_basis_usdc,
            'current_value_usdc', current_value_usdc,
            'avg_price', avg_price,
            'last_observed_at', last_observed_at,
            'lifecycle', lifecycle
          ) ORDER BY cost_basis_usdc DESC, token_id
        ) FILTER (WHERE leg_rank <= 2) AS legs
      FROM projected
      WHERE leg_rank <= 2
      GROUP BY group_key, wallet_address, label, condition_id
    ), ranked AS (
      SELECT
        participants.*,
        ROW_NUMBER() OVER (
          PARTITION BY group_key
          ORDER BY participant_value DESC, wallet_address, condition_id
        ) AS group_rank,
        COUNT(*) OVER (PARTITION BY group_key) AS group_participant_count
      FROM participants
    ), per_group_bounded AS (
      SELECT * FROM ranked WHERE group_rank <= ${BOUNDED_TARGETS_PER_GROUP}
    ), counted AS (
      SELECT
        per_group_bounded.*,
        COUNT(*) OVER () AS total_participants,
        BOOL_OR(group_participant_count > ${BOUNDED_TARGETS_PER_GROUP}) OVER () AS group_truncated
      FROM per_group_bounded
    )
    SELECT
      total_participants,
      group_truncated,
      group_key,
      wallet_address,
      label,
      condition_id,
      legs
    FROM counted
    ORDER BY participant_value DESC, wallet_address, condition_id
    LIMIT ${Math.max(0, Math.trunc(params.participantLimit))}
  `)) as unknown as BoundedTargetParticipantRow[];

  return boundedTargetReadFromRows(rows);
}

function boundedTargetReadFromRows(
  rows: readonly BoundedTargetParticipantRow[]
): {
  legs: RawLeg[];
  totalParticipants: number;
  hydratedParticipants: number;
  groupTruncated: boolean;
} {
  const legs: RawLeg[] = [];
  for (const row of rows) {
    if (
      row.wallet_address === null ||
      row.condition_id === null ||
      !Array.isArray(row.legs)
    ) {
      continue;
    }
    for (const value of row.legs.slice(0, 2)) {
      if (!value || typeof value !== "object") continue;
      const leg = value as BoundedTargetLeg;
      if (typeof leg.token_id !== "string" || leg.token_id.length === 0)
        continue;
      const shares = toNumber(leg.shares);
      const costBasisUsdc = toNumber(leg.cost_basis_usdc);
      const currentValueUsdc = toNumber(leg.current_value_usdc);
      const avgPrice = nullableNumber(leg.avg_price);
      legs.push({
        side: "copy_target",
        source: "trader_current_positions",
        label: row.label ?? "Copy target",
        walletAddress: row.wallet_address.toLowerCase(),
        conditionId: canonicalIdentity(row.condition_id),
        tokenId: leg.token_id,
        marketTitle: leg.market_title ?? "Polymarket",
        eventTitle: leg.event_title,
        marketSlug: leg.market_slug,
        eventSlug: leg.event_slug,
        outcome: leg.outcome ?? "UNKNOWN",
        shares,
        costBasisUsdc,
        currentValueUsdc,
        vwap: positionVwap(costBasisUsdc, shares, avgPrice),
        avgPrice,
        lifecycle: leg.lifecycle === "inactive" ? "inactive" : "active",
        lastObservedAt: isoOrNull(leg.last_observed_at),
        ourPositionStatus: null,
        pnlUsdc: roundMoney(currentValueUsdc - costBasisUsdc),
        redemptionProceedsUsdc: 0,
      });
    }
  }
  return {
    legs,
    totalParticipants: toNumber(rows[0]?.total_participants),
    hydratedParticipants: rows.length,
    groupTruncated: rows[0]?.group_truncated === true,
  };
}

function participantRowsFromBundle(
  rows: readonly ComparisonBundleRow[]
): BoundedTargetParticipantRow[] {
  return rows.flatMap((row) =>
    row.record_kind === "participant"
      ? [
          {
            total_participants: row.total_participants ?? null,
            group_truncated: row.group_truncated ?? null,
            group_key: row.group_key ?? null,
            wallet_address: row.wallet_address ?? null,
            label: row.label ?? null,
            condition_id: row.condition_id ?? null,
            legs: row.legs ?? null,
          },
        ]
      : []
  );
}

function groupParticipants(
  legs: readonly RawLeg[],
  rollups: ReadonlyMap<string, FillRollup>
): WalletExecutionMarketGroup[] {
  const byCondition = new Map<string, RawLeg[]>();
  for (const leg of legs) {
    const conditionId = canonicalIdentity(leg.conditionId);
    const list = byCondition.get(conditionId) ?? [];
    list.push(leg);
    byCondition.set(conditionId, list);
  }

  type Line = WalletExecutionMarketGroup["lines"][number];
  type LineWithMeta = {
    line: Line;
    /** Our combined buy notional on this line; weight for group blending. */
    ourTotalBuyNotional: number;
    /** Combined target buy notional across ALL targets on this line. */
    targetTotalBuyNotional: number;
    /** Internal: per-line our return (Modified-Dietz). Used to roll up
     * group-level edgeGap. Not in the public contract. */
    ourReturnPct: number | null;
    /** Internal: per-line blended target return. Not in the public contract. */
    targetReturnPct: number | null;
  };

  const groupBuckets = new Map<
    string,
    {
      eventTitle: string | null;
      eventSlug: string | null;
      lines: LineWithMeta[];
    }
  >();

  for (const [conditionId, conditionLegs] of byCondition.entries()) {
    const participants = pivotParticipants(conditionLegs);
    const anchor = pickAnchor(conditionLegs);
    if (anchor === null) continue;
    const eventSlug =
      conditionLegs.find((leg) => leg.eventSlug !== null)?.eventSlug ?? null;
    const eventTitle =
      conditionLegs.find((leg) => leg.eventTitle !== null)?.eventTitle ?? null;
    const groupKey = eventSlug
      ? `event:${eventSlug}`
      : `condition:${conditionId}`;

    const ourLegs = conditionLegs.filter((leg) => leg.side === "our_wallet");
    const targetLegs = conditionLegs.filter(
      (leg) => leg.side === "copy_target"
    );
    const ourValueUsdc = roundMoney(sumValue(ourLegs));
    const hasTargetFacts = targetLegs.length > 0;
    const targetValueUsdc = hasTargetFacts
      ? roundMoney(sumValue(targetLegs))
      : null;

    const ourAgg = aggregateWalletReturn(ourLegs, rollups);
    const ourReturnPct = positionReturnPct({
      totalBuyNotional: ourAgg.totalBuyNotional,
      realizedCash: ourAgg.realizedCash,
      currentMarkValue: ourAgg.currentMarkValue,
      redemptionProceeds: ourAgg.redemptionProceeds,
    });

    // Target side: per-target return, then cost-basis-weighted blend.
    const byTargetWallet = new Map<string, RawLeg[]>();
    for (const leg of targetLegs) {
      const list = byTargetWallet.get(leg.walletAddress) ?? [];
      list.push(leg);
      byTargetWallet.set(leg.walletAddress, list);
    }
    const targetEntries: {
      totalBuyNotional: number;
      returnPct: number | null;
    }[] = [];
    let targetGrossBuyNotional: number | null = 0;
    for (const tlegs of byTargetWallet.values()) {
      const agg = aggregateWalletReturn(tlegs, rollups);
      targetEntries.push({
        totalBuyNotional: agg.totalBuyNotional,
        returnPct: positionReturnPct({
          totalBuyNotional: agg.totalBuyNotional,
          realizedCash: agg.realizedCash,
          currentMarkValue: agg.currentMarkValue,
          redemptionProceeds: agg.redemptionProceeds,
        }),
      });
      const hasCompleteGrossBuyRollup = tlegs.every((leg) =>
        rollups.has(rollupKey(leg.walletAddress, leg.conditionId, leg.tokenId))
      );
      targetGrossBuyNotional =
        targetGrossBuyNotional === null || !hasCompleteGrossBuyRollup
          ? null
          : targetGrossBuyNotional + agg.grossBuyNotional;
    }
    const targetReturnPct = blendTargetReturns(targetEntries);
    const targetTotalBuyNotional = targetEntries.reduce(
      (sum, e) => sum + e.totalBuyNotional,
      0
    );
    const hasTargetEntryFacts =
      hasTargetFacts && targetTotalBuyNotional > 0;

    const { rateGapPct, sizeScaledGapUsdc } = edgeGap({
      ourReturnPct,
      targetReturnPct,
      ourTotalBuyNotional: ourAgg.totalBuyNotional,
    });

    const lineStatus: WalletExecutionMarketLineStatus = ourLegs.some(
      (leg) => leg.ourPositionStatus === "live"
    )
      ? "live"
      : "closed";

    // OLD CONTRACT FIELD MAPPING — populate `edgeGapUsdc`/`edgeGapPct` from
    // the new math (Modified-Dietz Rate gap + size-scaled $ gap). Same sign
    // convention as the legacy formula (positive = target ahead = leak), but
    // bounded — no more divide-by-near-zero −1.7M% values. See
    // .context/revert-poly-markets-ui-prompt.md for rationale.
    const line: Line = {
      conditionId,
      marketTitle: anchor.marketTitle,
      marketSlug: anchor.marketSlug,
      resolvesAt: null,
      status: lineStatus,
      ourValueUsdc,
      targetValueUsdc,
      ourEntryValueUsdc: roundMoney(ourAgg.totalBuyNotional),
      targetEntryValueUsdc: hasTargetEntryFacts
        ? roundMoney(targetTotalBuyNotional)
        : null,
      ourGrossBuyNotionalUsdc: roundMoney(ourAgg.grossBuyNotional),
      targetGrossBuyNotionalUsdc:
        hasTargetFacts && targetGrossBuyNotional !== null
          ? roundMoney(targetGrossBuyNotional)
          : null,
      ourVwap: weightedVwap(ourLegs),
      targetVwap: weightedVwap(targetLegs),
      edgeGapUsdc: sizeScaledGapUsdc,
      edgeGapPct: rateGapPct,
      hedgeCount: participants.filter((p) => p.hedge !== null).length,
      participants,
    };

    const bucket = groupBuckets.get(groupKey) ?? {
      eventTitle,
      eventSlug,
      lines: [] as LineWithMeta[],
    };
    if (bucket.eventTitle === null && eventTitle !== null) {
      bucket.eventTitle = eventTitle;
    }
    bucket.lines.push({
      line,
      ourTotalBuyNotional: ourAgg.totalBuyNotional,
      targetTotalBuyNotional,
      ourReturnPct,
      targetReturnPct,
    });
    groupBuckets.set(groupKey, bucket);
  }

  return [...groupBuckets.entries()]
    .map(([groupKey, bucket]) => {
      const sorted = [...bucket.lines].sort((left, right) =>
        compareLine(left.line, right.line)
      );
      const groupStatus: WalletExecutionMarketLineStatus = sorted.some(
        (entry) => entry.line.status === "live"
      )
        ? "live"
        : "closed";
      const lines = sorted.map((entry) => entry.line);

      // Group-level metrics: cost-basis-weighted blends of per-line returns,
      // weighted by each line's our (resp. target) buy notional. Mirrors the
      // single-line formula one level up.
      const groupOurReturnPct = blendTargetReturns(
        sorted.map((entry) => ({
          totalBuyNotional: entry.ourTotalBuyNotional,
          returnPct: entry.ourReturnPct,
        }))
      );
      const groupTargetReturnPct = blendTargetReturns(
        sorted.map((entry) => ({
          totalBuyNotional: entry.targetTotalBuyNotional,
          returnPct: entry.targetReturnPct,
        }))
      );
      const groupOurTotalBuyNotional = sorted.reduce(
        (sum, entry) => sum + entry.ourTotalBuyNotional,
        0
      );
      const groupGap = edgeGap({
        ourReturnPct: groupOurReturnPct,
        targetReturnPct: groupTargetReturnPct,
        ourTotalBuyNotional: groupOurTotalBuyNotional,
      });

      return {
        groupKey,
        eventTitle: bucket.eventTitle,
        eventSlug: bucket.eventSlug,
        marketCount: lines.length,
        status: groupStatus,
        ourValueUsdc: roundMoney(
          lines.reduce((sum, line) => sum + line.ourValueUsdc, 0)
        ),
        targetValueUsdc: sumAvailableMoney(
          lines.map((line) => line.targetValueUsdc)
        ),
        ourEntryValueUsdc: roundMoney(
          lines.reduce((sum, line) => sum + line.ourEntryValueUsdc, 0)
        ),
        targetEntryValueUsdc: sumAvailableMoney(
          lines.map((line) => line.targetEntryValueUsdc)
        ),
        ourGrossBuyNotionalUsdc: roundMoney(
          lines.reduce((sum, line) => sum + line.ourGrossBuyNotionalUsdc, 0)
        ),
        targetGrossBuyNotionalUsdc: sumAvailableMoney(
          lines.map((line) => line.targetGrossBuyNotionalUsdc)
        ),
        pnlUsd: roundMoney(
          lines.reduce(
            (sum, line) =>
              sum +
              line.participants
                .filter((p) => p.side === "our_wallet")
                .reduce((rowSum, p) => rowSum + p.net.pnlUsdc, 0),
            0
          )
        ),
        edgeGapUsdc: groupGap.sizeScaledGapUsdc,
        edgeGapPct: groupGap.rateGapPct,
        hedgeCount: lines.reduce((sum, line) => sum + line.hedgeCount, 0),
        lines,
      };
    })
    .sort((left, right) => {
      // Default sort: largest alpha leak first by `edgeGapUsdc` (which is now
      // the bounded sizeScaledGapUsdc value). Null gaps sort last so
      // unmatched markets don't crowd the head.
      const lv = left.edgeGapUsdc;
      const rv = right.edgeGapUsdc;
      if (lv === null && rv === null) {
        return right.ourValueUsdc - left.ourValueUsdc;
      }
      if (lv === null) return 1;
      if (rv === null) return -1;
      return rv - lv;
    });
}

/**
 * Sum (totalBuyNotional, currentMarkValue, grossBuyNotional) across a
 * wallet's legs in one condition. See SINGLE_BASIS_SNAPSHOT_COST in the
 * module header for the rationale.
 *
 * - `totalBuyNotional` = Σ snapshot.cost_basis_usdc. Canonical "cost" for
 *   P/L, return %, and the Markets-table "Entry" column. Vendor-FIFO
 *   allocated to currently held shares; correctly handles negRisk merges
 *   and partial redemptions.
 * - `currentMarkValue` = Σ snapshot.current_value_usdc. Mark-to-market of
 *   currently held shares.
 * - `grossBuyNotional` = Σ poly_trader_fills BUY size_usdc. Lifetime BUY
 *   activity — exposed for callers that want to surface it in a separate
 *   labeled column. NEVER use this as a P/L denominator; it includes
 *   capital recovered via merges/SELLs that aren't tracked as cash flows
 *   yet.
 *
 * `realizedCash` (SELL proceeds from fills) is no longer returned: see
 * module header — partial inclusion of cash flows misranks wallet classes.
 */
function aggregateWalletReturn(
  legs: readonly RawLeg[],
  rollups: ReadonlyMap<string, FillRollup>
): {
  totalBuyNotional: number;
  realizedCash: number;
  currentMarkValue: number;
  redemptionProceeds: number;
  grossBuyNotional: number;
} {
  if (legs.length === 0) {
    return {
      totalBuyNotional: 0,
      realizedCash: 0,
      currentMarkValue: 0,
      redemptionProceeds: 0,
      grossBuyNotional: 0,
    };
  }
  let rollupNotional = 0;
  let realizedCash = 0;
  for (const leg of legs) {
    const r = rollups.get(
      rollupKey(leg.walletAddress, leg.conditionId, leg.tokenId)
    );
    if (r === undefined) continue;
    rollupNotional += r.totalBuyNotional;
    realizedCash += r.realizedCash;
  }
  const currentMarkValue = legs.reduce(
    (sum, leg) => sum + leg.currentValueUsdc,
    0
  );
  const snapshotCostBasis = legs.reduce(
    (sum, leg) => sum + leg.costBasisUsdc,
    0
  );
  const redemptionProceeds = legs.reduce(
    (sum, leg) => sum + leg.redemptionProceedsUsdc,
    0
  );
  // SINGLE_BASIS_SNAPSHOT_COST: totalBuyNotional is Σ snapshot.cost_basis
  // on currently held shares only (Polymarket vendor-FIFO; post-merge,
  // post-redemption). Earlier `max(rollupNotional, snapshotCostBasis)`
  // policy inflated market-maker entries 10× — every BUY fill counted,
  // even on shares merged back to USDC via NegRiskAdapter seconds later
  // (swisstony's canonical $36k rollup vs $3,200 snapshot on a single
  // market). Rollup BUY remains exposed as `grossBuyNotional` for any
  // caller that wants lifetime-volume visibility, but never as the
  // P/L denominator.
  return {
    totalBuyNotional: snapshotCostBasis,
    realizedCash,
    currentMarkValue,
    redemptionProceeds,
    grossBuyNotional: rollupNotional,
  };
}

// Per-condition: pivot one row per (wallet) with primary + optional hedge legs.
// Hedge classification: when a wallet holds two legs of one condition, the
// smaller cost-basis leg is the hedge; the other is primary. Singletons go to
// primary with hedge=null.
function pivotParticipants(
  legs: readonly RawLeg[]
): WalletExecutionMarketParticipantRow[] {
  const byWallet = new Map<string, RawLeg[]>();
  for (const leg of legs) {
    const key = leg.walletAddress;
    const list = byWallet.get(key) ?? [];
    list.push(leg);
    byWallet.set(key, list);
  }

  const rows: WalletExecutionMarketParticipantRow[] = [];
  for (const [walletAddress, walletLegs] of byWallet.entries()) {
    const primaryLeg = pickPrimary(walletLegs);
    // Map guarantees ≥1 leg per entry; null is unreachable but the lint rule
    // forbids non-null assertions.
    if (primaryLeg === null) continue;
    // Polymarket binary markets are the v0 norm; this still handles N≥3
    // (multi-outcome markets, or stale active=true rows) by taking the next
    // largest cost-basis leg as hedge so we never silently drop exposure.
    const hedgeLeg =
      walletLegs.length >= 2 ? pickHedge(walletLegs, primaryLeg) : null;
    const anchor = primaryLeg;

    const primary = toContractLeg(primaryLeg);
    const hedge = hedgeLeg ? toContractLeg(hedgeLeg) : null;

    const lastObservedAt =
      [primaryLeg.lastObservedAt, hedgeLeg?.lastObservedAt ?? null]
        .filter((value): value is string => value !== null)
        .sort()
        .pop() ?? null;

    rows.push({
      side: anchor.side,
      source: anchor.source,
      label: anchor.label,
      walletAddress,
      conditionId: anchor.conditionId,
      primary,
      hedge,
      net: {
        currentValueUsdc: roundMoney(
          (primary?.currentValueUsdc ?? 0) + (hedge?.currentValueUsdc ?? 0)
        ),
        costBasisUsdc: roundMoney(
          (primary?.costBasisUsdc ?? 0) + (hedge?.costBasisUsdc ?? 0)
        ),
        pnlUsdc: roundMoney((primary?.pnlUsdc ?? 0) + (hedge?.pnlUsdc ?? 0)),
      },
      lastObservedAt,
    });
  }

  return rows.sort(compareParticipantRow);
}

function toContractLeg(leg: RawLeg): WalletExecutionMarketLeg {
  return {
    tokenId: leg.tokenId,
    outcome: leg.outcome,
    shares: leg.shares,
    currentValueUsdc: roundMoney(leg.currentValueUsdc),
    costBasisUsdc: roundMoney(leg.costBasisUsdc),
    vwap: leg.vwap,
    pnlUsdc: roundMoney(leg.pnlUsdc),
    lifecycle: leg.lifecycle,
  };
}

function pickPrimary(legs: readonly RawLeg[]): RawLeg | null {
  // Larger cost-basis leg is primary; deterministic tiebreak by tokenId.
  return (
    [...legs].sort((left, right) =>
      left.costBasisUsdc === right.costBasisUsdc
        ? right.tokenId.localeCompare(left.tokenId)
        : right.costBasisUsdc - left.costBasisUsdc
    )[0] ?? null
  );
}

function pickHedge(legs: readonly RawLeg[], primary: RawLeg): RawLeg | null {
  // Next-largest cost-basis leg becomes hedge. Deterministic tiebreak by
  // tokenId so re-renders are stable when two non-primary legs tie.
  const others = [...legs]
    .filter((leg) => leg.tokenId !== primary.tokenId)
    .sort((left, right) =>
      left.costBasisUsdc === right.costBasisUsdc
        ? right.tokenId.localeCompare(left.tokenId)
        : right.costBasisUsdc - left.costBasisUsdc
    );
  return others[0] ?? null;
}

function pickAnchor(legs: readonly RawLeg[]): RawLeg | null {
  return legs.find((leg) => leg.side === "our_wallet") ?? legs[0] ?? null;
}

function sumValue(legs: readonly RawLeg[]): number {
  return legs.reduce((sum, leg) => sum + leg.currentValueUsdc, 0);
}

function sumAvailableMoney(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value === null)) {
    return null;
  }
  return roundMoney(
    (values as readonly number[]).reduce((sum, value) => sum + value, 0)
  );
}

/** @internal — exported for the rollup parity tests only. */
export function rollupKey(
  walletAddress: string,
  conditionId: string,
  tokenId: string
): string {
  return `${canonicalIdentity(walletAddress)}:${canonicalIdentity(conditionId)}:${tokenId}`;
}

export function canonicalIdentity(value: string): string {
  return value.toLowerCase();
}

/**
 * Aggregate `(totalBuyNotional, realizedCash, netShares, marketOutcome)`
 * per `(wallet, condition, token)`, joined to `poly_trader_wallets` so
 * callers can supply wallet addresses (any casing; stored lowercase)
 * without needing trader-wallet UUIDs, and LEFT-JOINed to
 * `poly_market_outcomes` so each rollup carries its winner/loser/unknown
 * classification.
 *
 * Rollup-backed since the dashboard floor audit (wave C): previously a
 * condition-scoped GROUP BY over raw `poly_trader_fills` for our wallet ∪
 * every target wallet — unbounded in lifetime fills per condition. Now sums
 * `poly_trader_fill_rollups_daily` day-rows + the not-yet-rolled fill tail
 * via `windowedFillFlowsSelect(EPOCH, conditionIds)`; READERS_ADD_THE_TAIL
 * keeps the output exactly equal to the legacy scan in every rollup state
 * (parity: fill-rollup-read-parity component suite vs the preserved
 * live-scan oracle).
 *
 * Per-token (not per-condition) is required because CTF redemption pays
 * the winning token at $1/share while the losing token pays $0;
 * `computeRealizedPnl` reads `(marketOutcome, netShares)` per leg.
 *
 * Bounded SQL aggregation per data-research skill — V8 hydrates one row
 * per (wallet, condition, token), never raw fills.
 *
 * @internal — exported for the rollup parity tests only.
 */
export async function readFillRollups(params: {
  db: Db;
  conditions: readonly string[];
  walletAddresses: readonly string[];
  /** Optional dashboard bound: hydrate only already-selected participant legs. */
  positionKeys?: readonly {
    walletAddress: string;
    conditionId: string;
    tokenId: string;
  }[];
}): Promise<Map<string, FillRollup>> {
  if (params.conditions.length === 0 || params.walletAddresses.length === 0) {
    return new Map();
  }
  const walletList = sql.join(
    [...new Set(params.walletAddresses.map((w) => w.toLowerCase()))].map(
      (w) => sql`${w}`
    ),
    sql`, `
  );
  const walletRows = (await params.db.execute(sql`
    SELECT w.id, lower(w.wallet_address) AS wallet_address
    FROM poly_trader_wallets w
    WHERE lower(w.wallet_address) IN (${walletList})
    ORDER BY lower(w.wallet_address), w.updated_at DESC, w.created_at DESC, w.id
  `)) as unknown as ReadonlyArray<{
    id: string | null;
    wallet_address: string | null;
  }>;
  const walletIds = walletRows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (walletIds.length === 0) return new Map();
  if (params.positionKeys?.length === 0) return new Map();
  const walletIdsByCanonicalAddress = new Map<string, string[]>();
  for (const row of walletRows) {
    if (
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      typeof row.wallet_address !== "string" ||
      row.wallet_address.length === 0
    ) {
      continue;
    }
    const address = canonicalIdentity(row.wallet_address);
    const ids = walletIdsByCanonicalAddress.get(address) ?? [];
    ids.push(row.id);
    walletIdsByCanonicalAddress.set(address, ids);
  }
  const physicalPositionKeys = params.positionKeys?.flatMap((key) =>
    (
      walletIdsByCanonicalAddress.get(canonicalIdentity(key.walletAddress)) ??
      []
    ).map((traderWalletId) => ({
        traderWalletId,
        conditionId: canonicalIdentity(key.conditionId),
        tokenId: key.tokenId,
    }))
  );
  const selectedKeyRows = params.positionKeys
    ? sql.join(
        params.positionKeys.map(
          (key) =>
            sql`(${canonicalIdentity(key.walletAddress)}, ${canonicalIdentity(key.conditionId)}, ${key.tokenId})`
        ),
        sql`, `
      )
    : null;
  const flows = windowedFillFlowsSelect({
    walletIds,
    windowStartIso: EPOCH_ISO,
    conditionIds: params.conditions,
    conditionIdentity: "case_insensitive",
    ...(physicalPositionKeys ? { positionKeys: physicalPositionKeys } : {}),
  });
  const rows = (await params.db.execute(sql`
    WITH normalized_flows AS (
      SELECT
        lower(w.wallet_address) AS wallet_address,
        lower(fl.condition_id) AS condition_id,
        fl.token_id,
        SUM(fl.buy_usdc)::numeric AS total_buy_notional,
        SUM(fl.sell_usdc)::numeric AS realized_cash,
        SUM(fl.buy_shares - fl.sell_shares)::numeric AS net_shares
      FROM (${flows}) fl
      JOIN poly_trader_wallets w ON w.id = fl.trader_wallet_id
      GROUP BY lower(w.wallet_address), lower(fl.condition_id), fl.token_id
    )
    SELECT
      fl.wallet_address,
      fl.condition_id,
      fl.token_id,
      fl.total_buy_notional,
      fl.realized_cash,
      fl.net_shares,
      pmo.outcome AS market_outcome
    FROM normalized_flows fl
    ${
      selectedKeyRows === null
      ? sql``
      : sql`JOIN (
            SELECT DISTINCT wallet_address, condition_id, token_id
            FROM (VALUES ${selectedKeyRows}) AS requested_keys(wallet_address, condition_id, token_id)
          ) AS selected_keys
          ON selected_keys.wallet_address = fl.wallet_address
         AND selected_keys.condition_id = fl.condition_id
         AND selected_keys.token_id = fl.token_id`
    }
    LEFT JOIN LATERAL (
      SELECT candidate.outcome
      FROM poly_market_outcomes candidate
      WHERE lower(candidate.condition_id) = fl.condition_id
        AND candidate.token_id = fl.token_id
      ORDER BY candidate.updated_at DESC, candidate.condition_id
      LIMIT 1
    ) pmo ON TRUE
  `)) as unknown as ReadonlyArray<{
    wallet_address: string | null;
    condition_id: string | null;
    token_id: string | null;
    total_buy_notional: string | number | null;
    realized_cash: string | number | null;
    net_shares: string | number | null;
    market_outcome: string | null;
  }>;
  const out = new Map<string, FillRollup>();
  for (const row of rows) {
    if (
      row.wallet_address === null ||
      row.condition_id === null ||
      row.token_id === null
    ) {
      continue;
    }
    out.set(rollupKey(row.wallet_address, row.condition_id, row.token_id), {
      totalBuyNotional: toNumber(row.total_buy_notional),
      realizedCash: toNumber(row.realized_cash),
      netShares: toNumber(row.net_shares),
      marketOutcome: normalizeOutcome(row.market_outcome),
    });
  }
  return out;
}

function normalizeOutcome(value: string | null): MarketOutcome {
  if (value === "winner" || value === "loser" || value === "unknown") {
    return value;
  }
  return null;
}

function compareParticipantRow(
  left: WalletExecutionMarketParticipantRow,
  right: WalletExecutionMarketParticipantRow
): number {
  if (left.side !== right.side) return left.side === "our_wallet" ? -1 : 1;
  return (
    right.net.currentValueUsdc - left.net.currentValueUsdc ||
    left.label.localeCompare(right.label) ||
    left.walletAddress.localeCompare(right.walletAddress)
  );
}

function compareLine(
  left: WalletExecutionMarketGroup["lines"][number],
  right: WalletExecutionMarketGroup["lines"][number]
): number {
  return (
    right.ourValueUsdc - left.ourValueUsdc ||
    (right.targetValueUsdc ?? -1) - (left.targetValueUsdc ?? -1) ||
    left.marketTitle.localeCompare(right.marketTitle)
  );
}

function costBasisFromExecutionPosition(
  position: WalletExecutionPosition
): number {
  return roundMoney(Math.max(0, position.currentValue - position.pnlUsd));
}

function weightedVwap(legs: readonly RawLeg[]): number | null {
  const withVwap = legs.filter((leg) => leg.vwap !== null && leg.shares > 0);
  const shares = withVwap.reduce((sum, leg) => sum + leg.shares, 0);
  if (shares <= 0) return null;
  return roundPrice(
    withVwap.reduce((sum, leg) => sum + (leg.vwap ?? 0) * leg.shares, 0) /
      shares
  );
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNonnegativeInteger(
  value: string | number | null | undefined
): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function unavailableCoverageLeaf(): WalletDashboardComparisonCoverageLeaf {
  return {
    eligible: null,
    comparable: null,
    dropped: null,
    sampled: null,
    complete: false,
    reasons: ["source_unavailable"],
  };
}

function nullableNumber(
  value: string | number | null | undefined
): number | null {
  const parsed = toNumber(value);
  return parsed > 0 ? parsed : null;
}

function positionVwap(
  costBasisUsdc: number,
  shares: number,
  fallback: number | null
): number | null {
  if (costBasisUsdc > 0 && shares > 0) {
    return roundPrice(costBasisUsdc / shares);
  }
  return fallback;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

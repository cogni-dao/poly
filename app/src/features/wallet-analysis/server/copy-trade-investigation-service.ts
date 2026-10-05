// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/copy-trade-investigation-service`
 * Purpose: Produce one bounded, account-scoped copy-trade market snapshot and its evidence tape.
 * Scope: Saved Postgres facts only. Caller supplies an app-role transaction after capability resolution.
 * Invariants:
 *   - ACCOUNT_ASSOCIATION_REQUIRED: no public market/target facts leave the service until the condition
 *     is linked to this account by a fill, decision, or active target position.
 *   - SQL_BOUNDED: raw fills/decisions are never hydrated by the summary path; evidence is keyset-paged.
 *   - SNAPSHOT_CUTOFF: every read is bounded by database `captured_at`, including later evidence pages.
 *   - NO_UPSTREAM_OR_SERVICE_ROLE: this module only uses the injected app-role transaction.
 * Side-effects: IO (read-only Postgres statements)
 * Links: story.5003, packages/poly-node-contracts/src/poly.research-copy-trade-investigation.v1.contract.ts
 * @public
 */

import type {
  PolyResearchCopyTradeInvestigationEvidenceQuery,
  PolyResearchCopyTradeInvestigationEvidenceResponse,
  PolyResearchCopyTradeInvestigationQuery,
  PolyResearchCopyTradeInvestigationResponse,
} from "@cogni/poly-node-contracts";
import {
  POLY_COPY_TRADE_INVESTIGATION_MAX_ACCOUNT_LEGS,
  POLY_COPY_TRADE_INVESTIGATION_MAX_LEGS_PER_PARTICIPANT,
  POLY_COPY_TRADE_INVESTIGATION_MAX_OUTCOMES,
  POLY_COPY_TRADE_INVESTIGATION_MAX_TARGETS,
} from "@cogni/poly-node-contracts";
import { type SQL, sql } from "drizzle-orm";

type Db = { execute(query: SQL): Promise<unknown> };

const STATEMENT_TIMEOUT_MS = 8_000;
const POSITION_FRESHNESS_MS = 10 * 60_000;
const MARKET_FRESHNESS_MS = 60 * 60_000;
const POLYMARKET_LEDGER_PREFIX = "prediction-market:polymarket:";

type AssociationRow = {
  has_fill: boolean | null;
  has_decision: boolean | null;
  has_target_position: boolean | null;
};

type MarketRow = {
  event_title: string | null;
  event_slug: string | null;
  market_title: string | null;
  market_slug: string | null;
  end_date: Date | string | null;
  fetched_at: Date | string | null;
};

type OutcomeRow = {
  token_id: string;
  label: string | null;
  outcome: "winner" | "loser" | "unknown";
  payout: string | number | null;
  resolved_at: Date | string | null;
  updated_at: Date | string;
};

type MirrorLegRow = {
  token_id: string;
  outcome: string | null;
  buy_count: string | number | null;
  sell_count: string | number | null;
  buy_shares: string | number | null;
  sell_shares: string | number | null;
  buy_usdc: string | number | null;
  sell_usdc: string | number | null;
  buy_vwap: string | number | null;
  sell_vwap: string | number | null;
  fees_usdc: string | number | null;
  mark_price: string | number | null;
  mark_observed_at: Date | string | null;
  missing_realized_rows: string | number | null;
  first_observed_at: Date | string | null;
  last_observed_at: Date | string | null;
};

type TargetLegRow = {
  target_id: string;
  wallet_address: string;
  label: string | null;
  mirror_filter_percentile: string | number;
  mirror_max_usdc_per_trade: string | number;
  sizing_policy_kind: string;
  target_range_max_usdc: string | number | null;
  mirror_max_alloc_per_condition_usdc: string | number | null;
  mirror_activated_at: Date | string;
  disabled_at: Date | string | null;
  token_id: string | null;
  outcome: string | null;
  shares: string | number | null;
  cost_basis_usdc: string | number | null;
  current_value_usdc: string | number | null;
  avg_price: string | number | null;
  active: boolean | null;
  observed_at: Date | string | null;
  target_rank: string | number;
  target_count: string | number;
};

type FillAggregateRow = {
  count: string | number | null;
  placed_count: string | number | null;
  pending_count: string | number | null;
  open_count: string | number | null;
  filled_count: string | number | null;
  partial_count: string | number | null;
  canceled_count: string | number | null;
  error_count: string | number | null;
  first_observed_at: Date | string | null;
  last_observed_at: Date | string | null;
};

type DecisionAggregateRow = {
  count: string | number | null;
  placed_count: string | number | null;
  skipped_count: string | number | null;
  error_count: string | number | null;
  first_decided_at: Date | string | null;
  last_decided_at: Date | string | null;
};

type ReasonRow = { reason: string | null; count: string | number | null };

type FillEvidenceRow = {
  evidence_id: string;
  occurred_at: Date | string;
  target_id: string;
  target_wallet: string | null;
  fill_id: string;
  token_id: string | null;
  side: string | null;
  status: string;
  price: string | number | null;
  shares: string | number | null;
  fees_usdc: string | number | null;
  intent_size_usdc: string | number | null;
  filled_size_usdc: string | number | null;
  position_lifecycle: string | null;
};

type DecisionEvidenceRow = {
  evidence_id: string;
  occurred_at: Date | string;
  target_id: string;
  target_wallet: string | null;
  fill_id: string;
  outcome: "placed" | "skipped" | "error";
  reason: string | null;
  token_id: string | null;
  side: string | null;
  limit_price: string | number | null;
  size_usdc: string | number | null;
  position_branch: string | null;
  target_position_usdc: string | number | null;
  target_hedge_ratio: string | number | null;
};

export type InvestigationEvidenceCursor = {
  occurredAt: string;
  evidenceId: string;
  targetId?: string;
  fillId?: string;
};

export async function getCopyTradeInvestigationSummary(
  db: Db,
  query: PolyResearchCopyTradeInvestigationQuery
): Promise<PolyResearchCopyTradeInvestigationResponse | null> {
  await db.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
  const clock = rowsOf<{ captured_at: Date | string }>(
    await db.execute(sql`SELECT clock_timestamp() AS captured_at`)
  );
  const capturedAt = toIso(clock[0]?.captured_at) ?? new Date().toISOString();
  const { marketId, conditionId } = investigationMarketIdentity(
    query.condition_id
  );
  const modeFilter = modeSql(query.mode, "f.mode");
  const decisionModeFilter = modeSql(query.mode, "d.mode");
  const fillWindow = windowSql(query, "f.observed_at");
  const decisionWindow = windowSql(query, "d.decided_at");

  const associationRows = rowsOf<AssociationRow>(await db.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM poly_copy_trade_fills f
        WHERE f.billing_account_id = ${query.billing_account_id}
          AND f.market_id = ${marketId}
          AND ${modeFilter}
          AND ${fillWindow}
          AND f.observed_at <= ${capturedAt}::timestamptz
      ) AS has_fill,
      EXISTS (
        SELECT 1 FROM poly_copy_trade_decisions d
        WHERE d.billing_account_id = ${query.billing_account_id}
          AND d.intent->>'market_id' = ${marketId}
          AND ${decisionModeFilter}
          AND ${decisionWindow}
          AND d.decided_at <= ${capturedAt}::timestamptz
      ) AS has_decision,
      EXISTS (
        SELECT 1
        FROM poly_copy_trade_targets t
        JOIN poly_trader_wallets w
          ON lower(w.wallet_address) = lower(t.target_wallet)
        WHERE t.billing_account_id = ${query.billing_account_id}
          AND t.disabled_at IS NULL
          AND w.disabled_at IS NULL
          AND EXISTS (
            SELECT 1 FROM poly_trader_position_snapshots s
            WHERE s.trader_wallet_id = w.id
              AND s.condition_id = ${conditionId}
              AND s.captured_at <= ${capturedAt}::timestamptz
          )
      ) AS has_target_position
  `));
  const association = associationRows[0];
  if (
    !association ||
    !(
      association.has_fill ||
      association.has_decision ||
      association.has_target_position
    )
  ) {
    return null;
  }

  const marketRows = rowsOf<MarketRow>(await db.execute(sql`
    SELECT event_title, event_slug, market_title, market_slug, end_date, fetched_at
    FROM poly_market_metadata
    WHERE condition_id = ${conditionId}
      AND fetched_at <= ${capturedAt}::timestamptz
    LIMIT 1
  `));
  const rawOutcomeRows = rowsOf<OutcomeRow>(await db.execute(sql`
    SELECT
      o.token_id,
      COALESCE(NULLIF(o.raw->>'label', ''), NULLIF(o.raw->>'outcome', '')) AS label,
      o.outcome,
      o.payout,
      o.resolved_at,
      o.updated_at
    FROM poly_market_outcomes o
    WHERE o.condition_id = ${conditionId}
      AND o.updated_at <= ${capturedAt}::timestamptz
    ORDER BY o.token_id
    LIMIT ${POLY_COPY_TRADE_INVESTIGATION_MAX_OUTCOMES + 1}
  `));
  const outcomesTruncated = rawOutcomeRows.length > POLY_COPY_TRADE_INVESTIGATION_MAX_OUTCOMES;
  const outcomeRows = rawOutcomeRows.slice(0, POLY_COPY_TRADE_INVESTIGATION_MAX_OUTCOMES);
  const market = marketRows[0];

  const rawMirrorRows = rowsOf<MirrorLegRow>(await db.execute(sql`
    WITH execution_legs AS (
    SELECT
      COALESCE(NULLIF(f.attributes->>'token_id', ''), 'unknown') AS token_id,
      MAX(NULLIF(f.attributes->>'outcome', '')) AS outcome,
      COUNT(*) FILTER (WHERE f.attributes->>'side' = 'BUY')::int AS buy_count,
      COUNT(*) FILTER (WHERE f.attributes->>'side' = 'SELL')::int AS sell_count,
      COALESCE(SUM(CASE WHEN f.attributes->>'side' = 'BUY' THEN f.shares ELSE 0 END), 0)::text AS buy_shares,
      COALESCE(SUM(CASE WHEN f.attributes->>'side' = 'SELL' THEN f.shares ELSE 0 END), 0)::text AS sell_shares,
      COALESCE(SUM(CASE WHEN f.attributes->>'side' = 'BUY' THEN f.price * f.shares ELSE 0 END), 0)::text AS buy_usdc,
      COALESCE(SUM(CASE WHEN f.attributes->>'side' = 'SELL' THEN f.price * f.shares ELSE 0 END), 0)::text AS sell_usdc,
      CASE WHEN SUM(CASE WHEN f.attributes->>'side' = 'BUY' THEN f.shares ELSE 0 END) > 0
        THEN (SUM(CASE WHEN f.attributes->>'side' = 'BUY' THEN f.price * f.shares ELSE 0 END)
          / SUM(CASE WHEN f.attributes->>'side' = 'BUY' THEN f.shares ELSE 0 END))::text
        ELSE NULL END AS buy_vwap,
      CASE WHEN SUM(CASE WHEN f.attributes->>'side' = 'SELL' THEN f.shares ELSE 0 END) > 0
        THEN (SUM(CASE WHEN f.attributes->>'side' = 'SELL' THEN f.price * f.shares ELSE 0 END)
          / SUM(CASE WHEN f.attributes->>'side' = 'SELL' THEN f.shares ELSE 0 END))::text
        ELSE NULL END AS sell_vwap,
      COALESCE(SUM(f.fees_usdc), 0)::text AS fees_usdc,
      COUNT(*) FILTER (
        WHERE f.status IN ('filled', 'partial') AND (f.price IS NULL OR f.shares IS NULL)
      )::int AS missing_realized_rows,
      MIN(f.observed_at) AS first_observed_at,
      MAX(f.observed_at) AS last_observed_at
    FROM poly_copy_trade_fills f
    WHERE f.billing_account_id = ${query.billing_account_id}
      AND f.market_id = ${marketId}
      AND ${modeFilter}
      AND ${fillWindow}
      AND f.observed_at <= ${capturedAt}::timestamptz
    GROUP BY COALESCE(NULLIF(f.attributes->>'token_id', ''), 'unknown')
    )
    SELECT
      legs.*,
      COALESCE(price.price, outcome.payout)::text AS mark_price,
      COALESCE(price.ts, outcome.resolved_at) AS mark_observed_at
    FROM execution_legs legs
    LEFT JOIN LATERAL (
      SELECT p.price, p.ts
      FROM poly_market_price_history p
      WHERE p.asset = legs.token_id
        AND p.ts <= ${capturedAt}::timestamptz
      ORDER BY p.ts DESC
      LIMIT 1
    ) price ON TRUE
    LEFT JOIN poly_market_outcomes outcome
      ON outcome.condition_id = ${conditionId}
      AND outcome.token_id = legs.token_id
      AND outcome.updated_at <= ${capturedAt}::timestamptz
    ORDER BY legs.buy_usdc::numeric DESC, legs.token_id
    LIMIT ${POLY_COPY_TRADE_INVESTIGATION_MAX_ACCOUNT_LEGS + 1}
  `));
  const accountPositionTruncated =
    rawMirrorRows.length > POLY_COPY_TRADE_INVESTIGATION_MAX_ACCOUNT_LEGS;
  const mirrorRows = rawMirrorRows.slice(
    0,
    POLY_COPY_TRADE_INVESTIGATION_MAX_ACCOUNT_LEGS
  );

  const rawTargetRows = rowsOf<TargetLegRow>(await db.execute(sql`
    WITH associated_wallets AS (
      SELECT DISTINCT lower(f.attributes->>'target_wallet') AS wallet_address
      FROM poly_copy_trade_fills f
      WHERE f.billing_account_id = ${query.billing_account_id}
        AND f.market_id = ${marketId}
        AND ${modeFilter}
        AND ${fillWindow}
        AND f.observed_at <= ${capturedAt}::timestamptz
        AND f.attributes->>'target_wallet' IS NOT NULL
      UNION
      SELECT DISTINCT lower(d.intent->>'target_wallet') AS wallet_address
      FROM poly_copy_trade_decisions d
      WHERE d.billing_account_id = ${query.billing_account_id}
        AND d.intent->>'market_id' = ${marketId}
        AND ${decisionModeFilter}
        AND ${decisionWindow}
        AND d.decided_at <= ${capturedAt}::timestamptz
        AND d.intent->>'target_wallet' IS NOT NULL
    ), active_targets AS (
      SELECT
        t.id,
        lower(t.target_wallet) AS wallet_address,
        t.mirror_filter_percentile,
        t.mirror_max_usdc_per_trade,
        t.sizing_policy_kind,
        t.target_range_max_usdc,
        t.mirror_max_alloc_per_condition_usdc,
        t.mirror_activated_at,
        t.disabled_at,
        w.id AS trader_wallet_id,
        NULLIF(w.label, '') AS label
      FROM poly_copy_trade_targets t
      LEFT JOIN poly_trader_wallets w
        ON lower(w.wallet_address) = lower(t.target_wallet)
        AND w.disabled_at IS NULL
      WHERE t.billing_account_id = ${query.billing_account_id}
        AND t.disabled_at IS NULL
        AND (
          lower(t.target_wallet) IN (SELECT wallet_address FROM associated_wallets)
          OR EXISTS (
            SELECT 1 FROM poly_trader_position_snapshots ps
            WHERE ps.trader_wallet_id = w.id
              AND ps.condition_id = ${conditionId}
              AND ps.captured_at <= ${capturedAt}::timestamptz
          )
        )
    ), latest AS (
      SELECT DISTINCT ON (s.trader_wallet_id, s.token_id)
        s.trader_wallet_id,
        s.token_id,
        COALESCE(NULLIF(s.raw->>'outcome', ''), NULLIF(o.raw->>'label', '')) AS outcome,
        s.shares,
        s.cost_basis_usdc,
        CASE
          WHEN cp.active IS TRUE AND cp.last_observed_at <= ${capturedAt}::timestamptz
            THEN cp.current_value_usdc
          ELSE s.current_value_usdc
        END AS current_value_usdc,
        s.avg_price,
        COALESCE(cp.active, s.current_value_usdc > 0) AS active,
        CASE
          WHEN cp.active IS TRUE AND cp.last_observed_at <= ${capturedAt}::timestamptz
            THEN cp.last_observed_at
          ELSE s.captured_at
        END AS observed_at
      FROM poly_trader_position_snapshots s
      LEFT JOIN poly_trader_current_positions cp
        ON cp.trader_wallet_id = s.trader_wallet_id
        AND cp.condition_id = s.condition_id
        AND cp.token_id = s.token_id
      LEFT JOIN poly_market_outcomes o
        ON o.condition_id = s.condition_id
        AND o.token_id = s.token_id
      WHERE s.condition_id = ${conditionId}
        AND s.captured_at <= ${capturedAt}::timestamptz
        AND s.trader_wallet_id IN (
          SELECT trader_wallet_id FROM active_targets WHERE trader_wallet_id IS NOT NULL
        )
      ORDER BY s.trader_wallet_id, s.token_id, s.captured_at DESC
    ), ranked_targets AS (
      SELECT
        a.*,
        DENSE_RANK() OVER (ORDER BY a.wallet_address) AS target_rank,
        COUNT(*) OVER () AS target_count
      FROM active_targets a
    ), ranked_legs AS (
      SELECT
        l.*,
        ROW_NUMBER() OVER (
          PARTITION BY l.trader_wallet_id
          ORDER BY l.cost_basis_usdc DESC, l.token_id
        ) AS leg_rank
      FROM latest l
    )
    SELECT
      a.id AS target_id,
      a.wallet_address,
      a.label,
      a.mirror_filter_percentile,
      a.mirror_max_usdc_per_trade,
      a.sizing_policy_kind,
      a.target_range_max_usdc,
      a.mirror_max_alloc_per_condition_usdc,
      a.mirror_activated_at,
      a.disabled_at,
      l.token_id,
      l.outcome,
      l.shares,
      l.cost_basis_usdc,
      l.current_value_usdc,
      l.avg_price,
      l.active,
      l.observed_at,
      a.target_rank,
      a.target_count
    FROM ranked_targets a
    LEFT JOIN ranked_legs l
      ON l.trader_wallet_id = a.trader_wallet_id
      AND l.leg_rank <= ${POLY_COPY_TRADE_INVESTIGATION_MAX_LEGS_PER_PARTICIPANT}
    WHERE a.target_rank <= ${POLY_COPY_TRADE_INVESTIGATION_MAX_TARGETS}
    ORDER BY a.target_rank, l.cost_basis_usdc DESC NULLS LAST, l.token_id
  `));

  const fillAggregate = rowsOf<FillAggregateRow>(await db.execute(sql`
    SELECT
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE f.order_id IS NOT NULL)::int AS placed_count,
      COUNT(*) FILTER (WHERE f.status = 'pending')::int AS pending_count,
      COUNT(*) FILTER (WHERE f.status = 'open')::int AS open_count,
      COUNT(*) FILTER (WHERE f.status = 'filled')::int AS filled_count,
      COUNT(*) FILTER (WHERE f.status = 'partial')::int AS partial_count,
      COUNT(*) FILTER (WHERE f.status = 'canceled')::int AS canceled_count,
      COUNT(*) FILTER (WHERE f.status = 'error')::int AS error_count,
      MIN(f.observed_at) AS first_observed_at,
      MAX(f.observed_at) AS last_observed_at
    FROM poly_copy_trade_fills f
    WHERE f.billing_account_id = ${query.billing_account_id}
      AND f.market_id = ${marketId}
      AND ${modeFilter}
      AND ${fillWindow}
      AND f.observed_at <= ${capturedAt}::timestamptz
  `))[0];
  const decisionAggregate = rowsOf<DecisionAggregateRow>(await db.execute(sql`
    SELECT
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE d.outcome = 'placed')::int AS placed_count,
      COUNT(*) FILTER (WHERE d.outcome = 'skipped')::int AS skipped_count,
      COUNT(*) FILTER (WHERE d.outcome = 'error')::int AS error_count,
      MIN(d.decided_at) AS first_decided_at,
      MAX(d.decided_at) AS last_decided_at
    FROM poly_copy_trade_decisions d
    WHERE d.billing_account_id = ${query.billing_account_id}
      AND d.intent->>'market_id' = ${marketId}
      AND ${decisionModeFilter}
      AND ${decisionWindow}
      AND d.decided_at <= ${capturedAt}::timestamptz
  `))[0];
  const reasonRows = rowsOf<ReasonRow>(await db.execute(sql`
    SELECT COALESCE(NULLIF(d.reason, ''), d.outcome) AS reason, COUNT(*)::int AS count
    FROM poly_copy_trade_decisions d
    WHERE d.billing_account_id = ${query.billing_account_id}
      AND d.intent->>'market_id' = ${marketId}
      AND ${decisionModeFilter}
      AND ${decisionWindow}
      AND d.decided_at <= ${capturedAt}::timestamptz
    GROUP BY COALESCE(NULLIF(d.reason, ''), d.outcome)
    ORDER BY COUNT(*) DESC, reason
    LIMIT 25
  `));

  const targets = groupTargets(rawTargetRows);
  const targetCount = int(rawTargetRows[0]?.target_count);
  const targetsTruncated = targetCount > targets.length;
  const mirrorLegs = mirrorRows.map((row) => {
    const buyShares = number(row.buy_shares);
    const sellShares = number(row.sell_shares);
    const netShares = round(buyShares - sellShares);
    const markPrice = nullableNumber(row.mark_price);
    return {
      token_id: row.token_id,
      outcome: row.outcome,
      buy_count: int(row.buy_count),
      sell_count: int(row.sell_count),
      buy_shares: buyShares,
      sell_shares: sellShares,
      net_shares: netShares,
      buy_usdc: number(row.buy_usdc),
      sell_usdc: number(row.sell_usdc),
      buy_vwap: nullableNumber(row.buy_vwap),
      sell_vwap: nullableNumber(row.sell_vwap),
      fees_usdc: number(row.fees_usdc),
      mark_price: markPrice,
      marked_value_usdc:
        markPrice === null ? null : round(Math.max(0, netShares) * markPrice),
      mark_observed_at: toIso(row.mark_observed_at),
      missing_realized_rows: int(row.missing_realized_rows),
      first_observed_at: toIso(row.first_observed_at),
      last_observed_at: toIso(row.last_observed_at),
    };
  });
  const ledgerObservedAt = toIso(fillAggregate?.last_observed_at);
  const targetObservedAt = latestIso(
    targets.flatMap((target) => target.legs.map((leg) => leg.observed_at))
  );
  const marketObservedAt = toIso(market?.fetched_at);
  const outcomesObservedAt = latestIso(outcomeRows.map((row) => toIso(row.updated_at)));
  const markObservedAt = latestIso(mirrorLegs.map((leg) => leg.mark_observed_at));
  const marksComplete = mirrorLegs.every(
    (leg) => leg.net_shares <= 0 || leg.mark_price !== null
  );
  const facts = [
    fact(
      "mirror_ledger",
      ledgerObservedAt,
      capturedAt,
      POSITION_FRESHNESS_MS,
      !accountPositionTruncated
    ),
    fact("market_prices", markObservedAt, capturedAt, MARKET_FRESHNESS_MS, marksComplete),
    fact("target_positions", targetObservedAt, capturedAt, POSITION_FRESHNESS_MS, !targetsTruncated),
    fact("market_metadata", marketObservedAt, capturedAt, MARKET_FRESHNESS_MS, market !== undefined),
    fact("market_outcomes", outcomesObservedAt, capturedAt, MARKET_FRESHNESS_MS, !outcomesTruncated),
  ] as PolyResearchCopyTradeInvestigationResponse["completeness"]["facts"];
  const associationSources: PolyResearchCopyTradeInvestigationResponse["association_sources"] = [];
  if (association.has_fill) associationSources.push("fill");
  if (association.has_decision) associationSources.push("decision");
  if (association.has_target_position) associationSources.push("target_position");

  return {
    billing_account_id: query.billing_account_id,
    condition_id: conditionId,
    mode: query.mode,
    since: query.since ?? null,
    until: query.until ?? null,
    captured_at: capturedAt,
    association_sources: associationSources,
    market: {
      condition_id: conditionId,
      event_title: market?.event_title ?? null,
      event_slug: market?.event_slug ?? null,
      market_title: market?.market_title ?? null,
      market_slug: market?.market_slug ?? null,
      end_date: toIso(market?.end_date),
      metadata_fetched_at: marketObservedAt,
      outcomes: outcomeRows.map((row) => ({
        token_id: row.token_id,
        label: row.label,
        resolution: row.outcome,
        payout: nullableNumber(row.payout),
        resolved_at: toIso(row.resolved_at),
        updated_at: toIso(row.updated_at) ?? capturedAt,
      })),
    },
    account_position: {
      source: "mirror_execution_ledger",
      legs: mirrorLegs,
      truncated: accountPositionTruncated,
    },
    targets,
    aggregates: {
      fills: {
        count: int(fillAggregate?.count),
        placed_count: int(fillAggregate?.placed_count),
        pending_count: int(fillAggregate?.pending_count),
        open_count: int(fillAggregate?.open_count),
        filled_count: int(fillAggregate?.filled_count),
        partial_count: int(fillAggregate?.partial_count),
        canceled_count: int(fillAggregate?.canceled_count),
        error_count: int(fillAggregate?.error_count),
        first_observed_at: toIso(fillAggregate?.first_observed_at),
        last_observed_at: ledgerObservedAt,
      },
      decisions: {
        count: int(decisionAggregate?.count),
        placed_count: int(decisionAggregate?.placed_count),
        skipped_count: int(decisionAggregate?.skipped_count),
        error_count: int(decisionAggregate?.error_count),
        first_decided_at: toIso(decisionAggregate?.first_decided_at),
        last_decided_at: toIso(decisionAggregate?.last_decided_at),
        top_reasons: reasonRows.flatMap((row) =>
          row.reason ? [{ reason: row.reason, count: int(row.count) }] : []
        ),
      },
    },
    completeness: {
      complete: facts.every((entry) => entry.complete),
      account_position_truncated: accountPositionTruncated,
      targets_truncated: targetsTruncated,
      facts,
    },
  };
}

export async function getCopyTradeInvestigationEvidence(
  db: Db,
  query: PolyResearchCopyTradeInvestigationEvidenceQuery
): Promise<PolyResearchCopyTradeInvestigationEvidenceResponse | null> {
  await db.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
  const clock = rowsOf<{ captured_at: Date | string }>(
    await db.execute(sql`SELECT clock_timestamp() AS captured_at`)
  );
  const databaseNow = toIso(clock[0]?.captured_at);
  if (
    !databaseNow ||
    Date.parse(query.captured_at) > Date.parse(databaseNow)
  ) {
    throw new InvalidInvestigationCapturedAtError();
  }
  const { marketId, conditionId } = investigationMarketIdentity(
    query.condition_id
  );
  const associationFillMode = modeSql(query.mode, "f.mode");
  const associationDecisionMode = modeSql(query.mode, "d.mode");
  const associationFillWindow = windowSql(query, "f.observed_at");
  const associationDecisionWindow = windowSql(query, "d.decided_at");
  const associated = rowsOf<{ associated: boolean | null }>(await db.execute(sql`
    SELECT (
      EXISTS (
        SELECT 1 FROM poly_copy_trade_fills f
        WHERE f.billing_account_id = ${query.billing_account_id}
          AND f.market_id = ${marketId}
          AND ${associationFillMode}
          AND ${associationFillWindow}
          AND f.observed_at <= ${query.captured_at}::timestamptz
      )
      OR EXISTS (
        SELECT 1 FROM poly_copy_trade_decisions d
        WHERE d.billing_account_id = ${query.billing_account_id}
          AND d.intent->>'market_id' = ${marketId}
          AND ${associationDecisionMode}
          AND ${associationDecisionWindow}
          AND d.decided_at <= ${query.captured_at}::timestamptz
      )
      OR EXISTS (
        SELECT 1
        FROM poly_copy_trade_targets t
        JOIN poly_trader_wallets w ON lower(w.wallet_address) = lower(t.target_wallet)
        JOIN poly_trader_position_snapshots s ON s.trader_wallet_id = w.id
        WHERE t.billing_account_id = ${query.billing_account_id}
          AND t.disabled_at IS NULL
          AND s.condition_id = ${conditionId}
          AND s.captured_at <= ${query.captured_at}::timestamptz
      )
    ) AS associated
  `))[0]?.associated;
  if (!associated) return null;

  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const rawRows =
    query.kind === "fills"
      ? rowsOf<FillEvidenceRow>(
          await db.execute(copyTradeFillEvidenceSelect(query, cursor))
        )
      : rowsOf<DecisionEvidenceRow>(
          await db.execute(copyTradeDecisionEvidenceSelect(query, cursor))
        );
  const truncated = rawRows.length > query.limit;
  const page = rawRows.slice(0, query.limit);
  const last = page.at(-1);
  const items =
    query.kind === "fills"
      ? (page as FillEvidenceRow[]).map((row) => ({
          kind: "fill" as const,
          evidence_id: row.evidence_id,
          occurred_at: toIso(row.occurred_at) ?? query.captured_at,
          target_id: row.target_id,
          target_wallet: row.target_wallet,
          fill_id: row.fill_id,
          token_id: row.token_id,
          side: orderSide(row.side),
          status: row.status,
          price: nullableNumber(row.price),
          shares: nullableNumber(row.shares),
          fees_usdc: nullableNumber(row.fees_usdc),
          intent_size_usdc: nullableNumber(row.intent_size_usdc),
          filled_size_usdc: nullableNumber(row.filled_size_usdc),
          position_lifecycle: row.position_lifecycle,
        }))
      : (page as DecisionEvidenceRow[]).map((row) => ({
          kind: "decision" as const,
          evidence_id: row.evidence_id,
          occurred_at: toIso(row.occurred_at) ?? query.captured_at,
          target_id: row.target_id,
          target_wallet: row.target_wallet,
          fill_id: row.fill_id,
          outcome: row.outcome,
          reason: row.reason,
          token_id: row.token_id,
          side: orderSide(row.side),
          limit_price: nullableNumber(row.limit_price),
          size_usdc: nullableNumber(row.size_usdc),
          position_branch: row.position_branch,
          target_position_usdc: nullableNumber(row.target_position_usdc),
          target_hedge_ratio: nullableNumber(row.target_hedge_ratio),
        }));

  return {
    billing_account_id: query.billing_account_id,
    condition_id: conditionId,
    mode: query.mode,
    kind: query.kind,
    since: query.since ?? null,
    until: query.until ?? null,
    captured_at: query.captured_at,
    limit: query.limit,
    items,
    next_cursor:
      truncated && last
        ? encodeCursor({
            occurredAt: toIso(last.occurred_at) ?? query.captured_at,
            evidenceId: last.evidence_id,
            ...(query.kind === "fills"
              ? {
                  targetId: (last as FillEvidenceRow).target_id,
                  fillId: (last as FillEvidenceRow).fill_id,
                }
              : {}),
          })
        : null,
    truncated,
  };
}

/** Exact production query exported for real-Postgres EXPLAIN proof. */
export function copyTradeFillEvidenceSelect(
  query: PolyResearchCopyTradeInvestigationEvidenceQuery,
  cursor: InvestigationEvidenceCursor | null = null
): SQL {
  const { marketId } = investigationMarketIdentity(query.condition_id);
  const modeFilter = modeSql(query.mode, "f.mode");
  const window = windowSql(query, "f.observed_at");
  return sql`
    SELECT
      f.target_id::text || ':' || f.fill_id AS evidence_id,
      f.observed_at AS occurred_at,
      f.target_id,
      NULLIF(f.attributes->>'target_wallet', '') AS target_wallet,
      f.fill_id,
      NULLIF(f.attributes->>'token_id', '') AS token_id,
      CASE WHEN f.attributes->>'side' IN ('BUY', 'SELL') THEN f.attributes->>'side' ELSE NULL END AS side,
      f.status,
      f.price,
      f.shares,
      f.fees_usdc,
      CASE WHEN f.attributes->>'size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
        THEN (f.attributes->>'size_usdc')::numeric ELSE NULL END AS intent_size_usdc,
      CASE WHEN f.attributes->>'filled_size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
        THEN (f.attributes->>'filled_size_usdc')::numeric ELSE NULL END AS filled_size_usdc,
      f.position_lifecycle
    FROM poly_copy_trade_fills f
    WHERE f.billing_account_id = ${query.billing_account_id}
      AND f.market_id = ${marketId}
      AND ${modeFilter}
      AND ${window}
      AND f.observed_at <= ${query.captured_at}::timestamptz
      AND ${fillCursorPredicate(cursor)}
    ORDER BY f.observed_at DESC, f.target_id DESC, f.fill_id DESC
    LIMIT ${query.limit + 1}
  `;
}

/** Exact production query exported for real-Postgres EXPLAIN proof. */
export function copyTradeDecisionEvidenceSelect(
  query: PolyResearchCopyTradeInvestigationEvidenceQuery,
  cursor: InvestigationEvidenceCursor | null = null
): SQL {
  const { marketId } = investigationMarketIdentity(query.condition_id);
  const modeFilter = modeSql(query.mode, "d.mode");
  const window = windowSql(query, "d.decided_at");
  return sql`
    SELECT
      d.id AS evidence_id,
      d.decided_at AS occurred_at,
      d.target_id,
      NULLIF(d.intent->>'target_wallet', '') AS target_wallet,
      d.fill_id,
      d.outcome,
      d.reason,
      NULLIF(d.intent->>'token_id', '') AS token_id,
      CASE WHEN d.intent->>'side' IN ('BUY', 'SELL') THEN d.intent->>'side' ELSE NULL END AS side,
      CASE WHEN d.intent->>'limit_price' ~ '^[0-9]+(\\.[0-9]+)?$'
        THEN (d.intent->>'limit_price')::numeric ELSE NULL END AS limit_price,
      CASE WHEN d.intent->>'size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
        THEN (d.intent->>'size_usdc')::numeric ELSE NULL END AS size_usdc,
      COALESCE(NULLIF(d.intent->>'position_branch', ''), NULLIF(d.intent->'attributes'->>'position_branch', '')) AS position_branch,
      CASE
        WHEN COALESCE(d.intent->>'target_position_usdc', d.intent->'attributes'->>'target_position_usdc') ~ '^[0-9]+(\\.[0-9]+)?$'
        THEN COALESCE(d.intent->>'target_position_usdc', d.intent->'attributes'->>'target_position_usdc')::numeric
        ELSE NULL
      END AS target_position_usdc,
      CASE
        WHEN COALESCE(d.intent->>'target_hedge_ratio', d.intent->'attributes'->>'target_hedge_ratio') ~ '^[0-9]+(\\.[0-9]+)?$'
        THEN COALESCE(d.intent->>'target_hedge_ratio', d.intent->'attributes'->>'target_hedge_ratio')::numeric
        ELSE NULL
      END AS target_hedge_ratio
    FROM poly_copy_trade_decisions d
    WHERE d.billing_account_id = ${query.billing_account_id}
      AND d.intent->>'market_id' = ${marketId}
      AND ${modeFilter}
      AND ${window}
      AND d.decided_at <= ${query.captured_at}::timestamptz
      AND ${cursorPredicate("d.decided_at", "d.id::text", cursor)}
    ORDER BY d.decided_at DESC, d.id DESC
    LIMIT ${query.limit + 1}
  `;
}

function groupTargets(
  rows: readonly TargetLegRow[]
): PolyResearchCopyTradeInvestigationResponse["targets"] {
  const grouped = new Map<
    string,
    PolyResearchCopyTradeInvestigationResponse["targets"][number]
  >();
  for (const row of rows) {
    let target = grouped.get(row.target_id);
    if (!target) {
      target = {
        target_id: row.target_id,
        wallet_address: row.wallet_address,
        label: row.label,
        active: row.disabled_at === null,
        policy: {
          kind: row.sizing_policy_kind,
          mirror_filter_percentile: int(row.mirror_filter_percentile),
          mirror_max_usdc_per_trade: number(row.mirror_max_usdc_per_trade),
          target_range_max_usdc: nullableNumber(row.target_range_max_usdc),
          mirror_max_alloc_per_condition_usdc: nullableNumber(
            row.mirror_max_alloc_per_condition_usdc
          ),
          activated_at: toIso(row.mirror_activated_at) ?? new Date(0).toISOString(),
        },
        legs: [],
      };
      grouped.set(row.target_id, target);
    }
    if (row.token_id && row.observed_at) {
      target.legs.push({
        token_id: row.token_id,
        outcome: row.outcome,
        shares: number(row.shares),
        cost_basis_usdc: number(row.cost_basis_usdc),
        current_value_usdc: number(row.current_value_usdc),
        avg_price: nullableNumber(row.avg_price),
        lifecycle: row.active ? "active" : "inactive",
        observed_at: toIso(row.observed_at) ?? new Date(0).toISOString(),
      });
    }
  }
  return [...grouped.values()];
}

function modeSql(mode: "live" | "paper" | "all", column: string): SQL {
  if (mode === "all") return sql`TRUE`;
  return sql`${sql.raw(column)} = ${mode}`;
}

function investigationMarketIdentity(value: string): {
  marketId: string;
  conditionId: string;
} {
  const conditionId = value.startsWith(POLYMARKET_LEDGER_PREFIX)
    ? value.slice(POLYMARKET_LEDGER_PREFIX.length)
    : value;
  return {
    marketId: `${POLYMARKET_LEDGER_PREFIX}${conditionId}`,
    conditionId,
  };
}

function windowSql(
  query: { since?: string | undefined; until?: string | undefined },
  column: string
): SQL {
  const lower = query.since
    ? sql`${sql.raw(column)} >= ${query.since}::timestamptz`
    : sql`TRUE`;
  const upper = query.until
    ? sql`${sql.raw(column)} < ${query.until}::timestamptz`
    : sql`TRUE`;
  return sql`${lower} AND ${upper}`;
}

function orderSide(value: string | null): "BUY" | "SELL" | null {
  return value === "BUY" || value === "SELL" ? value : null;
}

function cursorPredicate(
  timestampColumn: string,
  idExpression: string,
  cursor: InvestigationEvidenceCursor | null
): SQL {
  if (!cursor) return sql`TRUE`;
  return sql`(
    ${sql.raw(timestampColumn)}, ${sql.raw(idExpression)}
  ) < (${cursor.occurredAt}::timestamptz, ${cursor.evidenceId})`;
}

function fillCursorPredicate(cursor: InvestigationEvidenceCursor | null): SQL {
  if (!cursor) return sql`TRUE`;
  if (!cursor.targetId || !cursor.fillId) throw new InvalidInvestigationCursorError();
  return sql`(
    f.observed_at, f.target_id, f.fill_id
  ) < (
    ${cursor.occurredAt}::timestamptz,
    ${cursor.targetId}::uuid,
    ${cursor.fillId}
  )`;
}

function encodeCursor(cursor: InvestigationEvidenceCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): InvestigationEvidenceCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("invalid_cursor");
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(record.occurredAt)) ||
      typeof record.evidenceId !== "string" ||
      record.evidenceId.length === 0
    ) {
      throw new Error("invalid_cursor");
    }
    if (
      (record.targetId !== undefined && typeof record.targetId !== "string") ||
      (record.fillId !== undefined && typeof record.fillId !== "string")
    ) {
      throw new Error("invalid_cursor");
    }
    return {
      occurredAt: record.occurredAt,
      evidenceId: record.evidenceId,
      ...(typeof record.targetId === "string" ? { targetId: record.targetId } : {}),
      ...(typeof record.fillId === "string" ? { fillId: record.fillId } : {}),
    };
  } catch {
    throw new InvalidInvestigationCursorError();
  }
}

export class InvalidInvestigationCursorError extends Error {
  constructor() {
    super("invalid_cursor");
    this.name = "InvalidInvestigationCursorError";
  }
}

export class InvalidInvestigationCapturedAtError extends Error {
  constructor() {
    super("captured_at_must_not_be_in_the_future");
    this.name = "InvalidInvestigationCapturedAtError";
  }
}

function fact(
  source: PolyResearchCopyTradeInvestigationResponse["completeness"]["facts"][number]["source"],
  observedAt: string | null,
  capturedAt: string,
  freshForMs: number,
  structurallyComplete: boolean
): PolyResearchCopyTradeInvestigationResponse["completeness"]["facts"][number] {
  if (!observedAt) {
    return { source, status: "missing", observed_at: null, complete: false };
  }
  const age = Date.parse(capturedAt) - Date.parse(observedAt);
  const fresh = Number.isFinite(age) && age >= 0 && age <= freshForMs;
  return {
    source,
    status: !structurallyComplete ? "partial" : fresh ? "fresh" : "stale",
    observed_at: observedAt,
    complete: structurallyComplete && fresh,
  };
}

function rowsOf<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object" && Array.isArray((value as { rows?: unknown }).rows)) {
    return (value as { rows: T[] }).rows;
  }
  return [];
}

function number(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(
  value: string | number | null | undefined
): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: string | number | null | undefined): number {
  return Math.max(0, Math.trunc(number(value)));
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function latestIso(values: readonly (string | null)[]): string | null {
  return values.reduce<string | null>((latest, value) => {
    if (!value) return latest;
    return !latest || value > latest ? value : latest;
  }, null);
}

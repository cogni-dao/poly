// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * One saved-facts projection for the account's lifetime token legs.
 *
 * A position is identified by `(billing account, mode, condition, token)` and
 * classified exactly once: resolved -> closed, otherwise positive net shares
 * -> live, otherwise a prior BUY at zero net shares -> fully exited/closed.
 * Order/redeem lifecycle is retained for actions, never used as economic
 * closure authority. The query is tenant-driven and returns at most 530 rows.
 *
 * PAGE_LOAD_DB_ONLY. SAVED_FACTS_ONLY. No upstream reads.
 */
import type {
  PolyWalletOverviewInterval,
  WalletExecutionLifecycleState,
  WalletExecutionPosition,
} from "@cogni/poly-node-contracts";
import { type SQL, sql } from "drizzle-orm";

import { computeRealizedPnl } from "./market-return-math";
import { portfolioWindowStart } from "./portfolio-window";

type ExecuteDb = { execute(query: SQL): Promise<unknown> };

const LIVE_LIMIT = 500;
const CLOSED_LIMIT = 30;

type EconomicRow = {
  live_count: string | number | null;
  closed_count: string | number | null;
  incomplete_count: string | number | null;
  wallet_identity_count: string | number | null;
  fill_identity_conflict_count: string | number | null;
  outcome_identity_conflict_count: string | number | null;
  missing_mark_count: string | number | null;
  economic_bucket: "live" | "closed" | null;
  closed_reason: "resolved" | "fully_exited" | null;
  condition_id: string | null;
  token_id: string | null;
  market_outcome: "winner" | "loser" | null;
  lifecycle_state: string | null;
  opened_at: Date | string | null;
  closed_at: Date | string | null;
  synced_at: Date | string | null;
  total_buy_usdc: string | number | null;
  total_sell_usdc: string | number | null;
  total_buy_shares: string | number | null;
  net_shares: string | number | null;
  current_value_usdc: string | number | null;
  current_price: string | number | null;
  current_shares: string | number | null;
  current_avg_price: string | number | null;
  title: string | null;
  event_title: string | null;
  market_slug: string | null;
  event_slug: string | null;
  outcome_label: string | null;
  resolves_at: Date | string | null;
};

export type EconomicPositionRead = {
  liveCount: number;
  closedCount: number;
  incompleteCount: number;
  walletIdentityCount: number;
  fillIdentityConflictCount: number;
  outcomeIdentityConflictCount: number;
  missingMarkCount: number;
  livePositions: WalletExecutionPosition[];
  closedPositions: WalletExecutionPosition[];
};

export async function readEconomicPositionProjection(params: {
  db: ExecuteDb;
  billingAccountId: string;
  walletAddress: string;
  connectionKind: "privy_live" | "paper";
  capturedAt: Date;
  interval: PolyWalletOverviewInterval;
}): Promise<EconomicPositionRead> {
  const mode = params.connectionKind === "paper" ? "paper" : "live";
  const walletKind = mode === "paper" ? "paper_wallet" : "cogni_wallet";
  const windowStart = portfolioWindowStart(params.interval, params.capturedAt);
  const closedWindow = windowStart
    ? sql`closed_at >= ${windowStart.toISOString()}::timestamptz`
    : sql`TRUE`;

  const rows = normalizeRows<EconomicRow>(await params.db.execute(sql`
    WITH wallet_identity AS MATERIALIZED (
      SELECT w.id, w.updated_at, w.created_at
      FROM poly_trader_wallets w
      WHERE lower(w.wallet_address) = lower(${params.walletAddress})
        AND w.kind = ${walletKind}
    ), ledger_candidates AS MATERIALIZED (
      SELECT
        lower(NULLIF(COALESCE(
          NULLIF(f.attributes->>'condition_id', ''),
          NULLIF(regexp_replace(f.market_id, '^prediction-market:polymarket:', ''), '')
        ), '')) AS condition_id,
        NULLIF(f.attributes->>'token_id', '') AS token_id,
        f.position_lifecycle,
        f.observed_at,
        f.updated_at,
        f.attributes,
        row_number() OVER (
          PARTITION BY
            lower(NULLIF(COALESCE(
              NULLIF(f.attributes->>'condition_id', ''),
              NULLIF(regexp_replace(f.market_id, '^prediction-market:polymarket:', ''), '')
            ), '')),
            NULLIF(f.attributes->>'token_id', '')
          ORDER BY f.updated_at DESC, f.observed_at DESC, f.client_order_id DESC
        ) AS metadata_rank
      FROM poly_copy_trade_fills f
      WHERE f.billing_account_id = ${params.billingAccountId}
        AND f.mode = ${mode}
        AND f.observed_at <= ${params.capturedAt.toISOString()}::timestamptz
        AND (
          f.position_lifecycle IS NOT NULL
          OR CASE
            WHEN COALESCE(f.attributes->>'filled_size_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (f.attributes->>'filled_size_usdc')::numeric > 0
            ELSE false
          END
          OR (
            f.status IN ('filled', 'partial')
            AND COALESCE(f.attributes->>'size_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            AND (f.attributes->>'size_usdc')::numeric > 0
          )
        )
    ), origin_keys AS MATERIALIZED (
      SELECT * FROM ledger_candidates
      WHERE condition_id IS NOT NULL AND token_id IS NOT NULL
    ), current_candidates AS MATERIALIZED (
      SELECT
        lower(p.condition_id) AS condition_id,
        p.token_id,
        p.shares,
        p.cost_basis_usdc,
        p.current_value_usdc,
        p.avg_price,
        p.last_observed_at,
        p.first_observed_at,
        p.raw,
        row_number() OVER (
          PARTITION BY lower(p.condition_id), p.token_id
          ORDER BY p.last_observed_at DESC, w.updated_at DESC,
            w.created_at DESC, w.id, p.condition_id
        ) AS identity_rank
      FROM poly_trader_current_positions p
      JOIN wallet_identity w ON w.id = p.trader_wallet_id
      WHERE p.active = true
    ), current_facts AS MATERIALIZED (
      SELECT * FROM current_candidates WHERE identity_rank = 1
    ), driven_keys AS MATERIALIZED (
      SELECT condition_id, token_id FROM origin_keys
      UNION
      SELECT condition_id, token_id FROM current_facts
      WHERE shares > 0
    ), driven_fill_identities AS MATERIALIZED (
      SELECT DISTINCT f.source, f.native_id
      FROM poly_trader_fills f
      JOIN wallet_identity w ON w.id = f.trader_wallet_id
      JOIN driven_keys k
        ON k.condition_id = lower(f.condition_id)
       AND k.token_id = f.token_id
      WHERE f.observed_at <= ${params.capturedAt.toISOString()}::timestamptz
    ), fill_groups AS MATERIALIZED (
      SELECT
        f.source,
        f.native_id,
        (array_agg(f.id ORDER BY w.updated_at DESC, w.created_at DESC, w.id, f.id))[1] AS chosen_id,
        count(DISTINCT md5(concat_ws('|',
          lower(f.condition_id), f.token_id, f.side, f.price::text,
          f.shares::text, f.size_usdc::text, f.observed_at::text
        )))::int AS fact_variants
      FROM poly_trader_fills f
      JOIN wallet_identity w ON w.id = f.trader_wallet_id
      JOIN driven_fill_identities identity
        ON identity.source = f.source
       AND identity.native_id = f.native_id
      WHERE f.observed_at <= ${params.capturedAt.toISOString()}::timestamptz
      GROUP BY f.source, f.native_id
    ), fill_conflicted_keys AS MATERIALIZED (
      SELECT DISTINCT lower(f.condition_id) AS condition_id, f.token_id
      FROM poly_trader_fills f
      JOIN wallet_identity w ON w.id = f.trader_wallet_id
      JOIN fill_groups g
        ON g.source = f.source
       AND g.native_id = f.native_id
       AND g.fact_variants > 1
      JOIN driven_keys k
        ON k.condition_id = lower(f.condition_id)
       AND k.token_id = f.token_id
      WHERE f.observed_at <= ${params.capturedAt.toISOString()}::timestamptz
    ), canonical_fills AS MATERIALIZED (
      SELECT
        lower(f.condition_id) AS condition_id,
        f.token_id,
        f.side,
        f.price,
        f.shares,
        f.size_usdc,
        f.observed_at,
        g.fact_variants
      FROM fill_groups g
      JOIN poly_trader_fills f ON f.id = g.chosen_id
    ), position_flows AS MATERIALIZED (
      SELECT
        condition_id,
        token_id,
        SUM(size_usdc) FILTER (WHERE side = 'BUY')::numeric AS total_buy_usdc,
        COALESCE(SUM(size_usdc) FILTER (WHERE side = 'SELL'), 0)::numeric AS total_sell_usdc,
        SUM(shares) FILTER (WHERE side = 'BUY')::numeric AS total_buy_shares,
        COALESCE(SUM(shares) FILTER (WHERE side = 'SELL'), 0)::numeric AS total_sell_shares,
        MIN(observed_at) FILTER (WHERE side = 'BUY') AS first_buy_at,
        MAX(observed_at) AS last_flow_at,
        (array_agg(price ORDER BY observed_at DESC))[1]::numeric AS last_price,
        bool_or(fact_variants > 1) AS fill_identity_conflict
      FROM canonical_fills
      GROUP BY condition_id, token_id
    ), outcome_consensus AS MATERIALIZED (
      SELECT
        lower(o.condition_id) AS condition_id,
        o.token_id,
        count(DISTINCT o.outcome) FILTER (
          WHERE o.outcome IN ('winner', 'loser')
        )::int AS terminal_variants,
        count(DISTINCT o.payout) FILTER (
          WHERE o.outcome IN ('winner', 'loser') AND o.payout IS NOT NULL
        )::int AS payout_variants,
        max(o.outcome) FILTER (WHERE o.outcome IN ('winner', 'loser')) AS terminal_outcome,
        min(o.resolved_at) FILTER (
          WHERE o.outcome IN ('winner', 'loser') AND o.resolved_at IS NOT NULL
        ) AS resolved_at
      FROM poly_market_outcomes o
      JOIN driven_keys k
        ON k.condition_id = lower(o.condition_id)
       AND k.token_id = o.token_id
      GROUP BY lower(o.condition_id), o.token_id
    ), economic_position_base AS MATERIALIZED (
      SELECT
        k.condition_id,
        k.token_id,
        pf.total_buy_usdc,
        pf.total_sell_usdc,
        pf.total_buy_shares,
        pf.total_sell_shares,
        pf.total_buy_shares - pf.total_sell_shares AS net_shares,
        pf.first_buy_at,
        pf.last_flow_at,
        pf.last_price,
        (COALESCE(pf.fill_identity_conflict, false) OR ck.condition_id IS NOT NULL)
          AS fill_identity_conflict,
        COALESCE(oc.terminal_variants, 0) AS terminal_variants,
        COALESCE(oc.payout_variants, 0) AS payout_variants,
        oc.terminal_outcome,
        oc.resolved_at,
        cf.shares AS current_shares,
        cf.cost_basis_usdc AS current_cost_basis_usdc,
        cf.current_value_usdc,
        cf.avg_price AS current_avg_price,
        cf.last_observed_at AS current_last_observed_at,
        cf.first_observed_at AS current_first_observed_at,
        cf.raw->>'curPrice' AS raw_cur_price,
        cf.raw->>'outcome' AS current_outcome_label,
        cf.raw->>'endDate' AS current_resolves_at,
        lc.position_lifecycle,
        lc.observed_at AS ledger_observed_at,
        lc.updated_at AS ledger_updated_at,
        lc.attributes,
        r.lifecycle_state AS redeem_lifecycle_state,
        mm.market_title,
        mm.event_title,
        mm.market_slug,
        mm.event_slug,
        mm.end_date
      FROM driven_keys k
      LEFT JOIN position_flows pf USING (condition_id, token_id)
      LEFT JOIN fill_conflicted_keys ck USING (condition_id, token_id)
      LEFT JOIN outcome_consensus oc USING (condition_id, token_id)
      LEFT JOIN current_facts cf USING (condition_id, token_id)
      LEFT JOIN origin_keys lc
        ON lc.condition_id = k.condition_id
       AND lc.token_id = k.token_id
       AND lc.metadata_rank = 1
      LEFT JOIN LATERAL (
        SELECT candidate.lifecycle_state
        FROM poly_redeem_jobs candidate
        WHERE lower(candidate.funder_address) = lower(${params.walletAddress})
          AND lower(candidate.condition_id) = k.condition_id
          AND candidate.position_id = k.token_id
        ORDER BY candidate.updated_at DESC, candidate.id
        LIMIT 1
      ) r ON TRUE
      LEFT JOIN LATERAL (
        SELECT m.market_title, m.event_title, m.market_slug, m.event_slug, m.end_date
        FROM poly_market_metadata m
        WHERE lower(m.condition_id) = k.condition_id
        ORDER BY m.fetched_at DESC, m.condition_id
        LIMIT 1
      ) mm ON TRUE
    ), classified AS MATERIALIZED (
      SELECT
        b.*,
        CASE
          WHEN b.fill_identity_conflict OR b.terminal_variants > 1 OR b.payout_variants > 1
            THEN NULL
          WHEN b.terminal_variants = 1 AND b.resolved_at IS NOT NULL
            AND COALESCE(b.total_buy_shares, b.current_shares) > 0
            AND COALESCE(b.total_buy_usdc, b.current_cost_basis_usdc) > 0
            THEN 'closed'
          WHEN b.terminal_variants = 0 AND b.total_buy_shares > 0
            AND (b.total_buy_shares - b.total_sell_shares) = 0 THEN 'closed'
          WHEN b.terminal_variants = 0
            AND COALESCE(b.total_buy_shares - b.total_sell_shares, b.current_shares) > 0
            AND COALESCE(b.total_buy_usdc, b.current_cost_basis_usdc) > 0
            THEN 'live'
          ELSE NULL
        END AS economic_bucket,
        CASE
          WHEN b.terminal_variants = 1 AND b.resolved_at IS NOT NULL THEN 'resolved'
          WHEN b.terminal_variants = 0 AND b.total_buy_shares > 0
            AND (b.total_buy_shares - b.total_sell_shares) = 0 THEN 'fully_exited'
          ELSE NULL
        END AS closed_reason,
        CASE
          WHEN b.terminal_variants = 1 THEN b.resolved_at
          WHEN b.terminal_variants = 0 AND b.total_buy_shares > 0
            AND (b.total_buy_shares - b.total_sell_shares) = 0 THEN b.last_flow_at
          ELSE NULL
        END AS closed_at
      FROM economic_position_base b
    ), windowed AS MATERIALIZED (
      SELECT * FROM classified
      WHERE economic_bucket = 'live'
        OR (economic_bucket = 'closed' AND ${closedWindow})
    ), ranked AS (
      SELECT
        w.*,
        row_number() OVER (
          PARTITION BY economic_bucket
          ORDER BY
            CASE WHEN economic_bucket = 'closed' THEN closed_at END DESC NULLS LAST,
            CASE WHEN economic_bucket = 'live' THEN current_value_usdc END DESC NULLS LAST,
            condition_id, token_id
        ) AS bucket_rank
      FROM windowed w
      WHERE economic_bucket IS NOT NULL
    ), preview AS (
      SELECT * FROM ranked
      WHERE (economic_bucket = 'live' AND bucket_rank <= ${LIVE_LIMIT})
         OR (economic_bucket = 'closed' AND bucket_rank <= ${CLOSED_LIMIT})
    )
    SELECT
      (SELECT count(*)::int FROM windowed WHERE economic_bucket = 'live') AS live_count,
      (SELECT count(*)::int FROM windowed WHERE economic_bucket = 'closed') AS closed_count,
      (SELECT count(*)::int FROM classified WHERE economic_bucket IS NULL) AS incomplete_count,
      (SELECT count(*)::int FROM wallet_identity) AS wallet_identity_count,
      (SELECT count(*)::int FROM fill_conflicted_keys) AS fill_identity_conflict_count,
      (SELECT count(*)::int FROM outcome_consensus WHERE terminal_variants > 1 OR payout_variants > 1) AS outcome_identity_conflict_count,
      (SELECT count(*)::int FROM classified WHERE economic_bucket = 'live' AND current_value_usdc IS NULL) AS missing_mark_count,
      p.economic_bucket,
      p.closed_reason,
      p.condition_id,
      p.token_id,
      p.terminal_outcome AS market_outcome,
      CASE
        WHEN p.terminal_outcome = 'winner' AND COALESCE(p.redeem_lifecycle_state, '')
          NOT IN ('winner', 'redeem_pending', 'redeemed', 'abandoned') THEN 'winner'
        WHEN p.terminal_outcome = 'loser' AND COALESCE(p.redeem_lifecycle_state, '')
          NOT IN ('loser', 'redeemed', 'dust', 'closed') THEN 'loser'
        ELSE COALESCE(p.redeem_lifecycle_state, p.position_lifecycle)
      END AS lifecycle_state,
      COALESCE(p.first_buy_at, p.current_first_observed_at, p.ledger_observed_at) AS opened_at,
      p.closed_at,
      COALESCE(p.current_last_observed_at, p.ledger_updated_at, p.last_flow_at) AS synced_at,
      COALESCE(p.total_buy_usdc, p.current_cost_basis_usdc) AS total_buy_usdc,
      COALESCE(p.total_sell_usdc, 0) AS total_sell_usdc,
      COALESCE(p.total_buy_shares, p.current_shares) AS total_buy_shares,
      COALESCE(p.total_buy_shares - p.total_sell_shares, p.current_shares) AS net_shares,
      p.current_value_usdc,
      COALESCE(
        CASE WHEN COALESCE(p.raw_cur_price, '') ~ '^[0-9]+(\\.[0-9]+)?$'
          THEN p.raw_cur_price::numeric END,
        p.last_price,
        p.current_avg_price
      ) AS current_price,
      p.current_shares,
      p.current_avg_price,
      COALESCE(p.market_title, p.attributes->>'title', 'Polymarket') AS title,
      COALESCE(p.event_title, p.attributes->>'event_title') AS event_title,
      COALESCE(p.market_slug, p.attributes->>'market_slug', p.attributes->>'slug') AS market_slug,
      COALESCE(p.event_slug, p.attributes->>'event_slug') AS event_slug,
      COALESCE(p.current_outcome_label, p.attributes->>'outcome') AS outcome_label,
      COALESCE(
        p.end_date,
        CASE WHEN COALESCE(p.current_resolves_at, '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
          THEN p.current_resolves_at::timestamptz END
      ) AS resolves_at
    FROM (SELECT 1) seed
    LEFT JOIN preview p ON TRUE
    ORDER BY p.economic_bucket, p.bucket_rank
  `));

  const first = rows[0];
  const livePositions: WalletExecutionPosition[] = [];
  const closedPositions: WalletExecutionPosition[] = [];
  for (const row of rows) {
    const position = toPosition(row, params.capturedAt);
    if (position === null) continue;
    if (row.economic_bucket === "live") livePositions.push(position);
    if (row.economic_bucket === "closed") closedPositions.push(position);
  }
  return {
    liveCount: nonnegativeInt(first?.live_count),
    closedCount: nonnegativeInt(first?.closed_count),
    incompleteCount: nonnegativeInt(first?.incomplete_count),
    walletIdentityCount: nonnegativeInt(first?.wallet_identity_count),
    fillIdentityConflictCount: nonnegativeInt(first?.fill_identity_conflict_count),
    outcomeIdentityConflictCount: nonnegativeInt(first?.outcome_identity_conflict_count),
    missingMarkCount: nonnegativeInt(first?.missing_mark_count),
    livePositions,
    closedPositions,
  };
}

function toPosition(row: EconomicRow, capturedAt: Date): WalletExecutionPosition | null {
  if (row.economic_bucket === null || row.condition_id === null || row.token_id === null) {
    return null;
  }
  const buyUsdc = numberOf(row.total_buy_usdc);
  const sellUsdc = numberOf(row.total_sell_usdc);
  const buyShares = numberOf(row.total_buy_shares);
  const netShares = numberOf(row.net_shares);
  if (buyUsdc <= 0 || buyShares <= 0 || netShares < 0) return null;
  const currentPriceFallback = Math.max(
    0,
    numberOf(row.current_price) || numberOf(row.current_avg_price)
  );
  const currentValue = row.economic_bucket === "live"
    ? row.current_value_usdc === null
      ? currentPriceFallback * netShares
      : Math.max(0, numberOf(row.current_value_usdc))
    : 0;
  const { pnlUsd, pnlPct } = computeRealizedPnl({
    totalBuyNotional: buyUsdc,
    realizedCash: sellUsdc,
    currentMarkValue: currentValue,
    netShares,
    marketOutcome: row.market_outcome,
  });
  const openedAt = iso(row.opened_at) ?? capturedAt.toISOString();
  const closedAt = row.economic_bucket === "closed" ? iso(row.closed_at) : null;
  const lifecycle = normalizeLifecycle(row.lifecycle_state);
  const isUnredeemedWinner =
    row.market_outcome === "winner" && lifecycle !== "redeemed";
  const status = row.economic_bucket === "live"
    ? "open" as const
    : isUnredeemedWinner
      ? "redeemable" as const
      : "closed" as const;
  const lifetimeEntryPrice = buyShares > 0 ? buyUsdc / buyShares : 0;
  const entryPrice = row.economic_bucket === "live"
    ? numberOf(row.current_avg_price) || lifetimeEntryPrice
    : lifetimeEntryPrice;
  const currentShares = Math.max(0, numberOf(row.current_shares));
  const size = row.economic_bucket === "live" && currentShares > 0
    ? currentShares
    : row.economic_bucket === "live"
      ? netShares
      : buyShares;
  const currentPrice = row.economic_bucket === "closed"
    ? row.market_outcome === "winner"
      ? 1
      : row.market_outcome === "loser"
        ? 0
        : currentPriceFallback
    : currentPriceFallback;
  const eventSlug = nonempty(row.event_slug);
  const marketSlug = nonempty(row.market_slug);
  const syncedAt = iso(row.synced_at);
  return {
    positionId: `${row.condition_id}:${row.token_id}`,
    conditionId: row.condition_id,
    asset: row.token_id,
    marketTitle: nonempty(row.title) ?? "Polymarket",
    eventTitle: nonempty(row.event_title),
    marketSlug,
    eventSlug,
    marketUrl: eventSlug
      ? `https://polymarket.com/event/${encodeURIComponent(eventSlug)}`
      : marketSlug
        ? `https://polymarket.com/market/${encodeURIComponent(marketSlug)}`
        : null,
    outcome: nonempty(row.outcome_label) ?? "UNKNOWN",
    status,
    lifecycleState: lifecycle,
    openedAt,
    closedAt,
    resolvesAt: iso(row.resolves_at),
    gameStartTime: null,
    heldMinutes: Math.max(
      0,
      Math.floor(((closedAt ? Date.parse(closedAt) : capturedAt.getTime()) - Date.parse(openedAt)) / 60_000)
    ),
    entryPrice: round(entryPrice, 8),
    currentPrice: round(currentPrice, 8),
    size: round(size, 4),
    currentValue: round(currentValue, 2),
    pnlUsd,
    pnlPct: pnlPct === null ? 0 : round(pnlPct * 100, 2),
    syncedAt,
    syncAgeMs: syncedAt === null ? null : Math.max(0, capturedAt.getTime() - Date.parse(syncedAt)),
    syncStale:
      row.economic_bucket === "live" && row.current_value_usdc === null,
    timeline: [],
    events: [
      { ts: openedAt, kind: "entry", price: round(entryPrice, 8), shares: round(buyShares, 4) },
      ...(closedAt === null
        ? []
        : [{ ts: closedAt, kind: "close" as const, price: round(currentPrice, 8), shares: round(size, 4) }]),
    ],
  };
}

function normalizeLifecycle(value: string | null): WalletExecutionLifecycleState | null {
  const allowed = new Set<WalletExecutionLifecycleState>([
    "unresolved", "open", "closing", "closed", "resolving", "winner",
    "redeem_pending", "redeemed", "loser", "dust", "abandoned",
  ]);
  return value !== null && allowed.has(value as WalletExecutionLifecycleState)
    ? value as WalletExecutionLifecycleState
    : null;
}

function normalizeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result && Array.isArray((result as { rows: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function numberOf(value: string | number | null | undefined): number {
  const number = value === null || value === undefined ? 0 : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nonnegativeInt(value: string | number | null | undefined): number {
  return Math.max(0, Math.trunc(numberOf(value)));
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function nonempty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

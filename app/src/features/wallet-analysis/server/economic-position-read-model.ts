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

export type EconomicPositionReadDiagnostics = {
  economicWalletIdentityMs?: number;
  economicProjectionQueryMs?: number;
};

const LIVE_LIMIT = 500;
const CLOSED_LIMIT = 30;

type EconomicRow = {
  live_count: string | number | null;
  closed_count: string | number | null;
  incomplete_count: string | number | null;
  wallet_identity_count: string | number | null;
  fill_identity_conflict_count: string | number | null;
  outcome_identity_conflict_count: string | number | null;
  current_identity_conflict_count: string | number | null;
  missing_mark_count: string | number | null;
  observer_last_success_at: Date | string | null;
  observer_status: string | null;
  observer_complete: boolean | null;
  positions_mtm_usdc: string | number | null;
  target_correlated: boolean | null;
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
  current_identity_conflict: boolean | null;
  mark_available: boolean | null;
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
  currentIdentityConflictCount: number;
  missingMarkCount: number;
  observerSyncedAt: string | null;
  observerStatus: string | null;
  observerComplete: boolean;
  positionsMtm: number | null;
  targetCorrelatedKeys: ReadonlySet<string>;
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
  diagnostics?: EconomicPositionReadDiagnostics;
}): Promise<EconomicPositionRead> {
  const mode = params.connectionKind === "paper" ? "paper" : "live";
  const walletKind = mode === "paper" ? "paper_wallet" : "cogni_wallet";
  const windowStart = portfolioWindowStart(params.interval, params.capturedAt);
  const closedWindow = windowStart
    ? sql`closed_at >= ${windowStart.toISOString()}::timestamptz`
    : sql`TRUE`;

  // The rollup fast path is safe only when the canonical wallet identity has
  // one physical row. Multiple siblings must retain source/native consensus,
  // including changed-key conflict detection across those siblings.
  const identityStartedAt = performance.now();
  let walletResult: unknown = [];
  try {
    walletResult = await params.db.execute(sql`
      SELECT w.id
      FROM poly_trader_wallets w
      WHERE lower(w.wallet_address) = lower(${params.walletAddress})
        AND w.kind = ${walletKind}
      ORDER BY w.updated_at DESC, w.created_at DESC, w.id
    `);
  } finally {
    recordEconomicDiagnostic(
      params.diagnostics,
      "economicWalletIdentityMs",
      Math.max(0, Math.round(performance.now() - identityStartedAt))
    );
  }
  const walletRows = normalizeRows<{ id: string }>(walletResult);
  const singleWalletId =
    walletRows.length === 1 && walletRows[0] ? walletRows[0].id : null;
  const singleWalletFlows = singleWalletId === null
    ? sql`SELECT NULL::text AS condition_id, NULL::text AS token_id,
        NULL::numeric AS total_buy_usdc, NULL::numeric AS total_sell_usdc,
        NULL::numeric AS total_buy_shares, NULL::numeric AS total_sell_shares,
        NULL::timestamptz AS first_buy_at, NULL::timestamptz AS last_flow_at,
        NULL::numeric AS last_price WHERE FALSE`
    : sql`
      SELECT
        flows.condition_id,
        flows.token_id,
        flows.total_buy_usdc,
        flows.total_sell_usdc,
        flows.total_buy_shares,
        flows.total_sell_shares,
        flows.first_buy_at,
        flows.last_flow_at,
        latest.price::numeric AS last_price
      FROM (
        SELECT
          lower(parts.condition_id) AS condition_id,
          parts.token_id,
          SUM(parts.buy_usdc)::numeric AS total_buy_usdc,
          SUM(parts.sell_usdc)::numeric AS total_sell_usdc,
          SUM(parts.buy_shares)::numeric AS total_buy_shares,
          SUM(parts.sell_shares)::numeric AS total_sell_shares,
          MIN(parts.first_buy_at) AS first_buy_at,
          MAX(parts.last_flow_at) AS last_flow_at
        FROM (
          SELECT
            r.condition_id, r.token_id,
            r.buy_usdc, r.sell_usdc, r.buy_shares, r.sell_shares,
            r.first_buy_observed_at AS first_buy_at,
            r.last_observed_at AS last_flow_at
          FROM driven_keys k
          JOIN poly_trader_fill_rollups_daily r
            ON r.trader_wallet_id = ${singleWalletId}::uuid
           AND lower(r.condition_id) = k.condition_id
           AND r.token_id = k.token_id
           AND r.day < (${params.capturedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC')::date
          UNION ALL
          SELECT
            f.condition_id, f.token_id,
            CASE WHEN f.side = 'BUY' THEN f.size_usdc ELSE 0 END,
            CASE WHEN f.side = 'SELL' THEN f.size_usdc ELSE 0 END,
            CASE WHEN f.side = 'BUY' THEN f.shares ELSE 0 END,
            CASE WHEN f.side = 'SELL' THEN f.shares ELSE 0 END,
            CASE WHEN f.side = 'BUY' THEN f.observed_at END,
            f.observed_at
          FROM driven_keys k
          JOIN poly_trader_fills f
           ON f.trader_wallet_id = ${singleWalletId}::uuid
           AND lower(f.condition_id) = k.condition_id
           AND f.token_id = k.token_id
           AND f.observed_at >= date_trunc(
             'day', ${params.capturedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'
           ) AT TIME ZONE 'UTC'
           AND f.observed_at <= ${params.capturedAt.toISOString()}::timestamptz
          UNION ALL
          SELECT
            f.condition_id, f.token_id,
            CASE WHEN f.side = 'BUY' THEN f.size_usdc ELSE 0 END,
            CASE WHEN f.side = 'SELL' THEN f.size_usdc ELSE 0 END,
            CASE WHEN f.side = 'BUY' THEN f.shares ELSE 0 END,
            CASE WHEN f.side = 'SELL' THEN f.shares ELSE 0 END,
            CASE WHEN f.side = 'BUY' THEN f.observed_at END,
            f.observed_at
          FROM driven_keys k
          JOIN poly_trader_fills f
           ON f.trader_wallet_id = ${singleWalletId}::uuid
           AND lower(f.condition_id) = k.condition_id
           AND f.token_id = k.token_id
           AND f.observed_at < date_trunc(
             'day', ${params.capturedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'
           ) AT TIME ZONE 'UTC'
           AND f.observed_at <= ${params.capturedAt.toISOString()}::timestamptz
          LEFT JOIN poly_trader_fill_rollup_cursors c
            ON c.trader_wallet_id = f.trader_wallet_id
          WHERE (f.created_at, f.id) > (
            COALESCE(c.last_created_at, 'epoch'::timestamptz),
            COALESCE(c.last_fill_id, '00000000-0000-0000-0000-000000000000'::uuid)
          )
        ) parts
        GROUP BY lower(parts.condition_id), parts.token_id
      ) flows
      LEFT JOIN LATERAL (
        SELECT f.price
        FROM poly_trader_fills f
        WHERE f.trader_wallet_id = ${singleWalletId}::uuid
          AND lower(f.condition_id) = flows.condition_id
          AND f.token_id = flows.token_id
          AND f.observed_at <= ${params.capturedAt.toISOString()}::timestamptz
        ORDER BY f.observed_at DESC, f.id DESC
        LIMIT 1
      ) latest ON TRUE
    `;

  const queryStartedAt = performance.now();
  let queryResult: unknown = [];
  try {
    queryResult = await params.db.execute(sql`
    WITH wallet_identity AS MATERIALIZED (
      SELECT w.id, w.updated_at, w.created_at
      FROM poly_trader_wallets w
      WHERE lower(w.wallet_address) = lower(${params.walletAddress})
        AND w.kind = ${walletKind}
    ), eligible_wallet_identity AS MATERIALIZED (
      SELECT w.id
      FROM poly_trader_wallets w
      WHERE lower(w.wallet_address) = lower(${params.walletAddress})
        AND w.kind = ${walletKind}
        AND w.active_for_research = true
        AND w.disabled_at IS NULL
    ), observer_summary AS MATERIALIZED (
      SELECT
        min(c.last_success_at) AS last_success_at,
        CASE
          WHEN count(w.id) = 0 THEN NULL
          WHEN count(c.trader_wallet_id) < count(w.id) THEN 'partial'
          WHEN bool_and(c.status = 'ok') THEN 'ok'
          WHEN bool_or(c.status = 'partial') THEN 'partial'
          WHEN bool_or(c.status = 'error') THEN 'error'
          WHEN bool_or(c.status = 'stale') THEN 'stale'
          ELSE 'partial'
        END AS status,
        count(w.id) > 0
          AND count(c.trader_wallet_id) = count(w.id)
          AND min(c.last_success_at) IS NOT NULL AS complete
      FROM eligible_wallet_identity w
      LEFT JOIN poly_trader_ingestion_cursors c
        ON c.trader_wallet_id = w.id
       AND c.source = ${mode === "paper" ? "paper-ledger-positions" : "data-api-positions"}
    ), ledger_candidate_refs AS MATERIALIZED (
      SELECT DISTINCT ON (
        lower(NULLIF(COALESCE(
          NULLIF(f.attributes->>'condition_id', ''),
          NULLIF(regexp_replace(f.market_id, '^prediction-market:polymarket:', ''), '')
        ), '')),
        NULLIF(f.attributes->>'token_id', '')
      )
        lower(NULLIF(COALESCE(
          NULLIF(f.attributes->>'condition_id', ''),
          NULLIF(regexp_replace(f.market_id, '^prediction-market:polymarket:', ''), '')
        ), '')) AS condition_id,
        NULLIF(f.attributes->>'token_id', '') AS token_id,
        f.target_id,
        f.fill_id
      FROM poly_copy_trade_fills f
      WHERE f.billing_account_id = ${params.billingAccountId}
        AND f.mode = ${mode}
        AND f.observed_at <= ${params.capturedAt.toISOString()}::timestamptz
        AND lower(NULLIF(COALESCE(
          NULLIF(f.attributes->>'condition_id', ''),
          NULLIF(regexp_replace(f.market_id, '^prediction-market:polymarket:', ''), '')
        ), '')) IS NOT NULL
        AND NULLIF(f.attributes->>'token_id', '') IS NOT NULL
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
      ORDER BY
        lower(NULLIF(COALESCE(
          NULLIF(f.attributes->>'condition_id', ''),
          NULLIF(regexp_replace(f.market_id, '^prediction-market:polymarket:', ''), '')
        ), '')),
        NULLIF(f.attributes->>'token_id', ''),
        f.updated_at DESC,
        f.observed_at DESC,
        f.client_order_id DESC
    ), ledger_candidates AS MATERIALIZED (
      SELECT
        r.condition_id,
        r.token_id,
        f.position_lifecycle,
        f.observed_at,
        f.updated_at,
        f.attributes
      FROM ledger_candidate_refs r
      JOIN poly_copy_trade_fills f
        ON f.billing_account_id = ${params.billingAccountId}
       AND f.target_id = r.target_id
       AND f.fill_id = r.fill_id
      WHERE f.mode = ${mode}
        AND f.observed_at <= ${params.capturedAt.toISOString()}::timestamptz
    ), current_groups AS MATERIALIZED (
      SELECT
        lower(p.condition_id) AS condition_id,
        p.token_id,
        (array_agg(p.trader_wallet_id ORDER BY p.last_observed_at DESC,
          w.updated_at DESC, w.created_at DESC, w.id, p.condition_id))[1]
          AS chosen_wallet_id,
        (array_agg(p.condition_id ORDER BY p.last_observed_at DESC,
          w.updated_at DESC, w.created_at DESC, w.id, p.condition_id))[1]
          AS chosen_condition_id,
        count(DISTINCT md5(concat_ws('|',
          p.shares::text, p.cost_basis_usdc::text, p.current_value_usdc::text,
          p.avg_price::text, COALESCE(p.raw->>'curPrice', ''),
          COALESCE(p.raw->>'outcome', ''), COALESCE(p.raw->>'endDate', '')
        )))::int AS fact_variants
      FROM poly_trader_current_positions p
      JOIN wallet_identity w ON w.id = p.trader_wallet_id
      WHERE p.active = true
      GROUP BY lower(p.condition_id), p.token_id
    ), current_facts AS MATERIALIZED (
      SELECT
        g.condition_id,
        g.token_id,
        p.shares,
        p.cost_basis_usdc,
        p.current_value_usdc,
        p.avg_price,
        p.last_observed_at,
        p.first_observed_at,
        p.raw,
        g.fact_variants > 1 AS current_identity_conflict
      FROM current_groups g
      JOIN poly_trader_current_positions p
        ON p.trader_wallet_id = g.chosen_wallet_id
       AND p.condition_id = g.chosen_condition_id
       AND p.token_id = g.token_id
    ), driven_keys AS MATERIALIZED (
      SELECT condition_id, token_id FROM ledger_candidates
      UNION
      SELECT condition_id, token_id FROM current_facts
      WHERE shares > 0
    ), target_correlated_keys AS MATERIALIZED (
      SELECT DISTINCT lower(p.condition_id) AS condition_id, p.token_id
      FROM poly_copy_trade_targets target
      JOIN poly_trader_wallets target_wallet
        ON lower(target_wallet.wallet_address) = lower(target.target_wallet)
       AND target_wallet.kind = 'copy_target'
       AND target_wallet.active_for_research = true
       AND target_wallet.disabled_at IS NULL
      JOIN poly_trader_current_positions p
        ON p.trader_wallet_id = target_wallet.id
      JOIN driven_keys k
        ON k.condition_id = lower(p.condition_id)
       AND k.token_id = p.token_id
      WHERE target.billing_account_id = ${params.billingAccountId}
        AND target.disabled_at IS NULL
    ), fill_identity_anchors AS MATERIALIZED (
      SELECT DISTINCT f.source, f.native_id
      FROM poly_trader_fills f
      JOIN wallet_identity w ON w.id = f.trader_wallet_id
      JOIN driven_keys k
        ON k.condition_id = lower(f.condition_id)
       AND k.token_id = f.token_id
      WHERE f.observed_at <= ${params.capturedAt.toISOString()}::timestamptz
        AND ${singleWalletId}::uuid IS NULL
    ), fill_candidates AS MATERIALIZED (
      SELECT
        f.id,
        f.source,
        f.native_id,
        f.condition_id,
        f.token_id,
        f.side,
        f.price,
        f.shares,
        f.size_usdc,
        f.observed_at,
        w.updated_at AS wallet_updated_at,
        w.created_at AS wallet_created_at,
        w.id AS wallet_id
      FROM fill_identity_anchors identity
      JOIN wallet_identity w ON TRUE
      JOIN poly_trader_fills f
        ON f.trader_wallet_id = w.id
       AND f.source = identity.source
       AND f.native_id = identity.native_id
      WHERE f.observed_at <= ${params.capturedAt.toISOString()}::timestamptz
    ), fill_groups AS MATERIALIZED (
      SELECT
        f.source,
        f.native_id,
        (array_agg(f.id ORDER BY
          f.wallet_updated_at DESC,
          f.wallet_created_at DESC,
          f.wallet_id,
          f.id
        ))[1] AS chosen_id,
        count(DISTINCT md5(concat_ws('|',
          lower(f.condition_id), f.token_id, f.side, f.price::text,
          f.shares::text, f.size_usdc::text, f.observed_at::text
        )))::int AS fact_variants
      FROM fill_candidates f
      GROUP BY f.source, f.native_id
    ), fill_conflicted_keys AS MATERIALIZED (
      SELECT DISTINCT lower(f.condition_id) AS condition_id, f.token_id
      FROM fill_candidates f
      JOIN fill_groups g
        ON g.source = f.source
       AND g.native_id = f.native_id
       AND g.fact_variants > 1
      JOIN driven_keys k
        ON k.condition_id = lower(f.condition_id)
       AND k.token_id = f.token_id
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
      JOIN fill_candidates f ON f.id = g.chosen_id
    ), raw_position_flows AS MATERIALIZED (
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
    ), single_position_flows AS MATERIALIZED (
      ${singleWalletFlows}
    ), position_flows AS MATERIALIZED (
      SELECT
        condition_id, token_id, total_buy_usdc, total_sell_usdc,
        total_buy_shares, total_sell_shares, first_buy_at, last_flow_at,
        last_price, false AS fill_identity_conflict
      FROM single_position_flows
      UNION ALL
      SELECT * FROM raw_position_flows
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
        cf.current_identity_conflict,
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
      LEFT JOIN ledger_candidates lc
        ON lc.condition_id = k.condition_id
       AND lc.token_id = k.token_id
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
        (
          b.current_value_usdc IS NOT NULL
          AND NOT COALESCE(b.current_identity_conflict, false)
          AND observer.status = 'ok'
          AND observer.complete
          AND observer.last_success_at >= ${params.capturedAt.toISOString()}::timestamptz - INTERVAL '10 minutes'
          AND b.current_last_observed_at >= ${params.capturedAt.toISOString()}::timestamptz - INTERVAL '10 minutes'
        ) AS mark_available,
        CASE
          WHEN b.fill_identity_conflict OR b.terminal_variants > 1 OR b.payout_variants > 1
            THEN NULL
          WHEN b.current_identity_conflict AND b.total_buy_shares IS NULL
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
      CROSS JOIN observer_summary observer
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
            CASE WHEN economic_bucket = 'live' THEN EXISTS (
              SELECT 1 FROM target_correlated_keys target_key
              WHERE target_key.condition_id = w.condition_id
                AND target_key.token_id = w.token_id
            ) END DESC NULLS LAST,
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
      (SELECT count(*)::int FROM current_facts WHERE current_identity_conflict) AS current_identity_conflict_count,
      (SELECT count(*)::int FROM classified WHERE economic_bucket = 'live' AND NOT mark_available) AS missing_mark_count,
      observer.last_success_at AS observer_last_success_at,
      observer.status AS observer_status,
      observer.complete AS observer_complete,
      CASE
        WHEN observer.status = 'ok' AND observer.complete
          AND observer.last_success_at >= ${params.capturedAt.toISOString()}::timestamptz - INTERVAL '10 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM classified
            WHERE economic_bucket = 'live' AND NOT mark_available
          )
        THEN (
          SELECT COALESCE(sum(current_value_usdc), 0)
          FROM classified
          WHERE economic_bucket = 'live' AND mark_available
        )
        ELSE NULL
      END AS positions_mtm_usdc,
      EXISTS (
        SELECT 1 FROM target_correlated_keys target_key
        WHERE target_key.condition_id = p.condition_id
          AND target_key.token_id = p.token_id
      ) AS target_correlated,
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
      p.current_identity_conflict,
      p.mark_available,
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
    CROSS JOIN observer_summary observer
    LEFT JOIN preview p ON TRUE
    ORDER BY p.economic_bucket, p.bucket_rank
    `);
  } finally {
    recordEconomicDiagnostic(
      params.diagnostics,
      "economicProjectionQueryMs",
      Math.max(0, Math.round(performance.now() - queryStartedAt))
    );
  }
  const rows = normalizeRows<EconomicRow>(queryResult);

  const first = rows[0];
  const livePositions: WalletExecutionPosition[] = [];
  const closedPositions: WalletExecutionPosition[] = [];
  const targetCorrelatedKeys = new Set<string>();
  for (const row of rows) {
    const position = toPosition(row, params.capturedAt);
    if (position === null) continue;
    if (row.target_correlated) targetCorrelatedKeys.add(position.positionId);
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
    currentIdentityConflictCount: nonnegativeInt(first?.current_identity_conflict_count),
    missingMarkCount: nonnegativeInt(first?.missing_mark_count),
    observerSyncedAt: iso(first?.observer_last_success_at),
    observerStatus: first?.observer_status ?? null,
    observerComplete: first?.observer_complete === true,
    positionsMtm:
      first?.positions_mtm_usdc === null || first?.positions_mtm_usdc === undefined
        ? null
        : round(numberOf(first.positions_mtm_usdc), 2),
    targetCorrelatedKeys,
    livePositions,
    closedPositions,
  };
}

function recordEconomicDiagnostic<K extends keyof EconomicPositionReadDiagnostics>(
  diagnostics: EconomicPositionReadDiagnostics | undefined,
  key: K,
  value: EconomicPositionReadDiagnostics[K]
): void {
  if (!diagnostics) return;
  try {
    diagnostics[key] = value;
  } catch {
    // Diagnostics are fail-open and cannot alter saved economic truth.
  }
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
  const savedCurrentPrice = Math.max(
    0,
    numberOf(row.current_price) || numberOf(row.current_avg_price)
  );
  const hasValuation = row.economic_bucket === "closed" || row.mark_available === true;
  const currentValue = row.economic_bucket === "closed"
    ? 0
    : hasValuation
      ? Math.max(0, numberOf(row.current_value_usdc))
      : null;
  const realized = hasValuation
    ? computeRealizedPnl({
        totalBuyNotional: buyUsdc,
        realizedCash: sellUsdc,
        currentMarkValue: currentValue ?? 0,
        netShares,
        marketOutcome: row.market_outcome,
      })
    : null;
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
        : savedCurrentPrice
    : hasValuation
      ? savedCurrentPrice
      : null;
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
    currentPrice: currentPrice === null ? null : round(currentPrice, 8),
    size: round(size, 4),
    currentValue: currentValue === null ? null : round(currentValue, 2),
    pnlUsd: realized?.pnlUsd ?? null,
    pnlPct:
      realized?.pnlPct === null || realized?.pnlPct === undefined
        ? null
        : round(realized.pnlPct * 100, 2),
    syncedAt,
    syncAgeMs: syncedAt === null ? null : Math.max(0, capturedAt.getTime() - Date.parse(syncedAt)),
    syncStale:
      row.economic_bucket === "live" && !hasValuation,
    timeline: [],
    events: [
      { ts: openedAt, kind: "entry", price: round(entryPrice, 8), shares: round(buyShares, 4) },
      ...(closedAt === null
        ? []
        : [{ ts: closedAt, kind: "close" as const, price: round(currentPrice ?? 0, 8), shares: round(size, 4) }]),
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

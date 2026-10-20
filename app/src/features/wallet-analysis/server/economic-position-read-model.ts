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
import type { EconomicObservationV1 } from "./economic-observation-recovery";
import { computeRealizedPnl } from "./market-return-math";
import {
  type PositionMetadataKey,
  positionMetadataDisplay,
  positionMetadataRequestKey,
  readPositionMetadata,
} from "./position-metadata-read";
import { paperAccountingCtes } from "./paper-fact-source";
import { portfolioWindowStart } from "./portfolio-window";

type ExecuteDb = { execute(query: SQL): Promise<unknown> };

const LIVE_LIMIT = 500;
const CLOSED_LIMIT = 30;

type EconomicRow = {
  live_count: string | number | null;
  closed_count: string | number | null;
  incomplete_count: string | number | null;
  history_incomplete_count: string | number | null;
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
  current_cost_basis_usdc: string | number | null;
  current_unrealized_pnl: string | number | null;
  current_realized_pnl: string | number | null;
  current_last_observed_at: Date | string | null;
  inventory_authoritative: boolean | null;
  inventory_fresh: boolean | null;
  economic_observation: Omit<EconomicObservationV1, "constituents"> | null;
  economic_record_count: string | number | null;
  history_complete: boolean | null;
  observed_lifetime_pnl: string | number | null;
  current_identity_conflict: boolean | null;
  mark_available: boolean | null;
  terminal_zero_valuation: boolean | null;
  title: string | null;
  event_title: string | null;
  market_slug: string | null;
  event_slug: string | null;
  outcome_label: string | null;
  resolves_at: Date | string | null;
};

/** Current inventory and lifetime economics have independent authority. */
export type EconomicPositionFact = {
  mode: "live" | "paper";
  conditionId: string;
  tokenId: string;
  heldShares: number | null;
  currentValueUsdc: number | null;
  remainingBasisUsdc: number | null;
  unrealizedPnlUsdc: number | null;
  realizedPnlUsdc: number | null;
  lifetimePnlUsdc: number | null;
  observedAt: string | null;
  quantitySource: "current_observation" | "paper_ledger" | "unknown";
  basisSource: "vendor_current" | "complete_history" | "unknown";
  inventoryCoverage: "complete" | "stale" | "conflict" | "unavailable";
  economicsCoverage: "complete" | "partial" | "conflict" | "unavailable";
};

export type EconomicPositionRead = {
  positionFacts: readonly EconomicPositionFact[];
  liveCount: number;
  closedCount: number;
  incompleteCount: number;
  historyIncompleteCount: number;
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
}): Promise<EconomicPositionRead> {
  const mode = params.connectionKind === "paper" ? "paper" : "live";
  const walletKind = mode === "paper" ? "paper_wallet" : "cogni_wallet";
  const windowStart = portfolioWindowStart(params.interval, params.capturedAt);
  const closedWindow = windowStart
    ? sql`closed_at >= ${windowStart.toISOString()}::timestamptz`
    : sql`TRUE`;

  const rows = normalizeRows<EconomicRow>(
    await params.db.execute(sql`
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
        max(c.last_success_at) AS latest_generation_at,
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
    ), ${paperAccountingCtes({
      billingAccountId: params.billingAccountId,
      walletIds: sql`SELECT id FROM wallet_identity`,
      capturedAt: sql`least(${params.capturedAt.toISOString()}::timestamptz, COALESCE((SELECT latest_generation_at FROM observer_summary), ${params.capturedAt.toISOString()}::timestamptz))`,
      enabled: mode === "paper",
    })}, ledger_candidates AS MATERIALIZED (
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
        /* Discovery is independent of execution/audit success. */
    ), origin_keys AS MATERIALIZED (
      SELECT * FROM ledger_candidates
      WHERE condition_id IS NOT NULL AND token_id IS NOT NULL
    ), history_facts AS MATERIALIZED (
      SELECT DISTINCT ON (lower(s.condition_id), s.token_id)
        lower(s.condition_id) AS condition_id, s.token_id,
        s.raw->'economicObservationV1' AS observation
      FROM poly_trader_position_snapshots s
      JOIN wallet_identity w ON w.id = s.trader_wallet_id
      WHERE s.captured_at <= ${params.capturedAt.toISOString()}::timestamptz
        AND s.raw->'economicObservationV1'->>'version' = '1'
        AND s.raw->'economicObservationV1'->>'tokenId' = s.token_id
        AND lower(s.raw->'economicObservationV1'->>'conditionId') = lower(s.condition_id)
        AND lower(s.raw->'economicObservationV1'->>'wallet') = lower(${params.walletAddress})
      ORDER BY lower(s.condition_id), s.token_id, s.captured_at DESC, s.id
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
      WHERE p.last_observed_at <= ${params.capturedAt.toISOString()}::timestamptz
      GROUP BY lower(p.condition_id), p.token_id
    ), current_facts AS MATERIALIZED (
      SELECT
        g.condition_id,
        g.token_id,
        g.chosen_wallet_id,
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
      SELECT condition_id, token_id FROM origin_keys
      UNION
      SELECT condition_id, token_id FROM current_facts
      UNION SELECT condition_id, token_id FROM history_facts
      UNION
      SELECT lower(r.condition_id), r.token_id
      FROM poly_trader_fill_rollups_daily r
      JOIN wallet_identity w ON w.id = r.trader_wallet_id
      WHERE r.day <= ${params.capturedAt.toISOString()}::timestamptz::date
      UNION
      SELECT lower(f.condition_id), f.token_id
      FROM poly_trader_fills f
      JOIN wallet_identity w ON w.id = f.trader_wallet_id
      LEFT JOIN poly_trader_fill_rollup_cursors cursor ON cursor.trader_wallet_id = w.id
      WHERE f.observed_at <= ${params.capturedAt.toISOString()}::timestamptz
        AND (f.created_at, f.id) > (
          COALESCE(cursor.last_created_at, 'epoch'::timestamptz),
          COALESCE(cursor.last_fill_id, '00000000-0000-0000-0000-000000000000'::uuid)
        )
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
      FROM ${mode === "paper" ? sql`(SELECT *, 1 AS fact_variants FROM paper_inventory_facts) paper_flows` : sql`canonical_fills`}
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
        bool_and(o.payout IS NOT NULL AND (
          (o.outcome = 'loser' AND o.payout = 0) OR
          (o.outcome = 'winner' AND o.payout = 1)
        )) FILTER (WHERE o.outcome IN ('winner', 'loser')) AS payout_consistent,
        max(o.outcome) FILTER (WHERE o.outcome IN ('winner', 'loser')) AS terminal_outcome,
        min(o.resolved_at) FILTER (
          WHERE o.outcome IN ('winner', 'loser') AND o.resolved_at IS NOT NULL
        ) AS resolved_at
      FROM poly_market_outcomes o
      JOIN driven_keys k
        ON k.condition_id = lower(o.condition_id)
       AND k.token_id = o.token_id
      WHERE o.updated_at <= ${params.capturedAt.toISOString()}::timestamptz
        AND (o.resolved_at IS NULL OR o.resolved_at <= ${params.capturedAt.toISOString()}::timestamptz)
      GROUP BY lower(o.condition_id), o.token_id
    ), economic_position_base AS MATERIALIZED (
      SELECT
        k.condition_id,
        k.token_id,
        pf.total_buy_usdc,
        pf.total_sell_usdc,
        pf.total_buy_shares,
        pf.total_sell_shares,
        paper_fees.fees_usdc AS paper_fees_usdc,
        pf.total_buy_shares - pf.total_sell_shares AS net_shares,
        pf.first_buy_at,
        pf.last_flow_at,
        pf.last_price,
        (COALESCE(pf.fill_identity_conflict, false) OR ck.condition_id IS NOT NULL)
          AS fill_identity_conflict,
        COALESCE(oc.terminal_variants, 0) AS terminal_variants,
        COALESCE(oc.payout_variants, 0) AS payout_variants,
        oc.terminal_outcome,
        (k.condition_id ~ '^0x[0-9a-f]{64}$'
          AND k.token_id ~ '^(0|[1-9][0-9]*)$'
          AND oc.terminal_variants = 1 AND oc.payout_variants = 1
          AND oc.payout_consistent AND oc.terminal_outcome = 'loser'
          AND oc.resolved_at IS NOT NULL) AS terminal_zero_valuation,
        oc.resolved_at,
        cf.chosen_wallet_id,
        cf.shares AS current_shares,
        cf.cost_basis_usdc AS current_cost_basis_usdc,
        cf.current_value_usdc,
        cf.avg_price AS current_avg_price,
        cf.last_observed_at AS current_last_observed_at,
        cf.first_observed_at AS current_first_observed_at,
        cf.raw->>'curPrice' AS raw_cur_price,
        CASE WHEN COALESCE(cf.raw->>'cashPnl', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (cf.raw->>'cashPnl')::numeric END AS current_unrealized_pnl,
        CASE WHEN COALESCE(cf.raw->>'realizedPnl', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (cf.raw->>'realizedPnl')::numeric END AS current_realized_pnl,
        CASE WHEN cf.raw->'economicObservationV1'->>'fetchedAt' >= COALESCE(hf.observation->>'fetchedAt', '')
          THEN cf.raw->'economicObservationV1' ELSE hf.observation END AS economic_observation,
        cf.raw AS current_raw,
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
      LEFT JOIN paper_position_fees paper_fees USING (condition_id, token_id)
      LEFT JOIN fill_conflicted_keys ck USING (condition_id, token_id)
      LEFT JOIN outcome_consensus oc USING (condition_id, token_id)
      LEFT JOIN current_facts cf USING (condition_id, token_id)
      LEFT JOIN history_facts hf USING (condition_id, token_id)
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
    ), generation_authority AS MATERIALIZED (
      SELECT b.*,
        /* A retained positive is not an observation of a newer publication.
           Keep the selected physical cursor association; an eligible sibling
           cannot lend it authority. MAX deliberately includes future clocks:
           overwritten authority cannot reconstruct an earlier capture. */
        (CASE WHEN ${mode} = 'paper' THEN (SELECT inventory_complete FROM paper_coverage)
          AND b.current_raw->>'source' = 'paper-ledger' AND b.current_shares = b.net_shares
          ELSE b.current_shares = 0 OR COALESCE((
          b.current_last_observed_at <= ${params.capturedAt.toISOString()}::timestamptz
          AND observer.latest_generation_at <= ${params.capturedAt.toISOString()}::timestamptz
          AND b.current_last_observed_at >= observer.latest_generation_at
          AND NOT EXISTS (
            SELECT 1 FROM poly_trader_current_positions future
            JOIN wallet_identity w ON w.id = future.trader_wallet_id
            WHERE lower(future.condition_id) = b.condition_id
              AND future.token_id = b.token_id
              AND future.last_observed_at > ${params.capturedAt.toISOString()}::timestamptz
          )
          AND EXISTS (
            SELECT 1 FROM eligible_wallet_identity selected
            JOIN poly_trader_ingestion_cursors cursor
              ON cursor.trader_wallet_id = selected.id
             AND cursor.source = 'data-api-positions'
            WHERE selected.id = b.chosen_wallet_id
              AND cursor.status = 'ok'
              AND cursor.last_success_at IS NOT NULL
              AND cursor.last_success_at <= ${params.capturedAt.toISOString()}::timestamptz
              AND b.current_last_observed_at >= cursor.last_success_at
          )
        ), false) END) AS live_positive_current_currency
      FROM economic_position_base b
      CROSS JOIN observer_summary observer
    ), event_authority AS MATERIALIZED (
      SELECT b.*,
        /* Lifetime completeness cannot waive a retained settlement's clock.
           Future envelopes cannot invalidate an earlier snapshot. A
           retained proof without an ordering clock cannot bless positive MTM. */
        CASE
          WHEN b.economic_observation->>'fetchedAt' <= ${params.capturedAt.toISOString()} THEN
            CASE WHEN COALESCE(b.economic_observation->'closedPosition'->>'last_event_at', '') ~ '^[0-9]+([.][0-9]+)?$' THEN
              CASE WHEN (b.economic_observation->'closedPosition'->>'last_event_at')::numeric
                  <= extract(epoch FROM ${params.capturedAt.toISOString()}::timestamptz)
                THEN b.current_last_observed_at >= to_timestamp((b.economic_observation->'closedPosition'->>'last_event_at')::numeric)
                ELSE CASE WHEN jsonb_array_length(COALESCE(b.economic_observation->'settlements', '[]'::jsonb)) > 0
                  THEN b.current_shares = 0 ELSE true END END
            ELSE CASE WHEN jsonb_array_length(COALESCE(b.economic_observation->'settlements', '[]'::jsonb)) > 0
              THEN b.current_shares = 0
              ELSE true END END
          ELSE true
        END AS current_after_economic_event
      FROM generation_authority b
    ), classified_raw AS MATERIALIZED (
      SELECT
        b.*,
        (b.current_last_observed_at IS NOT NULL
          AND NOT COALESCE(b.current_identity_conflict, false)
          AND b.current_last_observed_at >= COALESCE(b.last_flow_at, '-infinity'::timestamptz)
          AND b.current_after_economic_event
          AND b.live_positive_current_currency
        ) AS inventory_authoritative,
        (b.live_positive_current_currency AND observer.status = 'ok' AND observer.complete
          AND observer.last_success_at >= ${params.capturedAt.toISOString()}::timestamptz - INTERVAL '10 minutes'
          AND observer.last_success_at <= ${params.capturedAt.toISOString()}::timestamptz
          AND (b.current_shares = 0 OR b.current_last_observed_at >= ${params.capturedAt.toISOString()}::timestamptz - INTERVAL '10 minutes')
        ) AS inventory_fresh,
        (CASE WHEN ${mode} = 'paper' THEN
          (SELECT finance_complete FROM paper_coverage)
          AND b.current_raw->>'source' = 'paper-ledger'
          AND observer.status = 'ok' AND observer.complete
          AND observer.last_success_at <= ${params.capturedAt.toISOString()}::timestamptz
          AND observer.last_success_at >= b.current_last_observed_at
          AND observer.last_success_at >= COALESCE(b.last_flow_at, '-infinity'::timestamptz)
          AND b.current_last_observed_at >= COALESCE(b.last_flow_at, '-infinity'::timestamptz)
          AND b.current_raw->'paperCoverage'->>'financeComplete' = 'true'
          AND b.current_raw->'paperCoverage'->>'generationAt' = to_char(b.current_last_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          AND NOT COALESCE(b.current_identity_conflict, false)
          AND NOT b.fill_identity_conflict
          AND b.total_buy_usdc IS NOT NULL AND b.total_buy_shares > 0
          AND b.current_shares = b.net_shares AND b.net_shares >= 0
          AND b.current_value_usdc IS NOT NULL
          AND CASE WHEN COALESCE(b.current_raw->>'buyUsdc', '') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (b.current_raw->>'buyUsdc')::numeric END = b.total_buy_usdc
          AND CASE WHEN COALESCE(b.current_raw->>'sellUsdc', '') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (b.current_raw->>'sellUsdc')::numeric END = b.total_sell_usdc
          AND CASE WHEN COALESCE(b.current_raw->>'buyShares', '') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (b.current_raw->>'buyShares')::numeric END = b.total_buy_shares
          ELSE b.economic_observation->>'coverage' = 'complete'
          AND b.economic_observation->>'fetchedAt' <= ${params.capturedAt.toISOString()}
          AND (b.economic_observation->>'windowEnd')::timestamptz >= COALESCE(b.last_flow_at, '-infinity'::timestamptz)
          END
        ) AS history_complete,
        (
          b.current_value_usdc IS NOT NULL
          AND NOT COALESCE(b.current_identity_conflict, false)
          AND observer.status = 'ok'
          AND observer.complete
          AND observer.last_success_at >= ${params.capturedAt.toISOString()}::timestamptz - INTERVAL '10 minutes'
          AND b.current_last_observed_at >= ${params.capturedAt.toISOString()}::timestamptz - INTERVAL '10 minutes'
          AND b.current_last_observed_at >= COALESCE(b.last_flow_at, '-infinity'::timestamptz)
          AND b.current_after_economic_event
          AND b.live_positive_current_currency
          AND observer.last_success_at <= ${params.capturedAt.toISOString()}::timestamptz
        ) AS mark_available,
        CASE
          WHEN b.terminal_variants > 1 OR b.payout_variants > 1
            THEN NULL
          WHEN b.economic_observation->>'coverage' = 'complete'
            AND b.economic_observation->>'fetchedAt' <= ${params.capturedAt.toISOString()}
            AND (b.economic_observation->>'windowEnd')::timestamptz >= COALESCE(b.last_flow_at, '-infinity'::timestamptz)
            THEN 'closed'
          WHEN b.fill_identity_conflict THEN NULL
          WHEN b.current_identity_conflict AND b.total_buy_shares IS NULL
            THEN NULL
          WHEN b.terminal_variants = 1 AND b.resolved_at IS NOT NULL
            AND COALESCE(b.total_buy_shares, b.current_shares) > 0
            AND COALESCE(b.total_buy_usdc, b.current_cost_basis_usdc) > 0
            THEN 'closed'
          WHEN b.terminal_variants = 0 AND b.total_buy_shares > 0
            AND (b.total_buy_shares - b.total_sell_shares) = 0 THEN 'closed'
          WHEN b.terminal_variants = 0
            AND (b.current_shares > 0 OR
              (b.current_shares IS NULL AND b.total_buy_shares - b.total_sell_shares > 0))
            THEN 'live'
          ELSE NULL
        END AS economic_bucket,
        CASE
          WHEN b.economic_observation->>'coverage' = 'complete' THEN 'resolved'
          WHEN b.terminal_variants = 1 AND b.resolved_at IS NOT NULL THEN 'resolved'
          WHEN b.terminal_variants = 0 AND b.total_buy_shares > 0
            AND (b.total_buy_shares - b.total_sell_shares) = 0 THEN 'fully_exited'
          ELSE NULL
        END AS closed_reason,
        CASE
          WHEN b.economic_observation->>'coverage' = 'complete'
            AND COALESCE(b.economic_observation->'closedPosition'->>'last_event_at', '') ~ '^[0-9]+$'
            THEN to_timestamp((b.economic_observation->'closedPosition'->>'last_event_at')::numeric)
          WHEN b.terminal_variants = 1 THEN b.resolved_at
          WHEN b.terminal_variants = 0 AND b.total_buy_shares > 0
            AND (b.total_buy_shares - b.total_sell_shares) = 0 THEN b.last_flow_at
          ELSE NULL
        END AS closed_at
      FROM event_authority b
      CROSS JOIN observer_summary observer
    ), classified AS MATERIALIZED (
      SELECT c.*,
        CASE WHEN c.terminal_zero_valuation THEN 0::numeric
          WHEN c.mark_available THEN c.current_value_usdc
          WHEN c.inventory_authoritative AND c.current_shares = 0 THEN 0::numeric
          ELSE NULL END AS effective_current_value_usdc
      FROM classified_raw c
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
      ((SELECT count(*)::int FROM classified WHERE history_complete IS NOT TRUE)
        + CASE WHEN ${mode} = 'paper' AND NOT (SELECT finance_complete FROM paper_coverage) THEN 1 ELSE 0 END) AS history_incomplete_count,
      (SELECT count(*)::int FROM wallet_identity) AS wallet_identity_count,
      (SELECT count(*)::int FROM fill_conflicted_keys) AS fill_identity_conflict_count,
      (SELECT count(*)::int FROM outcome_consensus WHERE terminal_variants > 1 OR payout_variants > 1) AS outcome_identity_conflict_count,
      (SELECT count(*)::int FROM current_facts WHERE current_identity_conflict) AS current_identity_conflict_count,
      (SELECT count(*)::int FROM classified
        WHERE NOT COALESCE(terminal_zero_valuation, false) AND (
          ((current_shares > 0 OR economic_bucket = 'live') AND NOT COALESCE(mark_available, false))
          OR (current_shares IS NOT NULL AND NOT inventory_authoritative))) AS missing_mark_count,
      observer.last_success_at AS observer_last_success_at,
      observer.status AS observer_status,
      observer.complete AS observer_complete,
      CASE
        WHEN (${mode} <> 'paper' OR (SELECT inventory_complete FROM paper_coverage))
          AND observer.status = 'ok' AND observer.complete
          AND observer.last_success_at <= ${params.capturedAt.toISOString()}::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM poly_trader_current_positions future
            JOIN wallet_identity w ON w.id = future.trader_wallet_id
            WHERE future.last_observed_at > ${params.capturedAt.toISOString()}::timestamptz
          )
          AND observer.last_success_at >= ${params.capturedAt.toISOString()}::timestamptz - INTERVAL '10 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM classified
            WHERE NOT COALESCE(terminal_zero_valuation, false) AND (
              ((current_shares > 0 OR economic_bucket = 'live') AND NOT COALESCE(mark_available, false))
              OR (current_shares IS NOT NULL AND NOT inventory_authoritative))
          )
        THEN (
          SELECT COALESCE(sum(effective_current_value_usdc), 0)
          FROM classified
          WHERE current_shares > 0 OR terminal_zero_valuation
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
      COALESCE(p.terminal_outcome, CASE WHEN p.history_complete
        THEN CASE p.economic_observation->'closedPosition'->>'current_price' WHEN '1' THEN 'winner' WHEN '0' THEN 'loser' END END) AS market_outcome,
      CASE
        WHEN p.terminal_outcome = 'winner' AND COALESCE(p.redeem_lifecycle_state, '')
          NOT IN ('winner', 'redeem_pending', 'redeemed', 'abandoned') THEN 'winner'
        WHEN p.terminal_outcome = 'loser' AND COALESCE(p.redeem_lifecycle_state, '')
          NOT IN ('loser', 'redeemed', 'dust', 'closed') THEN 'loser'
        ELSE COALESCE(p.redeem_lifecycle_state, p.position_lifecycle)
      END AS lifecycle_state,
      COALESCE(p.first_buy_at, p.current_first_observed_at, p.ledger_observed_at,
        CASE WHEN p.history_complete AND COALESCE(p.economic_observation->'closedPosition'->>'first_entry_at','') ~ '^[0-9]+$'
          THEN to_timestamp((p.economic_observation->'closedPosition'->>'first_entry_at')::numeric) END) AS opened_at,
      p.closed_at,
      COALESCE(p.current_last_observed_at, p.ledger_updated_at, p.last_flow_at) AS synced_at,
      CASE WHEN ${mode} = 'live' AND p.history_complete THEN (p.economic_observation->>'lifetimeBuyUsdc')::numeric
        ELSE COALESCE(p.total_buy_usdc, p.current_cost_basis_usdc) END AS total_buy_usdc,
      CASE WHEN ${mode} = 'live' AND p.history_complete THEN (p.economic_observation->>'lifetimeSellUsdc')::numeric
        ELSE COALESCE(p.total_sell_usdc, 0) END AS total_sell_usdc,
      CASE WHEN ${mode} = 'live' AND p.history_complete THEN (p.economic_observation->>'lifetimeBuyShares')::numeric
        ELSE COALESCE(p.total_buy_shares, p.current_shares) END AS total_buy_shares,
      COALESCE(p.total_buy_shares - p.total_sell_shares, p.current_shares) AS net_shares,
      p.effective_current_value_usdc AS current_value_usdc,
      COALESCE(
        CASE WHEN COALESCE(p.raw_cur_price, '') ~ '^[0-9]+(\\.[0-9]+)?$'
          THEN p.raw_cur_price::numeric END,
        p.last_price,
        p.current_avg_price
      ) AS current_price,
      p.current_shares,
      p.current_avg_price,
      p.current_cost_basis_usdc,
      p.current_unrealized_pnl,
      p.current_realized_pnl,
      p.current_last_observed_at,
      p.inventory_authoritative,
      p.inventory_fresh,
      p.economic_observation - 'constituents' AS economic_observation,
      jsonb_array_length(p.economic_observation->'constituents') AS economic_record_count,
      p.history_complete,
      CASE WHEN ${mode} = 'paper' AND p.history_complete THEN p.total_sell_usdc + p.current_value_usdc - p.total_buy_usdc - COALESCE(p.paper_fees_usdc, 0)
        WHEN COALESCE(p.economic_observation->>'lifetimePnlUsdc', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
        THEN (p.economic_observation->>'lifetimePnlUsdc')::numeric END AS observed_lifetime_pnl,
      p.current_identity_conflict,
      (p.mark_available OR p.terminal_zero_valuation) AS mark_available,
      p.terminal_zero_valuation,
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
  `),
  );

  const metadataKey = (row: EconomicRow): PositionMetadataKey => ({ conditionId: row.condition_id ?? "", tokenId: row.token_id ?? "", walletAddress: params.walletAddress, mode });
  const accountScope = { billingAccountId: params.billingAccountId };
  const metadata = await readPositionMetadata({ accountScope, db: params.db, keys: rows.map(metadataKey), capturedAt: params.capturedAt.toISOString() });
  const first = rows[0];
  const livePositions: WalletExecutionPosition[] = [];
  const closedPositions: WalletExecutionPosition[] = [];
  const positionFacts: EconomicPositionFact[] = [];
  const targetCorrelatedKeys = new Set<string>();
  for (const row of rows) {
    const fact = toEconomicFact(row, mode);
    if (fact) positionFacts.push(fact);
    const position = toPosition(row, params.capturedAt, mode);
    if (position === null) continue;
    if (row.target_correlated) targetCorrelatedKeys.add(position.positionId);
    const selectedPosition = { ...position, ...positionMetadataDisplay(metadata.get(positionMetadataRequestKey(metadataKey(row), accountScope) ?? "")) };
    if (row.economic_bucket === "live") livePositions.push(selectedPosition);
    if (row.economic_bucket === "closed") closedPositions.push(selectedPosition);
  }
  return {
    positionFacts,
    liveCount: nonnegativeInt(first?.live_count),
    closedCount: nonnegativeInt(first?.closed_count),
    incompleteCount: nonnegativeInt(first?.incomplete_count),
    historyIncompleteCount: nonnegativeInt(first?.history_incomplete_count),
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

function toEconomicFact(row: EconomicRow, mode: "live" | "paper"): EconomicPositionFact | null {
  if (!row.condition_id || !row.token_id) return null;
  const nullable = (value: string | number | null | undefined): number | null =>
    value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
  const authoritative = row.inventory_authoritative === true;
  const held = authoritative ? nullable(row.current_shares) : null;
  const currentValue = row.terminal_zero_valuation
    ? 0
    : authoritative && held === 0
      ? 0
      : row.mark_available
        ? nullable(row.current_value_usdc)
        : null;
  const basis = authoritative ? nullable(row.current_cost_basis_usdc) : null;
  const unrealized =
    row.mark_available && basis !== null && currentValue !== null
      ? (row.terminal_zero_valuation ? currentValue - basis : nullable(row.current_unrealized_pnl) ?? currentValue - basis)
      : null;
  const lifetime = row.history_complete ? nullable(row.observed_lifetime_pnl) : null;
  const realized = mode === "paper" && held === 0 && row.history_complete
    ? lifetime : nullable(row.current_realized_pnl);
  return {
    mode,
    conditionId: row.condition_id,
    tokenId: row.token_id,
    heldShares: held,
    currentValueUsdc: currentValue,
    remainingBasisUsdc: basis,
    unrealizedPnlUsdc: unrealized,
    realizedPnlUsdc: realized,
    lifetimePnlUsdc: lifetime,
    observedAt: iso(row.current_last_observed_at),
    quantitySource: authoritative
      ? mode === "paper"
        ? "paper_ledger"
        : "current_observation"
      : "unknown",
    basisSource: basis === null ? "unknown" : mode === "paper"
      ? row.history_complete ? "complete_history" : "unknown"
      : "vendor_current",
    inventoryCoverage: row.current_identity_conflict
      ? "conflict" : !authoritative ? "unavailable"
      : row.inventory_fresh && (row.mark_available || held === 0) ? "complete" : "stale",
    economicsCoverage: row.current_identity_conflict
      ? "conflict"
      : row.history_complete
        ? "complete"
        : "partial",
  };
}

/** Shared bounded saved-proof shape for previews and exact-condition investigation. */
export function toSavedEconomicProof(
  observation: Omit<EconomicObservationV1, "constituents">,
  complete: boolean,
  recordCount: number,
): NonNullable<WalletExecutionPosition["economicProof"]> {
  return {
    source: "native_activity" as const,
    coverage: complete ? ("complete" as const) : ("partial" as const),
    buyUsdc: observation.lifetimeBuyUsdc,
    buyShares: observation.lifetimeBuyShares,
    sellUsdc: observation.lifetimeSellUsdc,
    redeemUsdc: observation.redeemUsdc,
    lifetimePnlUsdc: complete ? observation.lifetimePnlUsdc : null,
    sourceRecordCount: recordCount,
    windowStart: observation.windowStart,
    windowEnd: observation.windowEnd,
    settlements: observation.settlements.map(
      ({
        txHash,
        blockNumber,
        logIndex,
        collateral,
        atomicAmount,
        conditionId,
        tokenId,
      }) => ({
        txHash,
        blockNumber,
        logIndex,
        collateral,
        atomicAmount,
        conditionId,
        tokenId,
      }),
    ),
  };
}

function toPosition(row: EconomicRow, capturedAt: Date, mode: "live" | "paper"): WalletExecutionPosition | null {
  if (row.economic_bucket === null || row.condition_id === null || row.token_id === null) {
    return null;
  }
  const buyUsdc = numberOf(row.total_buy_usdc);
  const sellUsdc = numberOf(row.total_sell_usdc);
  const buyShares = numberOf(row.total_buy_shares);
  const netShares = row.inventory_authoritative
    ? numberOf(row.current_shares)
    : numberOf(row.net_shares);
  if (buyUsdc <= 0 || buyShares <= 0 || netShares < 0) return null;
  const savedCurrentPrice = Math.max(
    0,
    numberOf(row.current_price) || numberOf(row.current_avg_price),
  );
  const fact = toEconomicFact(row, mode);
  const hasValuation = row.mark_available === true;
  const currentValue = row.terminal_zero_valuation
    ? 0
    : row.economic_bucket === "closed" &&
        row.history_complete &&
        !(numberOf(row.current_shares) > 0)
      ? 0
      : row.inventory_authoritative && numberOf(row.current_shares) === 0
      ? 0
      : hasValuation
        ? Math.max(0, numberOf(row.current_value_usdc))
        : null;
  const realized =
    row.history_complete && hasValuation
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
  const isUnredeemedWinner = row.market_outcome === "winner" && lifecycle !== "redeemed" &&
    !(row.history_complete && numberOf(row.economic_observation?.redeemUsdc) > 0);
  const status =
    row.economic_bucket === "live"
      ? ("open" as const)
      : isUnredeemedWinner
        ? ("redeemable" as const)
        : ("closed" as const);
  const lifetimeEntryPrice = buyShares > 0 ? buyUsdc / buyShares : 0;
  const entryPrice =
    row.economic_bucket === "live"
      ? row.inventory_authoritative &&
        numberOf(row.current_shares) > 0 &&
        row.current_cost_basis_usdc !== null
        ? numberOf(row.current_cost_basis_usdc) / numberOf(row.current_shares)
        : numberOf(row.current_avg_price) || lifetimeEntryPrice
      : lifetimeEntryPrice;
  const currentShares = Math.max(0, numberOf(row.current_shares));
  const pnlUsd =
    row.economic_bucket === "live"
      ? (fact?.unrealizedPnlUsdc ?? null)
      : (fact?.lifetimePnlUsdc ?? realized?.pnlUsd ?? null);
  const size =
    row.economic_bucket === "live" && currentShares > 0
      ? currentShares
      : row.economic_bucket === "live"
        ? netShares
        : buyShares;
  const currentPrice =
    row.economic_bucket === "closed"
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
      Math.floor(
        ((closedAt ? Date.parse(closedAt) : capturedAt.getTime()) - Date.parse(openedAt)) / 60_000,
      ),
    ),
    entryPrice: round(entryPrice, 8),
    currentPrice: currentPrice === null ? null : round(currentPrice, 8),
    size: round(size, 4),
    currentValue: currentValue === null ? null : round(currentValue, 2),
    pnlUsd: pnlUsd === null ? null : round(pnlUsd, 2),
    pnlPct: pnlUsd === null || !(row.economic_bucket === "closed" ? buyUsdc : numberOf(row.current_cost_basis_usdc))
      ? null : round(pnlUsd / (row.economic_bucket === "closed" ? buyUsdc : numberOf(row.current_cost_basis_usdc)) * 100, 2),
    syncedAt,
    syncAgeMs: syncedAt === null ? null : Math.max(0, capturedAt.getTime() - Date.parse(syncedAt)),
    syncStale: row.economic_bucket === "live" && !hasValuation,
    ...(row.economic_observation?.version === 1 ? {
      economicProof: toSavedEconomicProof(row.economic_observation, row.history_complete === true, numberOf(row.economic_record_count)),
    } : {}),
    timeline: [],
    events: [
      {
        ts: openedAt,
        kind: "entry",
        price: round(entryPrice, 8),
        shares: round(buyShares, 4),
      },
      ...(closedAt === null
        ? []
        : [
            {
              ts: closedAt,
              kind: "close" as const,
              price: round(currentPrice ?? 0, 8),
              shares: round(size, 4),
            },
          ]),
    ],
  };
}

function normalizeLifecycle(value: string | null): WalletExecutionLifecycleState | null {
  const allowed = new Set<WalletExecutionLifecycleState>([
    "unresolved",
    "open",
    "closing",
    "closed",
    "resolving",
    "winner",
    "redeem_pending",
    "redeemed",
    "loser",
    "dust",
    "abandoned",
  ]);
  return value !== null && allowed.has(value as WalletExecutionLifecycleState)
    ? (value as WalletExecutionLifecycleState)
    : null;
}

function normalizeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
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

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-db-schema/trader-activity`
 * Purpose: Operational read-model tables for continuously observed Polymarket trader wallets — fills, position snapshots, current positions, attribution, market outcomes, user-pnl time-series, and per-asset market price history.
 * Scope: Drizzle table definitions only. Runtime observation, attribution, and UI aggregation live in the app.
 * Invariants:
 *   - SAME_OBSERVED_TRADE_TABLE: copy-target and Cogni wallet public trades share `poly_trader_fills`.
 *   - OBSERVATION_INDEPENDENT_OF_COPYING: `active_for_research` is research state, not copy-trade policy.
 *   - NO_FULL_HISTORY_CRAWL: ingestion cursors store forward watermarks; historical backfill is a separate v2 concern.
 *   - PNL_TIMESERIES_KEYED_BY_FIDELITY: `poly_trader_user_pnl_points` PK is `(trader_wallet_id, fidelity, ts)`; reader picks `1h` for short windows, `1d` for long.
 *   - PRICE_HISTORY_TIMESERIES_KEYED: `poly_market_price_history` PK is `(asset, fidelity, ts)`; reader picks `1h` for windows up to ~1 month, `1d` for longer.
 * Side-effects: none
 * Links: docs/spec/poly-copy-trade-execution.md, work/items/task.5005, work/items/task.5012, work/items/task.5018
 * @public
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const polyTraderWallets = pgTable(
  "poly_trader_wallets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    walletAddress: text("wallet_address").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    activeForResearch: boolean("active_for_research").notNull().default(true),
    firstObservedAt: timestamp("first_observed_at", {
      withTimezone: true,
    }).defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "poly_trader_wallets_wallet_shape",
      sql`${table.walletAddress} ~ '^0x[a-fA-F0-9]{40}$'`
    ),
    check(
      "poly_trader_wallets_kind_check",
      sql`${table.kind} IN ('copy_target','cogni_wallet')`
    ),
    uniqueIndex("poly_trader_wallets_wallet_address_idx").on(
      table.walletAddress
    ),
    index("poly_trader_wallets_observe_idx").on(
      table.activeForResearch,
      table.disabledAt
    ),
  ]
);

export const polyTraderIngestionCursors = pgTable(
  "poly_trader_ingestion_cursors",
  {
    traderWalletId: uuid("trader_wallet_id")
      .notNull()
      .references(() => polyTraderWallets.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastSeenNativeId: text("last_seen_native_id"),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.traderWalletId, table.source] }),
    check(
      "poly_trader_ingestion_cursors_source_check",
      sql`${table.source} IN ('data-api','data-api-trades','data-api-positions','clob-ws')`
    ),
    check(
      "poly_trader_ingestion_cursors_status_check",
      sql`${table.status} IN ('pending','ok','partial','stale','error')`
    ),
    index("poly_trader_ingestion_cursors_status_idx").on(table.status),
  ]
);

export const polyTraderFills = pgTable(
  "poly_trader_fills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    traderWalletId: uuid("trader_wallet_id")
      .notNull()
      .references(() => polyTraderWallets.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    nativeId: text("native_id").notNull(),
    conditionId: text("condition_id").notNull(),
    tokenId: text("token_id").notNull(),
    side: text("side").notNull(),
    price: numeric("price", { precision: 18, scale: 8 }).notNull(),
    shares: numeric("shares", { precision: 20, scale: 8 }).notNull(),
    sizeUsdc: numeric("size_usdc", { precision: 20, scale: 8 }).notNull(),
    txHash: text("tx_hash"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "poly_trader_fills_source_check",
      sql`${table.source} IN ('data-api','clob-ws')`
    ),
    check("poly_trader_fills_side_check", sql`${table.side} IN ('BUY','SELL')`),
    check("poly_trader_fills_price_positive", sql`${table.price} > 0`),
    check("poly_trader_fills_shares_positive", sql`${table.shares} > 0`),
    check("poly_trader_fills_size_positive", sql`${table.sizeUsdc} > 0`),
    uniqueIndex("poly_trader_fills_trader_source_native_idx").on(
      table.traderWalletId,
      table.source,
      table.nativeId
    ),
    index("poly_trader_fills_trader_observed_idx").on(
      table.traderWalletId,
      table.observedAt
    ),
    index("poly_trader_fills_market_token_idx").on(
      table.conditionId,
      table.tokenId
    ),
    // Cross-wallet time-window scans: market-outcome tick (last-30d condition
    // enumeration) and price-history tick (last-7d asset enumeration) filter
    // on observed_at alone, with no trader_wallet_id predicate.
    index("poly_trader_fills_observed_at_idx").on(table.observedAt),
    // Rollup-writer batch walk + reader tail scans
    // (task.research-rollup-read-models): the incremental fill-rollup
    // accumulator orders NEW fills by insertion key `(created_at, id)` per
    // wallet, and the rollup-backed readers scan the not-yet-rolled tail with
    // `(created_at, id) > (watermark_ts, watermark_id)`. Row-constructor
    // comparisons are btree-servable only with this exact column order.
    index("poly_trader_fills_trader_created_idx").on(
      table.traderWalletId,
      table.createdAt,
      table.id
    ),
  ]
);

/**
 * Incremental per-(wallet, market, token, UTC-day) rollup of
 * `poly_trader_fills`, written ONLY by the fill-rollup accumulator inside the
 * trader-observation tick (plus the boot backfill walker that reuses the same
 * accumulate function). One row per (trader_wallet_id, condition_id, token_id,
 * day-of-observed_at-UTC) carrying additive sums/counts and monotone
 * MIN/MAX observation bounds, so research readers aggregate O(unique
 * position-days) rows instead of O(fills) (task.research-rollup-read-models;
 * the 25-60s full-history scans measured on prod 2026-09-28).
 *
 * Idempotency contract: rows are only ever advanced through the accumulate
 * upsert (`fill_count = fill_count + EXCLUDED.fill_count`, LEAST/GREATEST for
 * the observation bounds) inside the same transaction that moves the wallet's
 * `poly_trader_fill_rollup_cursors` watermark — a fill is counted exactly once
 * or the whole batch rolls back.
 *
 * No tenant FK → no RLS, matching the other `poly_trader_*` observation
 * tables.
 *
 * @public
 */
export const polyTraderFillRollupsDaily = pgTable(
  "poly_trader_fill_rollups_daily",
  {
    traderWalletId: uuid("trader_wallet_id")
      .notNull()
      .references(() => polyTraderWallets.id, { onDelete: "cascade" }),
    conditionId: text("condition_id").notNull(),
    tokenId: text("token_id").notNull(),
    /** UTC calendar day of `poly_trader_fills.observed_at`. */
    day: date("day").notNull(),
    fillCount: integer("fill_count").notNull(),
    buyCount: integer("buy_count").notNull(),
    sellCount: integer("sell_count").notNull(),
    buyUsdc: numeric("buy_usdc", { precision: 20, scale: 8 }).notNull(),
    sellUsdc: numeric("sell_usdc", { precision: 20, scale: 8 }).notNull(),
    buyShares: numeric("buy_shares", { precision: 20, scale: 8 }).notNull(),
    sellShares: numeric("sell_shares", { precision: 20, scale: 8 }).notNull(),
    /** Earliest BUY fill observed this day; NULL when the day has no BUYs. */
    firstBuyObservedAt: timestamp("first_buy_observed_at", {
      withTimezone: true,
    }),
    firstObservedAt: timestamp("first_observed_at", {
      withTimezone: true,
    }).notNull(),
    lastObservedAt: timestamp("last_observed_at", {
      withTimezone: true,
    }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.traderWalletId, table.conditionId, table.tokenId, table.day],
    }),
    check(
      "poly_trader_fill_rollups_daily_counts_nonnegative",
      sql`${table.fillCount} >= 0 AND ${table.buyCount} >= 0 AND ${table.sellCount} >= 0`
    ),
    check(
      "poly_trader_fill_rollups_daily_sums_nonnegative",
      sql`${table.buyUsdc} >= 0 AND ${table.sellUsdc} >= 0 AND ${table.buyShares} >= 0 AND ${table.sellShares} >= 0`
    ),
    // Windowed readers (benchmark 1D/1W/1M, overlap, comparison summary)
    // range-scan `trader_wallet_id = $1 AND day >= $2`; the PK leads with
    // wallet but buries `day` last, so the range needs its own prefix.
    index("poly_trader_fill_rollups_daily_wallet_day_idx").on(
      table.traderWalletId,
      table.day
    ),
    // trader-comparison token flows: `trader_wallet_id = $1 AND token_id IN
    // (windowed tokens)` GROUP BY token_id — narrow windows probe a small
    // token set directly instead of scanning every wallet rollup row.
    index("poly_trader_fill_rollups_daily_wallet_token_idx").on(
      table.traderWalletId,
      table.tokenId
    ),
  ]
);

/**
 * Per-wallet watermark for the fill-rollup accumulator. `(last_created_at,
 * last_fill_id)` is the insertion key of the LAST `poly_trader_fills` row
 * folded into `poly_trader_fill_rollups_daily`; fills with a strictly greater
 * `(created_at, id)` tuple are not yet rolled up (readers treat them as the
 * live "tail"). The row is advanced only inside the accumulate transaction
 * (SELECT ... FOR UPDATE serializes concurrent accumulators per wallet);
 * `last_fill_id` defaults to the zero UUID so tuple comparisons never see
 * NULL. Soundness of the watermark depends on per-wallet fills writers being
 * serialized (single observation tick, guard held until writers settle —
 * bug.5297), which makes `created_at` (= insert-transaction start time)
 * monotone per wallet across commits.
 *
 * @public
 */
export const polyTraderFillRollupCursors = pgTable(
  "poly_trader_fill_rollup_cursors",
  {
    traderWalletId: uuid("trader_wallet_id")
      .primaryKey()
      .references(() => polyTraderWallets.id, { onDelete: "cascade" }),
    lastCreatedAt: timestamp("last_created_at", { withTimezone: true })
      .notNull()
      .default(sql`'epoch'::timestamptz`),
    lastFillId: uuid("last_fill_id")
      .notNull()
      .default(sql`'00000000-0000-0000-0000-000000000000'::uuid`),
    /** Lifetime count of fills folded in — observability only. */
    rolledFillCount: bigint("rolled_fill_count", { mode: "number" })
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  }
);

export const polyTraderPositionSnapshots = pgTable(
  "poly_trader_position_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    traderWalletId: uuid("trader_wallet_id")
      .notNull()
      .references(() => polyTraderWallets.id, { onDelete: "cascade" }),
    conditionId: text("condition_id").notNull(),
    tokenId: text("token_id").notNull(),
    shares: numeric("shares", { precision: 20, scale: 8 }).notNull(),
    costBasisUsdc: numeric("cost_basis_usdc", {
      precision: 20,
      scale: 8,
    }).notNull(),
    currentValueUsdc: numeric("current_value_usdc", {
      precision: 20,
      scale: 8,
    }).notNull(),
    avgPrice: numeric("avg_price", { precision: 18, scale: 8 }).notNull(),
    contentHash: text("content_hash").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
  },
  (table) => [
    check(
      "poly_trader_position_snapshots_shares_nonnegative",
      sql`${table.shares} >= 0`
    ),
    check(
      "poly_trader_position_snapshots_cost_nonnegative",
      sql`${table.costBasisUsdc} >= 0`
    ),
    check(
      "poly_trader_position_snapshots_value_nonnegative",
      sql`${table.currentValueUsdc} >= 0`
    ),
    uniqueIndex("poly_trader_position_snapshots_hash_idx").on(
      table.traderWalletId,
      table.conditionId,
      table.tokenId,
      table.contentHash
    ),
    index("poly_trader_position_snapshots_latest_idx").on(
      table.traderWalletId,
      table.capturedAt
    ),
    // market-exposure `readTargetLegs`: DISTINCT ON (trader_wallet_id,
    // condition_id, token_id) … ORDER BY captured_at DESC, driven by a
    // `condition_id IN (…)` page filter. condition_id leads because the
    // wallet-led prefix already exists on the `_hash_idx` unique index;
    // trailing captured_at DESC serves each group's newest-first read.
    index("poly_trader_position_snapshots_market_latest_idx").on(
      table.conditionId,
      table.traderWalletId,
      table.tokenId,
      table.capturedAt.desc()
    ),
    // Retention pruner (task.5012): the candidate scan is a bare
    // `captured_at < cutoff` with no wallet/condition predicate. Neither
    // `_latest_idx` (trader_wallet_id-led) nor `_market_latest_idx`
    // (condition_id-led) can serve a leading captured_at range, so without
    // this the every-30s prune check seq-scans the whole table.
    index("poly_trader_position_snapshots_captured_at_idx").on(
      table.capturedAt
    ),
  ]
);

export const polyTraderCurrentPositions = pgTable(
  "poly_trader_current_positions",
  {
    traderWalletId: uuid("trader_wallet_id")
      .notNull()
      .references(() => polyTraderWallets.id, { onDelete: "cascade" }),
    conditionId: text("condition_id").notNull(),
    tokenId: text("token_id").notNull(),
    active: boolean("active").notNull().default(true),
    shares: numeric("shares", { precision: 20, scale: 8 }).notNull(),
    costBasisUsdc: numeric("cost_basis_usdc", {
      precision: 20,
      scale: 8,
    }).notNull(),
    currentValueUsdc: numeric("current_value_usdc", {
      precision: 20,
      scale: 8,
    }).notNull(),
    avgPrice: numeric("avg_price", { precision: 18, scale: 8 }).notNull(),
    contentHash: text("content_hash").notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
  },
  (table) => [
    primaryKey({
      columns: [table.traderWalletId, table.conditionId, table.tokenId],
    }),
    check(
      "poly_trader_current_positions_shares_nonnegative",
      sql`${table.shares} >= 0`
    ),
    check(
      "poly_trader_current_positions_cost_nonnegative",
      sql`${table.costBasisUsdc} >= 0`
    ),
    check(
      "poly_trader_current_positions_value_nonnegative",
      sql`${table.currentValueUsdc} >= 0`
    ),
    index("poly_trader_current_positions_active_idx").on(
      table.traderWalletId,
      table.active,
      table.currentValueUsdc
    ),
    index("poly_trader_current_positions_market_idx").on(
      table.conditionId,
      table.tokenId
    ),
    // Cross-wallet `active = true` scans (price-history asset enumeration,
    // metadata projector, and the live-position staleness predicate's
    // `last_observed_at >= NOW() - 6h` range). Partial on active=true so the
    // index stays small as terminal rows accumulate.
    index("poly_trader_current_positions_active_observed_idx")
      .on(table.lastObservedAt)
      .where(sql`${table.active} = true`),
  ]
);

export const polyCopyTradeAttribution = pgTable(
  "poly_copy_trade_attribution",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    targetTraderWalletId: uuid("target_trader_wallet_id")
      .notNull()
      .references(() => polyTraderWallets.id, { onDelete: "cascade" }),
    cogniTraderWalletId: uuid("cogni_trader_wallet_id").references(
      () => polyTraderWallets.id,
      { onDelete: "set null" }
    ),
    targetFillId: uuid("target_fill_id").references(() => polyTraderFills.id, {
      onDelete: "set null",
    }),
    cogniFillId: uuid("cogni_fill_id").references(() => polyTraderFills.id, {
      onDelete: "set null",
    }),
    copyTradeTargetId: uuid("copy_trade_target_id"),
    copyTradeFillId: text("copy_trade_fill_id"),
    copyTradeDecisionId: uuid("copy_trade_decision_id"),
    conditionId: text("condition_id").notNull(),
    tokenId: text("token_id").notNull(),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    targetVwap: numeric("target_vwap", { precision: 18, scale: 8 }),
    cogniVwap: numeric("cogni_vwap", { precision: 18, scale: 8 }),
    targetSizeUsdc: numeric("target_size_usdc", { precision: 20, scale: 8 }),
    cogniSizeUsdc: numeric("cogni_size_usdc", { precision: 20, scale: 8 }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
  },
  (table) => [
    check(
      "poly_copy_trade_attribution_status_check",
      sql`${table.status} IN ('copied','partial','missed','resting','skipped','error','no_response_yet')`
    ),
    index("poly_copy_trade_attribution_target_window_idx").on(
      table.targetTraderWalletId,
      table.windowStart,
      table.windowEnd
    ),
    index("poly_copy_trade_attribution_market_idx").on(
      table.conditionId,
      table.tokenId
    ),
  ]
);

export const polyTraderUserPnlPoints = pgTable(
  "poly_trader_user_pnl_points",
  {
    traderWalletId: uuid("trader_wallet_id")
      .notNull()
      .references(() => polyTraderWallets.id, { onDelete: "cascade" }),
    fidelity: text("fidelity").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    pnlUsdc: numeric("pnl_usdc", { precision: 20, scale: 8 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.traderWalletId, table.fidelity, table.ts] }),
    check(
      "poly_trader_user_pnl_points_fidelity_check",
      sql`${table.fidelity} IN ('1h','1d')`
    ),
  ]
);

export const polyMarketOutcomes = pgTable(
  "poly_market_outcomes",
  {
    conditionId: text("condition_id").notNull(),
    tokenId: text("token_id").notNull(),
    outcome: text("outcome").notNull(),
    payout: numeric("payout", { precision: 18, scale: 8 }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.conditionId, table.tokenId] }),
    check(
      "poly_market_outcomes_outcome_check",
      sql`${table.outcome} IN ('winner','loser','unknown')`
    ),
  ]
);

/**
 * Cached Polymarket market metadata. One row per `condition_id`. Written by
 * the trader-observation tick as a SQL projection of
 * `poly_trader_current_positions.raw` (the `/positions` JSONB we already
 * poll). Readers JOIN here for `endDate`, titles, and slugs instead of
 * scraping the position JSONB directly. Single-source-of-truth for market
 * metadata across the dashboard.
 *
 * Note: `event_title` is currently always NULL — `/positions` exposes
 * `eventSlug`/`eventId` but not `eventTitle`. Populating it requires a
 * follow-up event-id-keyed metadata source.
 *
 * @public
 */
export const polyMarketMetadata = pgTable(
  "poly_market_metadata",
  {
    /** Polymarket conditionId; same shape used across all poly tables. */
    conditionId: text("condition_id").primaryKey(),
    eventTitle: text("event_title"),
    eventSlug: text("event_slug"),
    marketTitle: text("market_title"),
    marketSlug: text("market_slug"),
    /** Market resolution time. Null for markets without a fixed close. */
    endDate: timestamp("end_date", { withTimezone: true }),
    /** Full position blob preserved for forward-compatible field access. */
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    /** Wall-clock time of the most recent projection. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("poly_market_metadata_event_slug_idx").on(table.eventSlug),
    index("poly_market_metadata_end_date_idx").on(table.endDate),
  ]
);

/**
 * Observation read-model for the dashboard/research "Top Wallets" leaderboard
 * (bug.5017). One row per `(time_period, order_by, wallet_address)` — the
 * Polymarket `/v1/leaderboard` entry plus the `/trades`-count enrichment the
 * UI consumes. Written only by the top-wallet-stats tick; page-load reads go
 * through `readTopTradersFromDb` (PAGE_LOAD_DB_ONLY). No tenant FK → no RLS,
 * matching the other `poly_trader_*` / `poly_market_*` observation tables.
 * `raw` preserves the full vendor leaderboard entry per the
 * persist-the-payload rule.
 *
 * @public
 */
export const polyTopWalletStats = pgTable(
  "poly_top_wallet_stats",
  {
    /** Leaderboard window: DAY / WEEK / MONTH / ALL. */
    timePeriod: text("time_period").notNull(),
    /** Leaderboard sort metric: PNL / VOL. */
    orderBy: text("order_by").notNull(),
    /** On-chain Polygon proxy-wallet address (0x…40 hex). */
    walletAddress: text("wallet_address").notNull(),
    /** 1-indexed rank within this (time_period, order_by) board. */
    rank: integer("rank").notNull(),
    /** Vendor username; empty string when unset (reader falls back to address). */
    userName: text("user_name").notNull().default(""),
    volumeUsdc: numeric("volume_usdc", { precision: 20, scale: 8 }).notNull(),
    pnlUsdc: numeric("pnl_usdc", { precision: 20, scale: 8 }).notNull(),
    /** Derived at write time: pnl/vol*100; NULL when volume is 0. */
    roiPct: numeric("roi_pct", { precision: 18, scale: 8 }),
    /** `/trades?user=…&limit=500` count; lower bound when capped. */
    numTrades: integer("num_trades").notNull().default(0),
    /** True when the /trades pagination cap was hit — actual count ≥ numTrades. */
    numTradesCapped: boolean("num_trades_capped").notNull().default(false),
    /** Polymarket verified-badge flag. */
    verified: boolean("verified").notNull().default(false),
    /** Full vendor leaderboard entry preserved for forward-compatible access. */
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    /** Wall-clock time of the most recent refresh for this row. */
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.timePeriod, table.orderBy, table.walletAddress],
    }),
    check(
      "poly_top_wallet_stats_time_period_check",
      sql`${table.timePeriod} IN ('DAY','WEEK','MONTH','ALL')`
    ),
    check(
      "poly_top_wallet_stats_order_by_check",
      sql`${table.orderBy} IN ('PNL','VOL')`
    ),
    check(
      "poly_top_wallet_stats_wallet_shape",
      sql`${table.walletAddress} ~ '^0x[a-fA-F0-9]{40}$'`
    ),
    check("poly_top_wallet_stats_rank_positive", sql`${table.rank} > 0`),
    // Read path: WHERE (time_period, order_by) ORDER BY rank LIMIT n.
    index("poly_top_wallet_stats_board_rank_idx").on(
      table.timePeriod,
      table.orderBy,
      table.rank
    ),
  ]
);

export const polyMarketPriceHistory = pgTable(
  "poly_market_price_history",
  {
    asset: text("asset").notNull(),
    fidelity: text("fidelity").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    price: numeric("price", { precision: 18, scale: 8 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.asset, table.fidelity, table.ts] }),
    check(
      "poly_market_price_history_fidelity_check",
      sql`${table.fidelity} IN ('1h','1d')`
    ),
  ]
);

export type PolyTraderWallet = typeof polyTraderWallets.$inferSelect;
export type NewPolyTraderWallet = typeof polyTraderWallets.$inferInsert;
export type PolyTraderFill = typeof polyTraderFills.$inferSelect;
export type NewPolyTraderFill = typeof polyTraderFills.$inferInsert;
export type PolyTraderFillRollupDaily =
  typeof polyTraderFillRollupsDaily.$inferSelect;
export type NewPolyTraderFillRollupDaily =
  typeof polyTraderFillRollupsDaily.$inferInsert;
export type PolyTraderFillRollupCursor =
  typeof polyTraderFillRollupCursors.$inferSelect;
export type NewPolyTraderFillRollupCursor =
  typeof polyTraderFillRollupCursors.$inferInsert;
export type PolyTraderPositionSnapshot =
  typeof polyTraderPositionSnapshots.$inferSelect;
export type NewPolyTraderPositionSnapshot =
  typeof polyTraderPositionSnapshots.$inferInsert;
export type PolyTraderCurrentPosition =
  typeof polyTraderCurrentPositions.$inferSelect;
export type NewPolyTraderCurrentPosition =
  typeof polyTraderCurrentPositions.$inferInsert;
export type PolyTraderUserPnlPoint =
  typeof polyTraderUserPnlPoints.$inferSelect;
export type NewPolyTraderUserPnlPoint =
  typeof polyTraderUserPnlPoints.$inferInsert;
export type PolyMarketPriceHistoryPoint =
  typeof polyMarketPriceHistory.$inferSelect;
export type NewPolyMarketPriceHistoryPoint =
  typeof polyMarketPriceHistory.$inferInsert;
export type PolyMarketMetadata = typeof polyMarketMetadata.$inferSelect;
export type NewPolyMarketMetadata = typeof polyMarketMetadata.$inferInsert;
export type PolyTopWalletStat = typeof polyTopWalletStats.$inferSelect;
export type NewPolyTopWalletStat = typeof polyTopWalletStats.$inferInsert;

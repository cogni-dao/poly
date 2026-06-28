// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema/copy-trade`
 * Purpose: Schema for the Polymarket copy-trade prototype — tracked-wallet records (tenant-scoped),
 *          fills ledger, append-only decisions log.
 * Scope: Poly-local table definitions. Does not contain queries, RLS policies, or runtime logic.
 *        RLS policies live in the SQL migration alongside `ENABLE ROW LEVEL SECURITY`.
 * Invariants:
 *   - TENANT_SCOPED_ROWS: every row has `billing_account_id NOT NULL` (data column, FK → billing_accounts) +
 *     `created_by_user_id NOT NULL` (RLS key, FK → users). Mirrors the `connections` pattern from migration 0025.
 *   - FILL_ID_SHAPE_DECIDED: composite `<source>:<native_id>` per task.0315 P0.2, enforced by CHECK.
 *   - IDEMPOTENT_BY_CLIENT_ID: `client_order_id = clientOrderIdFor(billing_account_id, target_id, fill_id)` (pinned helper).
 *   - NO_PER_TARGET_ENABLED: `poly_copy_trade_targets` has no per-row enable flag. Operators add/remove rows.
 *   - NO_KILL_SWITCH (bug.0438): copy-trade has no per-tenant kill-switch table. Active target row +
 *     active wallet connection + active grant is the gate; explicit user opt-in (POST a target) is the
 *     only signal. Target rows own the mirror filter percentile and per-target max bet; grants still
 *     enforce downstream tenant authorization/caps.
 *   - FILLS_HAVE_REALIZED_COLUMNS (bug.5018): `poly_copy_trade_fills` carries first-class
 *     `price` / `shares` / `fees_usdc` columns alongside `mode`, populated on post-place
 *     UPDATE by `order-ledger.markOrderId`. NULL pre-fill or for legacy paper rows that
 *     pre-date bug.5018 (forward-only — no backfill). `WHERE price IS NOT NULL` discriminates
 *     post-fix rows; PnL/VWAP aggregations read column data, not JSONB.
 * Side-effects: none (schema definitions only)
 * Links: docs/spec/poly-tenant-and-collateral.md, work/items/task.0318,
 *   docs/spec/poly-paper-trading-shortcomings.md (bug.5018 — S3/S4 closed)
 * @public
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Tracked Polymarket wallets the operator is mirroring. One row per (tenant, target_wallet)
 * — disabling is a soft-delete via `disabled_at`, never a hard DELETE (preserves attribution
 * history in the fills ledger).
 *
 * @public
 */
export const polyCopyTradeTargets = pgTable(
  "poly_copy_trade_targets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Tenant data column. FK → billing_accounts.id. */
    billingAccountId: text("billing_account_id").notNull(),
    /** RLS key column. Authenticated user that owns this tracking record. */
    createdByUserId: text("created_by_user_id").notNull(),
    /** 0x-prefixed 40-hex Polymarket EOA being followed. */
    targetWallet: text("target_wallet").notNull(),
    /** Target-wallet percentile floor for copy sizing. */
    mirrorFilterPercentile: integer("mirror_filter_percentile")
      .notNull()
      .default(75),
    /** Per-target mirror max. Accepted p100-size fills map to this notional. */
    mirrorMaxUsdcPerTrade: numeric("mirror_max_usdc_per_trade", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("5.00"),
    /**
     * Per-target sizing-policy kind. `'auto'` (default) preserves legacy
     * behavior: `buildSizingPolicy` infers `target_percentile_scaled` when a
     * curated wallet snapshot exists, else `min_bet`. Explicit kinds let
     * users/AI pin a target to a specific policy. The discriminated union
     * lives in `SizingPolicySchema` (poly/app features/copy-trade/types.ts);
     * adding a new variant means appending here AND there. See spec:
     * docs/spec/poly-copy-trade-position-mirror.md (Phase 1).
     */
    sizingPolicyKind: text("sizing_policy_kind").notNull().default("auto"),
    /** task.5014 — assumed per-condition position ceiling for `position_gap`. See docs/research/poly/range-relative-mirror-2026-05-26.md. */
    targetRangeMaxUsdc: numeric("target_range_max_usdc", {
      precision: 12,
      scale: 2,
    }),
    /** task.5014 — per-condition USDC cap for `position_gap`. */
    mirrorMaxAllocPerConditionUsdc: numeric(
      "mirror_max_alloc_per_condition_usdc",
      {
        precision: 10,
        scale: 2,
      }
    ),
    /** task.5014 — cold-start fence; defines "first post-activation fill" for the baseline snapshot in `poly_copy_target_condition_baseline`. */
    mirrorActivatedAt: timestamp("mirror_activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Soft-delete tombstone. NULL = active. */
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "poly_copy_trade_targets_wallet_shape",
      sql`${table.targetWallet} ~ '^0x[a-fA-F0-9]{40}$'`
    ),
    check(
      "poly_copy_trade_targets_filter_percentile_range",
      sql`${table.mirrorFilterPercentile} >= 50 AND ${table.mirrorFilterPercentile} <= 99`
    ),
    check(
      "poly_copy_trade_targets_max_bet_positive",
      sql`${table.mirrorMaxUsdcPerTrade} > 0`
    ),
    check(
      "poly_copy_trade_targets_sizing_policy_kind_check",
      sql`${table.sizingPolicyKind} IN ('auto','min_bet','target_percentile_scaled','position_gap','mirror_fill_exact')`
    ),
    check(
      "poly_copy_trade_targets_range_max_positive",
      sql`${table.targetRangeMaxUsdc} IS NULL OR ${table.targetRangeMaxUsdc} > 0`
    ),
    check(
      "poly_copy_trade_targets_alloc_per_condition_positive",
      sql`${table.mirrorMaxAllocPerConditionUsdc} IS NULL OR ${table.mirrorMaxAllocPerConditionUsdc} > 0`
    ),
    // task.5014: active position_gap rows need both range knobs. Disabled rows
    // are grandfathered (legacy Σ-book rows can keep their stale state under
    // disabled_at without violating the new shape).
    check(
      "poly_copy_trade_targets_position_gap_requires_range_knobs",
      sql`${table.sizingPolicyKind} <> 'position_gap' OR ${table.disabledAt} IS NOT NULL OR (${table.targetRangeMaxUsdc} IS NOT NULL AND ${table.mirrorMaxAllocPerConditionUsdc} IS NOT NULL)`
    ),
    // One active row per (tenant, wallet). Soft-deleted rows allowed to coexist
    // so a previously-disabled wallet can be re-added without violating uniqueness.
    uniqueIndex("poly_copy_trade_targets_billing_wallet_active_idx")
      .on(table.billingAccountId, table.targetWallet)
      .where(sql`${table.disabledAt} IS NULL`),
    index("poly_copy_trade_targets_billing_account_idx").on(
      table.billingAccountId
    ),
  ]
);

/**
 * Observed fills from tracked target wallets + their mirror placement state.
 * Composite PK `(billing_account_id, target_id, fill_id)` is the per-tenant dedupe gate.
 * `target_id` is `uuidv5(target_wallet)` — deterministic and SHARED across tenants —
 * so N tenants mirroring the same wallet's same fill each get their own row.
 *
 * `client_order_id` is deterministic from `(billing_account_id, target_id, fill_id)`
 * per IDEMPOTENT_BY_CLIENT_ID — see `clientOrderIdFor` in `@cogni/poly-market-provider`.
 */
export const polyCopyTradeFills = pgTable(
  "poly_copy_trade_fills",
  {
    /** Tenant data column. */
    billingAccountId: text("billing_account_id").notNull(),
    /** RLS key column. */
    createdByUserId: text("created_by_user_id").notNull(),
    /** P1: synthetic UUID per env target wallet. P2+: target row id. */
    targetId: uuid("target_id").notNull(),
    /** Composite `"<source>:<native_id>"` per FILL_ID_SHAPE_DECIDED. */
    fillId: text("fill_id").notNull(),
    /**
     * Polymarket conditionId of the market this fill belongs to. Promoted from
     * `attributes->>'market_id'` to a real column in task.5001 so the partial
     * unique index `(billing_account_id, target_id, market_id) WHERE status IN
     * (pending,open,partial)` can enforce DEDUPE_AT_DB — exactly one resting
     * mirror order per (tenant, target, market). Backfilled from the existing
     * `attributes` JSONB at migration time.
     */
    marketId: text("market_id").notNull(),
    /** ISO timestamp the fill was observed (match-time for WS, settlement-time for DA). */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    /** Deterministic from `(billing_account_id, target_id, fill_id)` — see IDEMPOTENT_BY_CLIENT_ID. */
    clientOrderId: text("client_order_id").notNull(),
    /** Platform-assigned order id. Non-null iff the mirror order was placed. */
    orderId: text("order_id"),
    /** Canonical OrderStatus: pending | open | filled | partial | canceled | error. */
    status: text("status").notNull(),
    /**
     * Position lifecycle for rows that have or had wallet exposure. NULL means
     * the order row has not produced position exposure yet.
     */
    positionLifecycle: text("position_lifecycle"),
    /** Provenance + mirror amount + raw normalized fill for debugging. */
    attributes: jsonb("attributes").$type<Record<string, unknown>>(),
    /**
     * Timestamp of the last reconciler tick that received a typed CLOB response
     * (found OR not_found) for this row. NULL until the reconciler first checks
     * this order. Written by `markSynced` — never by the placement path.
     */
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    /**
     * Execution mode of the order that produced this fill. Stamped at write
     * time by `order-ledger.ts::insertPending` from the ledger's
     * `paperEnforceMode` dep, which the bootstrap resolves once from
     * `PAPER_ENFORCE_MODE` env. Answers exactly one question correctly:
     * "where did this order execute?" Paper rows participate in cap
     * accounting (CAP_COUNTS_REALIZED_ON_CANCEL) identically to live rows;
     * the paper sidecar populates `filled_size_usdc` correctly.
     * See MODE_STAMPED_AT_LEDGER_FROM_ENV (order-ledger.ts) + pair invariant
     * PAPER_DISPATCH_IS_ENV_ONLY (poly-trade-executor.ts).
     */
    mode: text("mode").notNull().default("live"),
    /**
     * Realized fill VWAP (USDC / shares). Populated on post-place UPDATE
     * once a fill is observed; NULL for pre-fill rows. Same precision as
     * `poly_trader_fills.price`. Post-fix paper rows are discriminated by
     * `price IS NOT NULL` — see bug.5018 discontinuity note (forward-only,
     * no backfill of legacy paper rows that pre-date the realized-fill wire).
     */
    price: numeric("price", { precision: 18, scale: 8 }),
    /**
     * Realized shares filled (cumulative across matched levels). Same
     * precision as `poly_trader_fills.shares`. NULL until fill observed.
     */
    shares: numeric("shares", { precision: 20, scale: 8 }),
    /**
     * Realized fees in USDC at fill time. Often 0 on prod Polymarket; the
     * paper-trader sidecar populates this from its fee model. NULL until
     * fill observed.
     */
    feesUsdc: numeric("fees_usdc", { precision: 20, scale: 8 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.billingAccountId, table.targetId, table.fillId],
    }),
    // Dashboard card query: `SELECT ... ORDER BY observed_at DESC LIMIT 50`.
    index("poly_copy_trade_fills_observed_at_idx").on(table.observedAt),
    // `client_order_id` is unique-by-construction across all rows (deterministic
    // from the PK pair); index lets the executor detect repeat submits.
    index("poly_copy_trade_fills_client_order_id_idx").on(table.clientOrderId),
    // Supports fast "oldest unsynced" queries for the sync-health endpoint.
    index("idx_poly_copy_trade_fills_synced_at").on(table.syncedAt),
    // Tenant-scoped queries.
    index("poly_copy_trade_fills_billing_account_idx").on(
      table.billingAccountId
    ),
    // Executor-bug canary — Polymarket order ids are unique by construction, so
    // two fills ever carrying the same `order_id` indicates the mirror path
    // double-submitted. Partial index skips the (common) null rows.
    uniqueIndex("poly_copy_trade_fills_order_id_unique")
      .on(table.orderId)
      .where(sql`${table.orderId} IS NOT NULL`),
    // DEDUPE_AT_DB (task.5001/task.5006) — exactly one active resting mirror
    // order per (tenant, target, market). A row whose `position_lifecycle` is
    // past the active order phases or whose legacy `attributes.closed_at` is
    // present is position history, not an active resting slot. The mirror pipeline's
    // application-level `hasOpenForMarket` gate is fast-path optimization;
    // this partial unique index is the correctness backstop. Insert path
    // catches PG 23505 and converts to skip/already_resting.
    uniqueIndex("poly_copy_trade_fills_one_open_per_market")
      .on(table.billingAccountId, table.targetId, table.marketId)
      .where(
        sql`${table.status} IN ('pending','open','partial')
          AND (${table.positionLifecycle} IS NULL OR ${table.positionLifecycle} IN ('unresolved','open','closing'))
          AND ${table.attributes}->>'closed_at' IS NULL`
      ),
    index("poly_copy_trade_fills_position_lifecycle_idx").on(
      table.billingAccountId,
      table.positionLifecycle
    ),
    // bug.5018 — PnL/VWAP aggregation key. Mode is included so paper vs
    // live rows don't interleave on the scan.
    index("poly_copy_trade_fills_pnl_idx").on(
      table.billingAccountId,
      table.targetId,
      table.marketId,
      table.mode,
      table.status
    ),
    // fill_id format is owned by per-source helpers in @cogni/poly-market-provider.
    // Dedupe is enforced by the partial unique index on (target_id, fill_id).
    check(
      "poly_copy_trade_fills_status_check",
      sql`${table.status} IN ('pending','open','filled','partial','canceled','error')`
    ),
    check(
      "poly_copy_trade_fills_position_lifecycle_check",
      sql`${table.positionLifecycle} IS NULL OR ${table.positionLifecycle} IN (
        'unresolved', 'open', 'closing', 'closed', 'resolving',
        'winner', 'redeem_pending', 'redeemed', 'loser', 'dust', 'abandoned'
      )`
    ),
    check(
      "poly_copy_trade_fills_mode_check",
      sql`${table.mode} IN ('live','paper')`
    ),
  ]
);

/**
 * Append-only log of every `decide()` outcome — `place`, `skip`, or `error`.
 * Tenant-scoped. Rows are never updated or deleted from application code.
 */
export const polyCopyTradeDecisions = pgTable(
  "poly_copy_trade_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Tenant data column. */
    billingAccountId: text("billing_account_id").notNull(),
    /** RLS key column. */
    createdByUserId: text("created_by_user_id").notNull(),
    targetId: uuid("target_id").notNull(),
    fillId: text("fill_id").notNull(),
    /** 'placed' | 'skipped' | 'error' — mirrors the `decide()` return branch. */
    outcome: text("outcome").notNull(),
    /** Null for `placed`; holds the skip-reason or error class otherwise. */
    reason: text("reason"),
    /** Full MirrorIntent snapshot (or the OrderIntent if one was built). */
    intent: jsonb("intent").$type<Record<string, unknown>>().notNull(),
    /** Non-null iff an order was placed; carries OrderReceipt shape. */
    receipt: jsonb("receipt").$type<Record<string, unknown>>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    /**
     * Execution mode of the decision. Stamped at write time by
     * `order-ledger.ts::recordDecision` from the ledger's `paperEnforceMode`
     * dep (resolved once from `PAPER_ENFORCE_MODE` env at bootstrap).
     * MODE_STAMPED_AT_LEDGER_FROM_ENV — replaces the legacy advisory chain
     * `targets.mode → intent.attributes.mode → JSONB blob` which never
     * reached this column. Defaulted to `'live'` for legacy pre-cutover
     * rows; task.5003 ships NO retroactive backfill because the only
     * candidate join key (`intent->>'mode' = 'paper'`) cannot distinguish
     * "actually executed on paper sidecar" from "PROD-era target manually
     * flipped to paper while the executor still routed live" — mislabeling
     * real-money trades as paper is worse than the analytics gap.
     */
    mode: text("mode").notNull().default("live"),
  },
  (table) => [
    index("poly_copy_trade_decisions_decided_at_idx").on(table.decidedAt),
    index("poly_copy_trade_decisions_target_fill_idx").on(
      table.targetId,
      table.fillId
    ),
    index("poly_copy_trade_decisions_billing_account_idx").on(
      table.billingAccountId
    ),
    check(
      "poly_copy_trade_decisions_outcome_check",
      sql`${table.outcome} IN ('placed','skipped','error')`
    ),
    check(
      "poly_copy_trade_decisions_mode_check",
      sql`${table.mode} IN ('live','paper')`
    ),
  ]
);

/**
 * task.5014 — per-(billing_account, target, condition) baseline snapshot of
 * target's cumulative position USDC at first post-activation observation.
 * Insert-once via `ON CONFLICT DO NOTHING`. Read by `applyPositionGapSizing`.
 * See docs/research/poly/range-relative-mirror-2026-05-26.md.
 *
 * @public
 */
export const polyCopyTargetConditionBaseline = pgTable(
  "poly_copy_target_condition_baseline",
  {
    billingAccountId: text("billing_account_id").notNull(),
    targetId: uuid("target_id").notNull(),
    conditionId: text("condition_id").notNull(),
    baselineTargetPositionUsdc: numeric("baseline_target_position_usdc", {
      precision: 12,
      scale: 2,
    }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    capturedAtFillId: text("captured_at_fill_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.billingAccountId, table.targetId, table.conditionId],
    }),
    check(
      "poly_copy_target_condition_baseline_usdc_non_negative",
      sql`${table.baselineTargetPositionUsdc} >= 0`
    ),
  ]
);

export type PolyCopyTradeTarget = typeof polyCopyTradeTargets.$inferSelect;
export type NewPolyCopyTradeTarget = typeof polyCopyTradeTargets.$inferInsert;
export type PolyCopyTradeFill = typeof polyCopyTradeFills.$inferSelect;
export type NewPolyCopyTradeFill = typeof polyCopyTradeFills.$inferInsert;
export type PolyCopyTradeDecision = typeof polyCopyTradeDecisions.$inferSelect;
export type NewPolyCopyTradeDecision =
  typeof polyCopyTradeDecisions.$inferInsert;
export type PolyCopyTargetConditionBaseline =
  typeof polyCopyTargetConditionBaseline.$inferSelect;
export type NewPolyCopyTargetConditionBaseline =
  typeof polyCopyTargetConditionBaseline.$inferInsert;

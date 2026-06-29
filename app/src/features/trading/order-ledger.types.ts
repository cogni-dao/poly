// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/trading/order-ledger.types`
 * Purpose: Port interface + row/snapshot types for the Postgres-backed order ledger. Every placement path reads/writes through this port; adapter is the Drizzle implementation in `order-ledger.ts`.
 * Scope: Pure type surface. No drizzle imports, no I/O.
 * Invariants: LEDGER_PORT_SHAPE_IS_STABLE — adding fields is a breaking change. INSERT_BEFORE_PLACE is a caller invariant, not a ledger one.
 * Side-effects: none
 * Public types: `LedgerRow` (includes `synced_at`, `position_lifecycle`, `mode`), `LedgerStatus`, `LedgerMode`, `LedgerPositionLifecycle`, `StateSnapshot`, `TenantBinding`, `InsertPendingInput` (extends TenantBinding; carries `intent.attributes.token_id` for the per-token atomic cap-check), `RecordDecisionInput` (extends TenantBinding), `ListRecentOptions` (tenant-required), `ListOpenOrPendingOptions`, `UpdateStatusInput`, `SyncHealthSummary`, `OrderLedger` (snapshotState takes `(target_id, billing_account_id)`; `cumulativeIntentForMarketToken` takes `(billing_account_id, market_id, token_id)` per bug.5004 `CAP_IS_PER_TOKEN_ID`).
 * Links: work/items/task.0315.poly-copy-trade-prototype.md (CP4.3b), work/items/task.0328.poly-sync-truth-ledger-cache.md, docs/spec/poly-tenant-and-collateral.md
 * @public
 */

import type { OrderIntent, OrderReceipt } from "@cogni/poly-market-provider";

/** Canonical status set for `poly_copy_trade_fills.status` (migration 0027 CHECK). */
export type LedgerStatus =
  | "pending"
  | "open"
  | "filled"
  | "partial"
  | "canceled"
  | "error";

/**
 * Typed position lifecycle for rows that have or had wallet exposure. NULL
 * means the order row has not produced a position yet.
 */
export type LedgerPositionLifecycle =
  | "unresolved"
  | "open"
  | "closing"
  | "closed"
  | "resolving"
  | "winner"
  | "redeem_pending"
  | "redeemed"
  | "loser"
  | "dust"
  | "abandoned";

/**
 * Row shape returned by `listRecent` — mirrors `polyCopyTradeFills` $inferSelect
 * but with the fields the read APIs + mirror-coordinator actually consume.
 * Extra columns (`attributes`, `created_at`, `updated_at`, `synced_at`) surface as-is.
 *
 * `synced_at` is NULL until the reconciler first touches the row
 * (SYNCED_AT_WRITTEN_ON_EVERY_SYNC invariant — see task.0328 CP3).
 */
export interface LedgerRow {
  target_id: string;
  fill_id: string;
  observed_at: Date;
  client_order_id: string;
  order_id: string | null;
  status: LedgerStatus;
  position_lifecycle: LedgerPositionLifecycle | null;
  attributes: Record<string, unknown> | null;
  /** Last time the reconciler received a typed CLOB response for this row. NULL = never checked. */
  synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /**
   * Tenant the row belongs to. Required by the per-tenant order-reconciler so
   * it can route `getOrder` through the correct `PolyTradeExecutor` (each
   * tenant has their own CLOB API creds derived from their Privy signer).
   */
  billing_account_id: string;
  /**
   * Execution mode stamped on the row at write-time by the ledger
   * (MODE_STAMPED_AT_LEDGER_FROM_ENV — `order-ledger.ts`). `live` rows are
   * real CLOB orders; `paper` rows are simulated by the paper sidecar but
   * otherwise participate in cap accounting identically. Schema default is
   * `'live'` (migration 0049). Pre-cutover rows on paper-enforced envs
   * (cand-a / preview) keep their inherited `'live'` label — no retroactive
   * backfill ships in task.5003 because the only candidate signal
   * (`decisions.intent->>'mode' = 'paper'`) has historical false positives
   * on PROD from the per-target trapdoor era. New activity rebuilds paper
   * analytics from scratch.
   */
  mode: LedgerMode;
}

/**
 * Execution mode stamped on every fill / decision row. Sourced from the
 * ledger's `paperEnforceMode` dep — env is the single authority. Pair with
 * `PAPER_DISPATCH_IS_ENV_ONLY` (poly-trade-executor.ts).
 */
export type LedgerMode = "live" | "paper";

/**
 * Generic per-(market_id, token_id) intent-aggregate row. Trading-vocabulary
 * only — names "intent," "shares," "usdc." Consumers (copy-trade) overlay
 * mirror-specific shape (`MirrorPositionView`) on top via their own aggregator.
 *
 * Quantities are intent-based (computed from `attributes.size_usdc /
 * attributes.limit_price`) and include rows in `pending | open | filled |
 * partial`, excluding `canceled | error | closed` and `position_lifecycle`
 * past `closing`. TRADING_IS_GENERIC: this type knows nothing about mirrors.
 */
export interface PositionIntentAggregate {
  market_id: string;
  token_id: string;
  /** BUY shares minus SELL shares on this `(market_id, token_id)`. */
  net_shares: number;
  /** Sum of `size_usdc` on BUY rows only. */
  gross_usdc_in: number;
  /** Sum of `size_usdc / limit_price` on BUY rows only. */
  gross_shares_in: number;
}

/**
 * State snapshot the mirror-coordinator hands to `decide()`. Caller translates
 * into `RuntimeState`. The ledger owns the SELECTs; `decide()` stays pure.
 *
 * **Fail-closed**: on DB error the adapter returns zeroes/empty arrays —
 * never throws into the coordinator.
 */
export interface StateSnapshot {
  today_spent_usdc: number;
  fills_last_hour: number;
  /**
   * `client_order_id` values placed by this tenant for this target within the
   * `DEDUP_WINDOW_IS_BOUNDED` window (bug.5023 — see `order-ledger.ts`).
   * Used by plan-mirror's `already_placed` gate. Older COIDs that fall
   * outside the window are caught by the PK `(target_id, fill_id)`
   * ON CONFLICT DO NOTHING backstop on insert — they cannot cause duplicate
   * placements. **Note**: see `placed_fill_ids` — after the `clientOrderIdFor`
   * shape change (multi-tenant PK fix), the COID stored on a pre-cutover row
   * will not match a freshly computed COID for the same `(target_id, fill_id)`;
   * `placed_fill_ids` is the durable membership key.
   */
  already_placed_ids: string[];
  /**
   * `fill_id` values placed by this tenant for this target within the
   * `DEDUP_WINDOW_IS_BOUNDED` window (bug.5023). The real idempotency key: a
   * fill already on record should not be re-mirrored regardless of which COID
   * shape produced its row. Outside-window fills are caught by the PK
   * backstop on insert.
   */
  placed_fill_ids: string[];
  /**
   * Per-(market_id, token_id) intent aggregates for the target's active fills.
   * Empty array on fail-closed read OR when the target has no active fills.
   * Generic shape — copy-trade's mirror-pipeline overlays mirror semantics
   * on top via `aggregatePositionRows()` from `@/features/copy-trade`.
   */
  position_aggregates: PositionIntentAggregate[];
}

/** Bounded enum of cancel reasons. Stored on `attributes.reason`. */
export type LedgerCancelReason =
  | "target_exited_market"
  | "ttl_expired"
  | "stale_resting_layer_up";

/**
 * Thrown by `insertPending` when the partial unique index
 * `poly_copy_trade_fills_one_open_per_market` rejects a second open row for
 * the same `(billing_account_id, target_id, market_id)` where the existing row
 * has not been position-closed (`attributes.closed_at IS NULL`). Pipeline
 * converts to `skip/already_resting`. task.5001 / task.5006.
 */
export class AlreadyRestingError extends Error {
  readonly code = "already_resting" as const;
  constructor(
    readonly billing_account_id: string,
    readonly target_id: string,
    readonly market_id: string
  ) {
    super(
      `AlreadyRestingError: open mirror order exists for (${billing_account_id}, ${target_id}, ${market_id})`
    );
    this.name = "AlreadyRestingError";
  }
}

/**
 * Thrown by `insertPending` when the tenant's active intent for a (market,
 * token) would exceed the caller-provided per-leg cap. Unlike the target-scoped
 * `AlreadyRestingError`, this protects aggregate exposure across all copy
 * targets for the same billing account.
 *
 * bug.5004 (`CAP_IS_PER_TOKEN_ID`): the cap is scoped per `token_id`, so a
 * hedged binary can accumulate up to `max_intent_usdc` on each side
 * independently. The opposite-side intent does NOT count toward `current_intent_usdc`.
 */
export class PositionCapReachedError extends Error {
  readonly code = "position_cap_reached" as const;
  constructor(
    readonly billing_account_id: string,
    readonly market_id: string,
    readonly token_id: string,
    readonly current_intent_usdc: number,
    readonly proposed_intent_usdc: number,
    readonly max_intent_usdc: number
  ) {
    super(
      `PositionCapReachedError: active intent ${current_intent_usdc} + ${proposed_intent_usdc} exceeds ${max_intent_usdc} for (${billing_account_id}, ${market_id}, ${token_id})`
    );
    this.name = "PositionCapReachedError";
  }
}

/** Subset of `LedgerRow` returned by `findOpenForMarket` / `findStaleOpen`. */
export interface OpenOrderRow {
  client_order_id: string;
  /** Null until placement returns and `markOrderId` runs. */
  order_id: string | null;
  status: LedgerStatus;
  billing_account_id: string;
  target_id: string;
  market_id: string;
  created_at: Date;
  /**
   * Resting order's limit price extracted from `attributes.limit_price`. Null
   * when the row predates the field or the value is malformed. Used by the
   * BUY-side staleness check (bug.5035) to decide cancel-then-place vs skip.
   */
  limit_price: number | null;
}

/** Tenant attribution required by every write into `poly_copy_trade_*`. */
export interface TenantBinding {
  /** Data column. FK → billing_accounts.id. */
  billing_account_id: string;
  /** RLS key column. FK → users.id. */
  created_by_user_id: string;
}

/**
 * Per-tenant context envelope (bug.5022). Construct once per per-tenant inner
 * loop (mirror-pipeline `processFill`, per-request route handler) and pass to
 * `OrderLedger.forTenant(ctx)` to obtain a `TenantOrderLedger` whose every
 * method closes over the tenant. Compile-time guarantee that no caller can
 * read or write tenant-scoped rows without naming the tenant.
 *
 * `created_by_user_id` drives PostgreSQL RLS — the adapter wraps each method
 * in `withTenantScope(appDb, ctx.created_by_user_id, ...)` so the row-level
 * security policy on `poly_copy_trade_{fills,decisions}` (keyed on
 * `current_setting('app.current_user_id', true)`) becomes the runtime
 * backstop even if SQL drift drops an explicit `.where()` clause.
 *
 * Same shape as `TenantBinding`; named separately because `TenantBinding`
 * lives inside individual write-input types whose `target_id` field is
 * still required, while `TenantContext` is the standalone envelope passed
 * to `forTenant()`.
 *
 * See docs/spec/poly-tenant-and-collateral.md ORDER_LEDGER_TENANT_CONTEXT_ENVELOPE.
 */
export type TenantContext = {
  billing_account_id: string;
  created_by_user_id: string;
};

/** Input to `insertPending` — shape captured at decide-time. */
export interface InsertPendingInput extends TenantBinding {
  target_id: string;
  fill_id: string;
  observed_at: Date;
  intent: OrderIntent;
  /**
   * Optional atomic cap for active tenant × market × token intent. When
   * present AND `intent.attributes.token_id` is set, the DB adapter locks
   * `(billing_account_id, market_id, token_id)`, re-sums active intent for
   * that token, and rejects the insert with `PositionCapReachedError` if it
   * would exceed this bound. Copy-trading passes `max_usdc_per_condition`
   * here so concurrent target pollers cannot race through the read-side
   * pre-check.
   *
   * bug.5004 (`CAP_IS_PER_TOKEN_ID`): the atomic check is scoped per
   * token_id; the opposite side of a binary does NOT count against this
   * token's cap.
   *
   * **Bypass contract** (intentional, mirrored by `mirror-pipeline.ts`'s
   * read-side pre-check): when `intent.attributes.token_id` is missing OR
   * empty-string (`buildIntent`'s defensive fallback when the upstream fill
   * has no `asset`), the atomic cap-check is SKIPPED entirely. We prefer
   * "fail open on malformed fill" over "scope cap to empty-string token +
   * silently match no rows + leak past the cap". The bypass also applies to
   * SELL intents (NO_SELL_IN_MIRROR — sells never go through this cap) and
   * any caller that has not yet opted into the per-token contract.
   */
  max_market_intent_usdc?: number;
}

/** Input to `recordDecision` — one row per `decide()` outcome, including skips. */
export interface RecordDecisionInput extends TenantBinding {
  target_id: string;
  fill_id: string;
  outcome: "placed" | "skipped" | "error";
  reason: string | null;
  intent: Record<string, unknown>;
  receipt: Record<string, unknown> | null;
  decided_at: Date;
}

/**
 * Options for `listRecent` — used by the read API.
 *
 * `billing_account_id` is **required** so the read is tenant-scoped at the
 * adapter layer. The orders route resolves the caller's billing account from
 * the session before calling. Cross-tenant reads (the mirror enumerator) have
 * never used `listRecent` and have no legitimate need to — they read via
 * dedicated cross-tenant ports.
 */
export interface ListRecentOptions {
  billing_account_id: string;
  limit?: number;
  target_id?: string;
}

/** Options for the tenant-scoped dashboard position read model. */
export interface ListTenantPositionsOptions {
  billing_account_id: string;
  statuses?: LedgerStatus[];
  limit?: number;
}

/** Options for `listOpenOrPending` — used by the reconciler tick. */
export interface ListOpenOrPendingOptions {
  /** Only return rows older than this many milliseconds. Default 30000. */
  olderThanMs?: number;
  /** Max rows to return. Default 200. */
  limit?: number;
}

/** Input to `updateStatus` — reconciler writes new CLOB-derived status. */
export interface UpdateStatusInput {
  client_order_id: string;
  status: LedgerStatus;
  /** Updated filled size in USDC — stored into `attributes.filled_size_usdc`. */
  filled_size_usdc?: number;
  /** Stamp order_id if the adapter returns it on a late acknowledgement. */
  order_id?: string;
  /** Realized fill data observed by the reconciler. Undefined skips the column update. */
  fill_price?: number;
  total_shares?: number;
  fees_usdc?: number;
  /**
   * Machine-readable promotion reason stored in `attributes.reason`.
   * Used by the reconciler to distinguish "clob_not_found" cancelations from
   * normal user/market cancelations. Mirrors the pattern of `markError` →
   * `attributes.error`.
   */
  reason?: string;
}

/** Input to clear ledger exposure after a token is no longer held. */
export interface MarkPositionClosedByAssetInput {
  billing_account_id: string;
  token_id: string;
  close_order_id?: string;
  close_client_order_id?: string;
  reason?: "manual_close" | "refresh_no_position";
  closed_at: Date;
}

/** Input to mirror redeem/resolution lifecycle into the ledger read model. */
export interface MarkPositionLifecycleByConditionIdInput {
  billing_account_id: string;
  condition_id: string;
  lifecycle: LedgerPositionLifecycle;
  updated_at: Date;
}

/** Input to mirror asset-scoped redeem lifecycle into the ledger read model. */
export interface MarkPositionLifecycleByAssetInput {
  billing_account_id: string;
  token_id: string;
  lifecycle: LedgerPositionLifecycle;
  updated_at: Date;
  terminal_correction?: "redeem_reorg";
}

/**
 * Aggregate freshness stats returned by `syncHealthSummary`.
 * Used by GET /api/v1/poly/internal/sync-health.
 *
 * `oldest_synced_row_age_ms` — age in ms of the least-recently-synced row
 *   that HAS a non-null `synced_at`. Null when no row has ever been synced.
 *   Never-synced rows are counted in `rows_never_synced` instead.
 *
 * SYNC_HEALTH_IS_PUBLIC invariant (task.0328 CP4).
 */
export interface SyncHealthSummary {
  oldest_synced_row_age_ms: number | null;
  rows_stale_over_60s: number;
  rows_never_synced: number;
}

/**
 * Tenant-scoped order ledger surface (bug.5022). Obtained via
 * `OrderLedger.forTenant(ctx)`; methods close over the tenant so callers
 * cannot accidentally read or write another tenant's rows. Each method is
 * wrapped in `withTenantScope(appDb, ctx.created_by_user_id, ...)` so
 * Postgres RLS on `poly_copy_trade_{fills,decisions}` is the runtime
 * backstop even if SQL drift drops an explicit `.where()` clause.
 *
 * v0 carries the mirror-pipeline surface only. task.5012 widens this to
 * cover the API-route surface (`listRecent`, `listTenantPositions`,
 * `dailyTradeCounts`, `markPositionLifecycleByAsset`,
 * `markPositionClosedByAsset`) and migrates `privy-poly-trader-wallet.adapter`
 * + `wallet-analysis/copy-trade-pnl-service` onto the same envelope.
 *
 * @public
 */
export interface TenantOrderLedger {
  /**
   * Read runtime state for a target under this tenant. Same fail-closed
   * semantics as the root `snapshotState` (zeroes + warn log on DB error;
   * never throws). The four queries inside (spend, rate, COID dedup,
   * position aggregates) all filter on `(billing_account_id, target_id)` —
   * fixing the pre-bug.5022 leak where only `target_id` filtered and
   * cross-tenant fills polluted `position_aggregates`.
   */
  snapshotState(target_id: string): Promise<StateSnapshot>;

  /**
   * Per-(tenant, market, token) cap-relevant USDC. Same semantics as the
   * root method; tenant scope closed over.
   */
  cumulativeIntentForMarketToken(
    market_id: string,
    token_id: string
  ): Promise<number>;

  /**
   * Insert a `pending` row scoped to this tenant. `input` no longer needs
   * `billing_account_id` or `created_by_user_id` (stamped from `ctx`).
   */
  insertPending(input: TenantScopedInsertPendingInput): Promise<void>;

  /**
   * Partial-unique-index existence check scoped to this tenant.
   */
  hasOpenForMarket(args: {
    target_id: string;
    market_id: string;
  }): Promise<boolean>;

  /**
   * All open rows for this tenant's `(target_id, market_id)` slot.
   */
  findOpenForMarket(args: {
    target_id: string;
    market_id: string;
  }): Promise<OpenOrderRow[]>;

  /**
   * Append a `poly_copy_trade_decisions` row scoped to this tenant. `input`
   * no longer needs `billing_account_id` or `created_by_user_id` (stamped
   * from `ctx`).
   */
  recordDecision(input: TenantScopedRecordDecisionInput): Promise<void>;
}

/** Tenant-scoped variant of `InsertPendingInput` (bug.5022). */
export type TenantScopedInsertPendingInput = Omit<
  InsertPendingInput,
  keyof TenantBinding
>;

/** Tenant-scoped variant of `RecordDecisionInput` (bug.5022). */
export type TenantScopedRecordDecisionInput = Omit<
  RecordDecisionInput,
  keyof TenantBinding
>;

/**
 * Order ledger port. Production adapter is `createOrderLedger({ db })` in
 * `order-ledger.ts`; tests use `FakeOrderLedger` from
 * `adapters/test/trading/fake-order-ledger`. Every placement path in the poly
 * app reads + writes through this interface.
 *
 * Tenant-scoped reads + writes go via `forTenant(ctx)` — see bug.5022 +
 * `docs/spec/poly-tenant-and-collateral.md` ORDER_LEDGER_TENANT_CONTEXT_ENVELOPE.
 * The unscoped methods kept on this root remain for back-compat; task.5012
 * migrates each one onto the tenant-scoped surface (or, for explicitly
 * cross-tenant ops like `findStaleOpen`, names them as such and keeps them
 * on the root permanently).
 *
 * @public
 */
export interface OrderLedger {
  /**
   * Return a `TenantOrderLedger` whose every method closes over `ctx` and
   * runs under `withTenantScope(appDb, ctx.created_by_user_id, ...)`. The
   * canonical entry point for per-tenant reads + writes (bug.5022).
   */
  forTenant(ctx: TenantContext): TenantOrderLedger;

  /**
   * Read runtime state for a target. Fail-closed on DB error: returns
   * zeroes/empty arrays plus an error log on the caller's logger — never throws.
   *
   * @deprecated Use `forTenant(ctx).snapshotState(target_id)` instead. This
   * legacy two-arg form filters on `target_id` only and leaks cross-tenant
   * `position_aggregates` (bug.5022). Kept temporarily for non-mirror-pipeline
   * callers; tracked for removal in task.5012.
   */
  snapshotState(
    target_id: string,
    billing_account_id: string
  ): Promise<StateSnapshot>;

  /**
   * Sum the cap-relevant USDC component of all `poly_copy_trade_fills` rows
   * for this tenant × market × token. Used by the mirror sizing policy to
   * enforce a per-(tenant, market, token_id) position cap.
   *
   * bug.5004 (`CAP_IS_PER_TOKEN_ID`): scope is `(billing_account_id, market_id,
   * attributes->>'token_id')`. YES + NO outcome tokens of the same conditionId
   * have independent budgets. Each side of a hedged binary can accumulate up
   * to `max_usdc_per_condition` without interference from the other side.
   * Operator-level dollar bound lives at `authorizeIntent` (daily / hourly
   * grant caps), not here.
   *
   * **Intent for active rows, realized for terminated rows.** Per-status weight:
   *   - `pending | open | filled | partial` → `size_usdc` (full intent — we
   *     are still committed). v0 chooses intent because the FOK-heavy mirror
   *     regime fills only ~14% of placements; a purely-filled-based cap would
   *     let no-match attempts keep firing through the cap. Revisit once
   *     task.0427's design pass lands and the miss rate drops.
   *   - `error AND placement = market_fok` → `size_usdc` (bug.0430 broadcast
   *     race: CLOB returns error but the on-chain CTF can still mint).
   *   - `canceled` → `filled_size_usdc` if present, else `size_usdc`
   *     (bug.5050 CAP_COUNTS_REALIZED_ON_CANCEL: a STALE_RESTING_CANCEL_REPLACE
   *     on a partially-filled order leaves the realized shares in our wallet
   *     even after `markCanceled` flips status to terminal — those shares
   *     must still count or the next placement leaks past the cap. The
   *     `size_usdc` fallback is pessimistic for legacy rows where the
   *     order-reconciler has not yet populated `filled_size_usdc`).
   *   - `error AND placement = limit` → 0 (CLOB-rejected at API boundary,
   *     no chain effect).
   *
   * Rows with terminal `position_lifecycle` (closed/redeemed/loser/dust/
   * abandoned) or `attributes.closed_at IS NOT NULL` are excluded outright —
   * the position is no longer in our wallet.
   *
   * Cross-target by design (the cap is on the tenant's exposure to a market×
   * token, not per-target). Fail-closed: returns `Infinity` on DB error so
   * the caller skips the placement rather than mis-allowing it.
   *
   * Mirrored by `ledger-lifecycle::ledgerCountedIntentUsdc` for the in-memory
   * FakeOrderLedger.
   *
   * Links: bug.5004, bug.5050, bug.0430.
   */
  cumulativeIntentForMarketToken(
    billing_account_id: string,
    market_id: string,
    token_id: string
  ): Promise<number>;

  /**
   * Insert a `pending` row. Idempotent by PK `(target_id, fill_id)` — a repeat
   * of the same pair is a no-op (ON CONFLICT DO NOTHING). Stores `size_usdc`
   * / `side` / `market_id` / `limit_price` / `target_wallet` in `attributes`
   * so the read API + dashboard don't need to re-derive from the intent blob.
   */
  insertPending(input: InsertPendingInput): Promise<void>;

  /** Transition pending → filled/open/partial, stamping the `order_id`. */
  markOrderId(params: {
    client_order_id: string;
    receipt: OrderReceipt;
  }): Promise<void>;

  /** Transition pending → error. `error` is stored in `attributes.error`. */
  markError(params: { client_order_id: string; error: string }): Promise<void>;

  /** Transition any → canceled. Writes `attributes.reason`. task.5001. */
  markCanceled(params: {
    client_order_id: string;
    reason: LedgerCancelReason;
  }): Promise<void>;

  /**
   * Clear DB-derived position exposure after a token is no longer held.
   * Keeps historical rows, writes `position_lifecycle='closed'`, and stamps
   * `attributes.closed_at` as close timestamp metadata.
   */
  markPositionClosedByAsset(
    input: MarkPositionClosedByAssetInput
  ): Promise<number>;

  /**
   * Mirror asset-scoped redeem lifecycle into position rows. Redeem burns a
   * concrete CTF positionId/token_id, so this is the canonical write path for
   * redeem pipeline state. Terminal lifecycles are preserved unless the input
   * explicitly represents a chain reorg correction from `redeemed` back to
   * `redeem_pending`.
   */
  markPositionLifecycleByAsset(
    input: MarkPositionLifecycleByAssetInput
  ): Promise<number>;

  /**
   * Mirror a condition-level redeem/resolution lifecycle into position rows so
   * dashboard and automation can agree on one typed DB read model. Matches
   * either explicit `attributes.condition_id` or promoted `market_id` values.
   */
  markPositionLifecycleByConditionId(
    input: MarkPositionLifecycleByConditionIdInput
  ): Promise<number>;

  /**
   * Existence check on the partial unique index slot. True iff any row for
   * `(billing_account_id, target_id, market_id)` has `status IN
   * ('pending','open','partial') AND attributes.closed_at IS NULL`.
   * Fail-closed: returns `true` on DB error.
   */
  hasOpenForMarket(args: {
    billing_account_id: string;
    target_id: string;
    market_id: string;
  }): Promise<boolean>;

  /** All open rows for `(billing_account_id, target_id, market_id)`. */
  findOpenForMarket(args: {
    billing_account_id: string;
    target_id: string;
    market_id: string;
  }): Promise<OpenOrderRow[]>;

  /**
   * All rows across all tenants whose `created_at < now() - max_age_minutes`
   * AND `status IN ('pending','open','partial')`. Used by the TTL sweeper.
   */
  findStaleOpen(args: { max_age_minutes: number }): Promise<OpenOrderRow[]>;

  /**
   * Append-only `poly_copy_trade_decisions` insert. Called for EVERY decide()
   * outcome — placed, skipped, or error — so divergence analysis at P4 cutover
   * has a complete record independent of what landed in the fills ledger.
   */
  recordDecision(input: RecordDecisionInput): Promise<void>;

  /**
   * Read the N most recent rows for the caller's tenant — primary surface for
   * the orders read API. `billing_account_id` is required; the adapter applies
   * a WHERE clamp so the response never surfaces another tenant's rows.
   * Default limit 50. Ordered by `observed_at DESC` to match the dashboard card.
   */
  listRecent(opts: ListRecentOptions): Promise<LedgerRow[]>;

  /**
   * Tenant-scoped position read model for dashboard page-loads. Reads
   * `poly_copy_trade_fills` only; CLOB is background reconciliation input.
   */
  listTenantPositions(opts: ListTenantPositionsOptions): Promise<LedgerRow[]>;

  /**
   * Daily executed-trade counts for the dashboard chart. SQL-aggregates
   * `poly_copy_trade_fills` by UTC day with the same predicate as
   * `shouldCountLedgerTrade` (filled_size_usdc > 0, or status in
   * filled/partial with size_usdc > 0). Avoids the LIMIT-truncation bug
   * that hits when an account has more recent rows than the listTenantPositions
   * cap can return (bug.5012 pattern; cf. wallet-analysis-service.ts daily-counts).
   * Throws on DB error — caller wraps with the existing
   * `positions_read_model_unavailable` warning.
   */
  dailyTradeCounts(opts: {
    billing_account_id: string;
    capturedAt: Date;
    windowDays: number;
  }): Promise<Array<{ day: string; n: number }>>;

  /**
   * Return all rows with `status IN ('pending', 'open')` that are older than
   * `olderThanMs` milliseconds (default 30 000). Ordered by `created_at ASC`
   * so the reconciler processes oldest-first. Default limit 200.
   *
   * Used exclusively by the order reconciler job (task.0323 §2).
   */
  listOpenOrPending(opts?: ListOpenOrPendingOptions): Promise<LedgerRow[]>;

  /**
   * Overwrite `status` (and optionally `filled_size_usdc` / `order_id`) on
   * the row identified by `client_order_id`. Touches `updated_at`.
   *
   * Called by the order reconciler and explicit user refresh — no page-load
   * route should drive status after placement.
   */
  updateStatus(input: UpdateStatusInput): Promise<void>;

  /**
   * Bulk-stamp `synced_at = now()` on the rows whose `client_order_id` values
   * are in the given array. Called once per reconciler tick after iterating all
   * rows for which `getOrder` returned a typed answer (found OR not_found).
   *
   * Rows where `getOrder` threw (network error) are NOT included — their
   * staleness grows until the next successful check.
   *
   * No-op when the array is empty (no SQL emitted).
   *
   * SYNCED_AT_WRITTEN_ON_EVERY_SYNC invariant (task.0328 CP3).
   */
  markSynced(client_order_ids: string[]): Promise<void>;

  /**
   * Return aggregate sync-freshness stats for the health endpoint.
   * One DB round-trip (three filtered aggregates in a single SELECT).
   *
   * SYNC_HEALTH_IS_PUBLIC invariant (task.0328 CP4).
   */
  syncHealthSummary(): Promise<SyncHealthSummary>;
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/trading/order-ledger`
 * Purpose: Drizzle-backed `OrderLedger` adapter. Reads + writes `poly_copy_trade_fills` + `poly_copy_trade_decisions`. Every placement path (agent tool, mirror-coordinator, future WS ingester) reads + writes through this adapter. The canonical per-tenant entry point is `OrderLedger.forTenant(ctx)` (bug.5022) — returns a `TenantOrderLedger` whose every method runs inside `withTenantScope(appDb, ctx.created_by_user_id, ...)` so Postgres RLS on `poly_copy_trade_{fills,decisions}` becomes the runtime backstop. Legacy root methods that still take explicit tenant args (e.g. the deprecated `snapshotState(target_id, billing_account_id)`) carry the same defensive `eq(billingAccountId, ...)` filter inside the query, fixing the pre-bug.5022 cross-tenant leak.
 * Scope: Drizzle queries only. Does not build a DB client (caller injects); does not import from `adapters/server/*` (layer boundary); does not know about copy-trade or wallet-watch (TRADING_IS_GENERIC).
 * Invariants:
 *   - TRADING_IS_GENERIC — no imports from `features/copy-trade/` or `features/wallet-watch/`.
 *   - FAIL_CLOSED_ON_SNAPSHOT_READ — `snapshotState` returns zeroes/empty arrays on any DB error and logs at `warn`. Never throws. (bug.0438 dropped the kill-switch read; only cap counters + dedup keys remain.)
 *   - INSERT_IS_IDEMPOTENT — `insertPending` uses `ON CONFLICT (target_id, fill_id) DO NOTHING`, so repeat inserts are silent no-ops. Ordering guarantee lives in the caller, not here.
 *   - STATUS_ENUM_PINNED — the `status` CHECK in migration 0027 rejects any writer that tries to store an unknown value; that + `LedgerStatus` keep the runtime + schema in sync.
 *   - CAPS_COUNT_INTENTS — `today_spent_usdc` + `fills_last_hour` count every row whose `observed_at` falls in the window, regardless of terminal status. Matches `decide.ts::INTENT_BASED_CAPS`.
 *   - CAP_IS_PER_TOKEN_ID (bug.5004) — `cumulativeIntentForMarketToken` and the atomic SELECT inside `insertPending` both filter by `attributes->>'token_id'`. YES + NO outcome tokens of the same conditionId have independent budgets. The advisory lock key includes token_id so concurrent placements on different tokens do not serialize unnecessarily.
 *   - TENANT_FILTER_IN_EVERY_SNAPSHOT_QUERY (bug.5022) — all four `snapshotState` reads (spend, rate, COID dedup, position aggregates) filter on both `targetId` AND `billingAccountId`. Pre-bug.5022 the billing_account_id arg was accepted but ignored, causing cross-tenant `position_aggregates` pollution under shared targets.
 *   - DEDUP_WINDOW_IS_BOUNDED (bug.5023) — the COID/fill_id dedup query is bounded to fills `created_at >= now() - SNAPSHOT_DEDUP_WINDOW_DAYS` AND `LIMIT SNAPSHOT_DEDUP_ROW_CAP` rows ordered by `created_at DESC`. Older COIDs/fill_ids that escape the window are caught by the PK `(target_id, fill_id)` ON CONFLICT DO NOTHING backstop in `insertPending` — collisions become silent no-ops, never duplicate placements. Pre-bug.5023 the dedup query was unbounded, returning every fill the tenant had ever placed on this target and gunking the Node event loop on every chain event.
 *   - FORTENANT_RUNS_UNDER_RLS (bug.5022) — every method on the `TenantOrderLedger` returned by `OrderLedger.forTenant(ctx)` — both reads (`snapshotState`, `cumulativeIntentForMarketToken`, `hasOpenForMarket`, `findOpenForMarket`) AND writes (`insertPending`, `recordDecision`) — runs inside `withTenantScope(appDb, ctx.created_by_user_id, ...)`. Postgres RLS on `poly_copy_trade_{fills,decisions}` is the runtime backstop: even if a query forgets the explicit `billingAccountId` filter, the DB strips rows owned by another user. The `insertPending` advisory_xact_lock holds for the lifetime of the outer withTenantScope tx (the inner `db.transaction(...)` becomes a SAVEPOINT) — same atomicity as the legacy root path.
 *   - SYNCED_AT_WRITTEN_ON_EVERY_SYNC — `markSynced` sets `synced_at = now()` for every row for which the reconciler received a typed CLOB response (found OR not_found). Rows never checked show `synced_at IS NULL`. (task.0328 CP3)
 *   - REALIZED_COLUMNS_WRITTEN (bug.5018) — `markOrderId` and `updateStatus` write `price` / `shares` / `fees_usdc` directly into first-class columns (NOT JSONB) when the receipt carries them. Fields are skipped (column left NULL) when the upstream did not surface a realized value — distinct from "wrote 0". JSONB `attributes` carries only adapter-specific metadata (rawStatus, transactionsHashes, sidecar diagnostics) — no double-write.
 * Side-effects: IO (Postgres reads + writes).
 * Links: work/items/task.0315.poly-copy-trade-prototype.md (CP4.3b), work/items/task.0328.poly-sync-truth-ledger-cache.md, work/items/bug.5022.md (forTenant envelope), work/items/task.5012.md (cascade), docs/spec/poly-copy-trade-execution.md, docs/spec/poly-tenant-and-collateral.md (ORDER_LEDGER_TENANT_CONTEXT_ENVELOPE), docs/spec/poly-paper-trading-shortcomings.md (bug.5018)
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { toUserId, userActor } from "@cogni/ids";
import { EVENT_NAMES } from "@cogni/node-shared";
import {
  polyCopyTradeDecisions,
  polyCopyTradeFills,
} from "@cogni/poly-db-schema/copy-trade";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  or,
  sql,
  sum,
} from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Logger } from "pino";

import {
  AlreadyRestingError,
  type InsertPendingInput,
  type LedgerCancelReason,
  type LedgerPositionLifecycle,
  type LedgerRow,
  type ListOpenOrPendingOptions,
  type ListRecentOptions,
  type ListTenantPositionsOptions,
  type MarkPositionClosedByAssetInput,
  type MarkPositionLifecycleByAssetInput,
  type MarkPositionLifecycleByConditionIdInput,
  type OpenOrderRow,
  type OrderLedger,
  PositionCapReachedError,
  type PositionIntentAggregate,
  type RecordDecisionInput,
  type StateSnapshot,
  type SyncHealthSummary,
  type TenantContext,
  type TenantOrderLedger,
  type TenantScopedInsertPendingInput,
  type TenantScopedRecordDecisionInput,
  type UpdateStatusInput,
} from "./order-ledger.types";

/**
 * bug.5023 — `snapshotState.cidRows` (the COID/fill_id dedup arrays) is
 * bounded to fills `created_at` within this many days. Anything older is
 * statistically certain to be either (a) outside the mirror-pipeline cursor's
 * replay window (`WARMUP_BACKLOG_SEC = 60s`, ticks every 30s) or (b) caught
 * by the `(target_id, fill_id)` ON CONFLICT DO NOTHING backstop on insert.
 *
 * Pre-bug.5023 this was unbounded → O(N) heap allocation per fill processed,
 * O(N²) cumulative work over a tenant's lifetime, OOM ~10–20h on a Tier-0
 * pod with a single high-placement tenant.
 *
 * Exported so component tests can assert on the bound directly without
 * embedding the magic number.
 */
export const SNAPSHOT_DEDUP_WINDOW_DAYS = 7;

/**
 * bug.5023 — hard ceiling on `snapshotState.cidRows` regardless of window.
 * Belt-and-suspenders: a future regression that lets the window grow can't
 * OOM the pod. `ORDER BY created_at DESC` ensures the kept rows are the
 * most-recent — those are the ones the cursor-bounded fill stream could
 * plausibly replay. The PK collision backstop catches anything older.
 *
 * Exported so component tests can assert on the bound directly without
 * embedding the magic number.
 */
export const SNAPSHOT_DEDUP_ROW_CAP = 5000;

/** Dependencies injected at the `bootstrap/container.ts` boundary. */
export interface OrderLedgerDeps {
  /**
   * Drizzle client used by the LEGACY root surface — `serviceDb` (BYPASSRLS).
   * Every per-tenant op carries an explicit `billing_account_id` filter
   * inside the query (bug.5022). Used by:
   *   - the legacy `snapshotState(target_id, billing_account_id)` form
   *     (back-compat for non-mirror-pipeline callers; task.5012 migrates),
   *   - the COID-keyed mutations (`markOrderId`, `markError`, `markCanceled`,
   *     `updateStatus`, `markSynced`) — looked up by client_order_id which
   *     is tenant-unique by hash; called from cross-tenant contexts
   *     (the reconciler iterating all rows),
   *   - the explicitly cross-tenant ops (`findStaleOpen`,
   *     `listOpenOrPending`, `syncHealthSummary`) — documented as such on
   *     the root `OrderLedger` interface (`CROSS_TENANT_OPS_NAMED_EXPLICITLY`).
   * Per-tenant callers MUST use `OrderLedger.forTenant(ctx)` — that path
   * routes through `appDb` + `withTenantScope` for both reads and writes.
   *
   * Driver: `PostgresJsDatabase`. The bootstrap container exposes both
   * `serviceDb` and `appDb` as postgres-js clients (see
   * `packages/db-client/src/build-client.ts`); the historical
   * `NodePgDatabase` cast on this field was a TypeScript fiction, not a
   * real driver split.
   */
  db: PostgresJsDatabase;
  /**
   * Drizzle client wired to the RLS-enforced `app_user` role. Used by every
   * read on the `TenantOrderLedger` returned by `forTenant(ctx)` — wrapped
   * in `withTenantScope(appDb, ctx.created_by_user_id, ...)` so the
   * row-level security policy on `poly_copy_trade_{fills,decisions}`
   * (keyed on `current_setting('app.current_user_id', true)`) becomes the
   * runtime DB-layer backstop even if an explicit `eq(billingAccountId, ...)`
   * filter is forgotten. See bug.5022.
   *
   * Optional only to keep unit-test setups that don't exercise the
   * `forTenant(...)` surface from having to wire it; calling `forTenant(ctx)`
   * without `appDb` throws at runtime with a clear error.
   */
  appDb?: PostgresJsDatabase;
  /** Pino logger. Bind `component: "order-ledger"` at the caller if desired. */
  logger: Logger;
  /**
   * MODE_STAMPED_AT_LEDGER_FROM_ENV — the ledger is the single write
   * authority for `poly_copy_trade_{fills,decisions}.mode`. Bootstrap reads
   * `PAPER_ENFORCE_MODE` once at process start and passes the resolved value
   * here; every row this ledger writes is stamped with the resulting
   * execution mode. Pair invariant: `PAPER_DISPATCH_IS_ENV_ONLY` in
   * `poly-trade-executor.ts`.
   */
  paperEnforceMode?: "paper" | undefined;
}

/** Postgres unique-violation SQLSTATE — partial unique index rejection. */
const PG_UNIQUE_VIOLATION = "23505";

function parseLimitPrice(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const DEFAULT_LIST_LIMIT = 50;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Fixed-width UTC day window ending at `capturedAt`, oldest → newest. */
function buildUtcDayWindow(capturedAt: Date, windowDays: number): string[] {
  const todayUtc = Date.UTC(
    capturedAt.getUTCFullYear(),
    capturedAt.getUTCMonth(),
    capturedAt.getUTCDate()
  );
  const days: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    days.push(new Date(todayUtc - i * MS_PER_DAY).toISOString().slice(0, 10));
  }
  return days;
}
const nonTerminalPositionLifecycle = sql`(${polyCopyTradeFills.positionLifecycle} IS NULL OR ${polyCopyTradeFills.positionLifecycle} NOT IN ('closed','redeemed','loser','dust','abandoned'))`;
const activeRestingPositionLifecycle = sql`(${polyCopyTradeFills.positionLifecycle} IS NULL OR ${polyCopyTradeFills.positionLifecycle} IN ('unresolved','open','closing'))`;
const notPositionTerminal = sql`${nonTerminalPositionLifecycle} AND ${polyCopyTradeFills.attributes}->>'closed_at' IS NULL`;
const activeRestingPosition = sql`${activeRestingPositionLifecycle} AND ${polyCopyTradeFills.attributes}->>'closed_at' IS NULL`;
const hasPositionLifecycleOrExecution = sql`(
  ${polyCopyTradeFills.positionLifecycle} IS NOT NULL
  OR ${polyCopyTradeFills.status} IN ('filled','partial')
  OR CASE
    WHEN ${polyCopyTradeFills.attributes}->>'filled_size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
      THEN (${polyCopyTradeFills.attributes}->>'filled_size_usdc')::numeric
    ELSE 0
  END > 0
)`;

/**
 * Materialize the SQL GROUP BY result rows (numeric fields arrive as strings
 * from postgres-js) into the typed `PositionIntentAggregate` shape consumed
 * by the trading port. Filters rows whose `token_id` JSON-extract returned
 * null. Pure — testable in isolation.
 */
function materializeIntentAggregates(
  rows: Array<{
    market_id: string;
    token_id: string | null;
    net_shares: string;
    gross_usdc_in: string;
    gross_shares_in: string;
  }>
): PositionIntentAggregate[] {
  const out: PositionIntentAggregate[] = [];
  for (const row of rows) {
    if (row.token_id === null) continue;
    out.push({
      market_id: row.market_id,
      token_id: row.token_id,
      net_shares: Number(row.net_shares),
      gross_usdc_in: Number(row.gross_usdc_in),
      gross_shares_in: Number(row.gross_shares_in),
    });
  }
  return out;
}

export function createOrderLedger(deps: OrderLedgerDeps): OrderLedger {
  const log = deps.logger.child({ component: "order-ledger" });
  // MODE_STAMPED_AT_LEDGER_FROM_ENV — resolved once at construction. Every
  // insertPending / recordDecision write stamps this onto the row.
  const effectiveMode: "live" | "paper" =
    deps.paperEnforceMode === "paper" ? "paper" : "live";

  // `forTenant(ctx)` opens a `withTenantScope(appDb, ctx.created_by_user_id, ...)`
  // transaction around each tenant-scoped read so Postgres RLS on
  // `poly_copy_trade_{fills,decisions}` (keyed on `current_setting('app.current_user_id',
  // true)`) becomes the runtime backstop — even if a future query forgets the
  // explicit `eq(billingAccountId, ...)` filter, RLS will still strip rows
  // owned by another user. The four read methods (snapshotState,
  // cumulativeIntentForMarketToken, hasOpenForMarket, findOpenForMarket) all
  // go through this path. The two writes (insertPending, recordDecision)
  // continue to use `deps.db` (serviceDb) and stamp `billing_account_id` /
  // `created_by_user_id` explicitly in the row values — they were never the
  // bug.5022 leak surface; task.5012 migrates them onto withTenantScope too.
  // `root` is referenced lazily; the arrow bodies execute after init.
  const buildTenantSurface = (ctx: TenantContext): TenantOrderLedger => {
    const appDb = deps.appDb;
    if (!appDb) {
      throw new Error(
        "OrderLedger.forTenant(ctx) requires deps.appDb to be wired (RLS-enforced app_user role). Pass appDb when constructing the ledger — see nodes/poly/app/src/bootstrap/container.ts."
      );
    }
    const actor = userActor(toUserId(ctx.created_by_user_id));
    return {
      snapshotState: (target_id) =>
        withTenantScope(appDb, actor, async (tx) =>
          snapshotStateOnDb(tx, target_id, ctx.billing_account_id)
        ),
      cumulativeIntentForMarketToken: (market_id, token_id) =>
        withTenantScope(appDb, actor, async (tx) =>
          cumulativeIntentImpl(tx, ctx.billing_account_id, market_id, token_id)
        ),
      hasOpenForMarket: (args) =>
        withTenantScope(appDb, actor, async (tx) =>
          hasOpenForMarketImpl(tx, {
            billing_account_id: ctx.billing_account_id,
            target_id: args.target_id,
            market_id: args.market_id,
          })
        ),
      findOpenForMarket: (args) =>
        withTenantScope(appDb, actor, async (tx) =>
          findOpenForMarketImpl(tx, {
            billing_account_id: ctx.billing_account_id,
            target_id: args.target_id,
            market_id: args.market_id,
          })
        ),
      // bug.5022 — writes also run inside `withTenantScope(appDb, ...)` so
      // RLS on `poly_copy_trade_{fills,decisions}` enforces tenant isolation
      // at the DB layer for inserts too, not just reads. The
      // advisory_xact_lock inside `insertPendingOnDb`'s cap path holds for
      // the lifetime of the outer withTenantScope tx (the inner
      // `db.transaction(...)` becomes a SAVEPOINT under the outer tx) —
      // serializing concurrent inserts on the same (billing, market, token)
      // tuple, same semantics as the root path.
      insertPending: (input: TenantScopedInsertPendingInput) =>
        withTenantScope(appDb, actor, async (tx) =>
          insertPendingOnDb(tx, {
            ...input,
            billing_account_id: ctx.billing_account_id,
            created_by_user_id: ctx.created_by_user_id,
          })
        ),
      recordDecision: (input: TenantScopedRecordDecisionInput) =>
        withTenantScope(appDb, actor, async (tx) =>
          recordDecisionOnDb(tx, {
            ...input,
            billing_account_id: ctx.billing_account_id,
            created_by_user_id: ctx.created_by_user_id,
          })
        ),
    };
  };

  // Loose `db` type for shared impl helpers — accepts both a
  // `PostgresJsDatabase` (the legacy root path, `deps.db`) and the `tx`
  // handed to us by `withTenantScope` (forTenant path), which is a
  // postgres-js `PgTransaction`. Same driver, slightly different generic
  // shapes; carrying the union through every helper signature isn't worth
  // it. Internal — not exposed.
  // biome-ignore lint/suspicious/noExplicitAny: structural widening between PgDatabase + PgTransaction
  type AnyDb = any;

  async function snapshotStateOnDb(
    db: AnyDb,
    target_id: string,
    billing_account_id: string
  ): Promise<StateSnapshot> {
    try {
      const [spendRows, rateRows, cidRows, positionRows] = await Promise.all([
        db
          .select({
            spent: sum(
              sql<string>`COALESCE((${polyCopyTradeFills.attributes}->>'size_usdc')::numeric, 0)`
            ),
          })
          .from(polyCopyTradeFills)
          .where(
            and(
              eq(polyCopyTradeFills.billingAccountId, billing_account_id),
              eq(polyCopyTradeFills.targetId, target_id),
              gte(
                polyCopyTradeFills.createdAt,
                sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`
              )
            )
          ),
        db
          .select({ n: count() })
          .from(polyCopyTradeFills)
          .where(
            and(
              eq(polyCopyTradeFills.billingAccountId, billing_account_id),
              eq(polyCopyTradeFills.targetId, target_id),
              gte(polyCopyTradeFills.createdAt, sql`now() - interval '1 hour'`)
            )
          ),
        // bug.5023: bound the COID/fill_id dedup window to the last
        // SNAPSHOT_DEDUP_WINDOW_DAYS days + cap at SNAPSHOT_DEDUP_ROW_CAP.
        // Pre-bug.5023 this query was unbounded — it returned every fill row
        // this tenant had ever written for this target, hydrated into JS heap
        // as two parallel string[]s on every fill processed by mirror-pipeline.
        // The DEDUP_WINDOW_IS_BOUNDED invariant + the PK `(target_id, fill_id)`
        // ON CONFLICT DO NOTHING backstop together guarantee correctness: any
        // older COID/fill_id that escapes the window collides on insert and
        // is a silent no-op. ORDER BY ... DESC + LIMIT keeps the most-recent
        // rows, which are the ones the cursor-bounded fill stream could
        // plausibly replay.
        db
          .select({
            cid: polyCopyTradeFills.clientOrderId,
            fill_id: polyCopyTradeFills.fillId,
          })
          .from(polyCopyTradeFills)
          .where(
            and(
              eq(polyCopyTradeFills.billingAccountId, billing_account_id),
              eq(polyCopyTradeFills.targetId, target_id),
              gte(
                polyCopyTradeFills.createdAt,
                sql`now() - interval '${sql.raw(String(SNAPSHOT_DEDUP_WINDOW_DAYS))} days'`
              )
            )
          )
          .orderBy(desc(polyCopyTradeFills.createdAt))
          .limit(SNAPSHOT_DEDUP_ROW_CAP),
        db
          .select({
            market_id: polyCopyTradeFills.marketId,
            token_id: sql<
              string | null
            >`${polyCopyTradeFills.attributes}->>'token_id'`,
            net_shares: sql<string>`COALESCE(SUM(
                CASE WHEN ${polyCopyTradeFills.attributes}->>'side' = 'BUY'
                       THEN  (${polyCopyTradeFills.attributes}->>'size_usdc')::numeric / NULLIF((${polyCopyTradeFills.attributes}->>'limit_price')::numeric, 0)
                     WHEN ${polyCopyTradeFills.attributes}->>'side' = 'SELL'
                       THEN -((${polyCopyTradeFills.attributes}->>'size_usdc')::numeric / NULLIF((${polyCopyTradeFills.attributes}->>'limit_price')::numeric, 0))
                     ELSE 0 END
              ), 0)`,
            gross_usdc_in: sql<string>`COALESCE(SUM(
                CASE WHEN ${polyCopyTradeFills.attributes}->>'side' = 'BUY'
                       THEN (${polyCopyTradeFills.attributes}->>'size_usdc')::numeric
                     ELSE 0 END
              ), 0)`,
            gross_shares_in: sql<string>`COALESCE(SUM(
                CASE WHEN ${polyCopyTradeFills.attributes}->>'side' = 'BUY'
                       THEN (${polyCopyTradeFills.attributes}->>'size_usdc')::numeric / NULLIF((${polyCopyTradeFills.attributes}->>'limit_price')::numeric, 0)
                     ELSE 0 END
              ), 0)`,
          })
          .from(polyCopyTradeFills)
          .where(
            and(
              eq(polyCopyTradeFills.billingAccountId, billing_account_id),
              eq(polyCopyTradeFills.targetId, target_id),
              inArray(polyCopyTradeFills.status, [
                "pending",
                "open",
                "filled",
                "partial",
              ]),
              activeRestingPosition
            )
          )
          .groupBy(
            polyCopyTradeFills.marketId,
            sql`${polyCopyTradeFills.attributes}->>'token_id'`
          ),
      ]);

      return {
        today_spent_usdc: Number(spendRows[0]?.spent ?? 0),
        fills_last_hour: Number(rateRows[0]?.n ?? 0),
        already_placed_ids: cidRows.map((r: { cid: string }) => r.cid),
        placed_fill_ids: cidRows.map((r: { fill_id: string }) => r.fill_id),
        position_aggregates: materializeIntentAggregates(positionRows),
      };
    } catch (err: unknown) {
      log.warn(
        {
          event: EVENT_NAMES.ADAPTER_ORDER_LEDGER_SNAPSHOT_ERROR,
          errorCode: "snapshot_fail_closed",
          target_id,
          billing_account_id,
          err: err instanceof Error ? err.message : String(err),
        },
        "order-ledger snapshot failed; returning zeroes"
      );
      return {
        today_spent_usdc: 0,
        fills_last_hour: 0,
        already_placed_ids: [],
        placed_fill_ids: [],
        position_aggregates: [],
      };
    }
  }

  async function cumulativeIntentImpl(
    db: AnyDb,
    billing_account_id: string,
    market_id: string,
    token_id: string
  ): Promise<number> {
    try {
      const rows = await db
        .select({
          sum: sum(
            sql<string>`CASE
                WHEN ${polyCopyTradeFills.status} = 'canceled'
                  THEN COALESCE(
                    (${polyCopyTradeFills.attributes}->>'filled_size_usdc')::numeric,
                    (${polyCopyTradeFills.attributes}->>'size_usdc')::numeric,
                    0
                  )
                WHEN ${polyCopyTradeFills.status} IN ('pending','open','filled','partial')
                  THEN COALESCE((${polyCopyTradeFills.attributes}->>'size_usdc')::numeric, 0)
                WHEN ${polyCopyTradeFills.status} = 'error'
                     AND ${polyCopyTradeFills.attributes}->>'placement' = 'market_fok'
                  THEN COALESCE((${polyCopyTradeFills.attributes}->>'size_usdc')::numeric, 0)
                ELSE 0
              END`
          ),
        })
        .from(polyCopyTradeFills)
        .where(
          and(
            eq(polyCopyTradeFills.billingAccountId, billing_account_id),
            eq(polyCopyTradeFills.marketId, market_id),
            sql`${polyCopyTradeFills.attributes}->>'token_id' = ${token_id}`,
            activeRestingPosition,
            or(
              inArray(polyCopyTradeFills.status, [
                "pending",
                "open",
                "filled",
                "partial",
                "canceled",
              ]),
              and(
                eq(polyCopyTradeFills.status, "error"),
                sql`${polyCopyTradeFills.attributes}->>'placement' = 'market_fok'`
              )
            )
          )
        );
      return Number(rows[0]?.sum ?? 0);
    } catch (err: unknown) {
      log.warn(
        {
          event: EVENT_NAMES.ADAPTER_ORDER_LEDGER_SNAPSHOT_ERROR,
          errorCode: "cumulative_intent_fail_closed",
          billing_account_id,
          market_id,
          token_id,
          err: err instanceof Error ? err.message : String(err),
        },
        "order-ledger cumulativeIntentForMarketToken failed; returning Infinity (skip placement)"
      );
      return Number.POSITIVE_INFINITY;
    }
  }

  async function hasOpenForMarketImpl(
    db: AnyDb,
    args: {
      billing_account_id: string;
      target_id: string;
      market_id: string;
    }
  ): Promise<boolean> {
    try {
      const rows = await db
        .select({ cid: polyCopyTradeFills.clientOrderId })
        .from(polyCopyTradeFills)
        .where(
          and(
            eq(polyCopyTradeFills.billingAccountId, args.billing_account_id),
            eq(polyCopyTradeFills.targetId, args.target_id),
            eq(polyCopyTradeFills.marketId, args.market_id),
            activeRestingPosition,
            inArray(polyCopyTradeFills.status, ["pending", "open", "partial"])
          )
        )
        .limit(1);
      return rows.length > 0;
    } catch (err: unknown) {
      log.warn(
        {
          event: EVENT_NAMES.ADAPTER_ORDER_LEDGER_SNAPSHOT_ERROR,
          errorCode: "has_open_for_market_fail_closed",
          billing_account_id: args.billing_account_id,
          target_id: args.target_id,
          market_id: args.market_id,
          err: err instanceof Error ? err.message : String(err),
        },
        "order-ledger hasOpenForMarket failed; returning true (skip placement)"
      );
      return true;
    }
  }

  async function findOpenForMarketImpl(
    db: AnyDb,
    args: {
      billing_account_id: string;
      target_id: string;
      market_id: string;
    }
  ): Promise<OpenOrderRow[]> {
    let rows: Array<{
      clientOrderId: string;
      orderId: string | null;
      status: string;
      billingAccountId: string;
      targetId: string;
      marketId: string;
      createdAt: Date;
      limitPrice: string | null;
    }>;
    try {
      rows = await db
        .select({
          clientOrderId: polyCopyTradeFills.clientOrderId,
          orderId: polyCopyTradeFills.orderId,
          status: polyCopyTradeFills.status,
          billingAccountId: polyCopyTradeFills.billingAccountId,
          targetId: polyCopyTradeFills.targetId,
          marketId: polyCopyTradeFills.marketId,
          createdAt: polyCopyTradeFills.createdAt,
          limitPrice: sql<
            string | null
          >`${polyCopyTradeFills.attributes}->>'limit_price'`,
        })
        .from(polyCopyTradeFills)
        .where(
          and(
            eq(polyCopyTradeFills.billingAccountId, args.billing_account_id),
            eq(polyCopyTradeFills.targetId, args.target_id),
            eq(polyCopyTradeFills.marketId, args.market_id),
            activeRestingPosition,
            inArray(polyCopyTradeFills.status, ["pending", "open", "partial"])
          )
        );
    } catch (err: unknown) {
      // Observability sibling to `snapshotStateOnDb` / `hasOpenForMarketImpl`.
      // Re-throw (don't return `[]`) — the caller would otherwise treat the
      // empty result as "no resting order" and proceed to place, racing
      // through the application-level dedup. The DB partial unique index is
      // the structural backstop, but skipping the tick is the safer mode
      // when our read of the truth fails.
      log.warn(
        {
          event: EVENT_NAMES.ADAPTER_ORDER_LEDGER_SNAPSHOT_ERROR,
          errorCode: "find_open_for_market_fail_closed",
          billing_account_id: args.billing_account_id,
          target_id: args.target_id,
          market_id: args.market_id,
          err: err instanceof Error ? err.message : String(err),
        },
        "order-ledger findOpenForMarket failed; rethrowing so caller skips this tick"
      );
      throw err;
    }
    return rows.map(
      (r: {
        clientOrderId: string;
        orderId: string | null;
        status: string;
        billingAccountId: string;
        targetId: string;
        marketId: string;
        createdAt: Date;
        limitPrice: string | null;
      }) => ({
        client_order_id: r.clientOrderId,
        order_id: r.orderId,
        status: r.status as LedgerRow["status"],
        billing_account_id: r.billingAccountId,
        target_id: r.targetId,
        market_id: r.marketId,
        created_at: r.createdAt,
        limit_price: parseLimitPrice(r.limitPrice),
      })
    );
  }

  async function insertPendingOnDb(
    db: AnyDb,
    input: InsertPendingInput
  ): Promise<void> {
    // Stash placement-display fields in `attributes` so the read API +
    // dashboard don't need to re-derive from the intent blob.
    const attrs = {
      size_usdc: input.intent.size_usdc,
      limit_price: input.intent.limit_price,
      market_id: input.intent.market_id,
      outcome: input.intent.outcome,
      side: input.intent.side,
      placement:
        typeof input.intent.attributes?.placement === "string"
          ? input.intent.attributes.placement
          : undefined,
      token_id:
        typeof input.intent.attributes?.token_id === "string"
          ? input.intent.attributes.token_id
          : undefined,
      condition_id:
        typeof input.intent.attributes?.condition_id === "string"
          ? input.intent.attributes.condition_id
          : undefined,
      target_wallet:
        typeof input.intent.attributes?.target_wallet === "string"
          ? input.intent.attributes.target_wallet
          : undefined,
      source_fill_id:
        typeof input.intent.attributes?.source_fill_id === "string"
          ? input.intent.attributes.source_fill_id
          : undefined,
      title:
        typeof input.intent.attributes?.title === "string"
          ? input.intent.attributes.title
          : undefined,
      slug:
        typeof input.intent.attributes?.slug === "string"
          ? input.intent.attributes.slug
          : undefined,
      event_slug:
        typeof input.intent.attributes?.event_slug === "string"
          ? input.intent.attributes.event_slug
          : undefined,
      event_title:
        typeof input.intent.attributes?.event_title === "string"
          ? input.intent.attributes.event_title
          : undefined,
      end_date:
        typeof input.intent.attributes?.end_date === "string"
          ? input.intent.attributes.end_date
          : undefined,
      game_start_time:
        typeof input.intent.attributes?.game_start_time === "string"
          ? input.intent.attributes.game_start_time
          : undefined,
      transaction_hash:
        typeof input.intent.attributes?.transaction_hash === "string"
          ? input.intent.attributes.transaction_hash
          : undefined,
    };

    const values = {
      billingAccountId: input.billing_account_id,
      createdByUserId: input.created_by_user_id,
      targetId: input.target_id,
      fillId: input.fill_id,
      marketId: input.intent.market_id,
      observedAt: input.observed_at,
      clientOrderId: input.intent.client_order_id,
      orderId: null,
      status: "pending" as const,
      positionLifecycle: null,
      attributes: attrs,
      mode: effectiveMode,
    };

    const insert = async (insertDb: AnyDb) => {
      await insertDb
        .insert(polyCopyTradeFills)
        .values(values)
        .onConflictDoNothing({
          target: [
            polyCopyTradeFills.billingAccountId,
            polyCopyTradeFills.targetId,
            polyCopyTradeFills.fillId,
          ],
        });
    };

    try {
      // CAP_IS_PER_TOKEN_ID (bug.5004): the atomic check requires a real
      // token_id. `plan-mirror.ts::buildIntent` falls back to `""` when
      // `fill.attributes.asset` is non-string (defensive); treat that as
      // "no per-token cap available" rather than scoping to an empty-string
      // token (which would silently match no rows and bypass the cap).
      const rawTokenId =
        typeof input.intent.attributes?.token_id === "string"
          ? input.intent.attributes.token_id
          : undefined;
      const intentTokenId =
        rawTokenId !== undefined && rawTokenId.length > 0
          ? rawTokenId
          : undefined;
      if (
        input.max_market_intent_usdc !== undefined &&
        input.intent.side === "BUY" &&
        intentTokenId !== undefined
      ) {
        const maxMarketIntentUsdc = input.max_market_intent_usdc;
        const lockToken = intentTokenId;
        // `db.transaction()` opens a top-level tx when `db` is `deps.db` and
        // a SAVEPOINT when `db` is already a tx (withTenantScope path). The
        // advisory_xact_lock holds for the lifetime of the enclosing tx,
        // which is correct in both cases — under withTenantScope it holds
        // for the entire RLS-scoped tx, serializing concurrent inserts on
        // the same (billing, market, token) tuple as intended.
        await db.transaction(async (tx: AnyDb) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.billing_account_id}:${input.intent.market_id}:${lockToken}`}))`
          );
          const rows = await tx
            .select({
              sum: sum(
                sql<string>`COALESCE((${polyCopyTradeFills.attributes}->>'size_usdc')::numeric, 0)`
              ),
            })
            .from(polyCopyTradeFills)
            .where(
              and(
                eq(
                  polyCopyTradeFills.billingAccountId,
                  input.billing_account_id
                ),
                eq(polyCopyTradeFills.marketId, input.intent.market_id),
                sql`${polyCopyTradeFills.attributes}->>'token_id' = ${lockToken}`,
                activeRestingPosition,
                or(
                  inArray(polyCopyTradeFills.status, [
                    "pending",
                    "open",
                    "filled",
                    "partial",
                  ]),
                  and(
                    eq(polyCopyTradeFills.status, "error"),
                    sql`${polyCopyTradeFills.attributes}->>'placement' = 'market_fok'`
                  )
                )
              )
            );
          const currentIntent = Number(rows[0]?.sum ?? 0);
          if (currentIntent + input.intent.size_usdc > maxMarketIntentUsdc) {
            throw new PositionCapReachedError(
              input.billing_account_id,
              input.intent.market_id,
              lockToken,
              currentIntent,
              input.intent.size_usdc,
              maxMarketIntentUsdc
            );
          }
          await insert(tx);
        });
      } else {
        await insert(db);
      }
    } catch (err: unknown) {
      // Partial unique index rejection → typed AlreadyRestingError. task.5001.
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === PG_UNIQUE_VIOLATION
      ) {
        throw new AlreadyRestingError(
          input.billing_account_id,
          input.target_id,
          input.intent.market_id
        );
      }
      throw err;
    }
  }

  async function recordDecisionOnDb(
    db: AnyDb,
    input: RecordDecisionInput
  ): Promise<void> {
    await db.insert(polyCopyTradeDecisions).values({
      billingAccountId: input.billing_account_id,
      createdByUserId: input.created_by_user_id,
      targetId: input.target_id,
      fillId: input.fill_id,
      outcome: input.outcome,
      reason: input.reason,
      intent: input.intent,
      receipt: input.receipt,
      decidedAt: input.decided_at,
      mode: effectiveMode,
    });
  }

  const root: OrderLedger = {
    forTenant: buildTenantSurface,

    // bug.5022 — legacy root entry point. Delegates to `snapshotStateOnDb`
    // running on `deps.db` (serviceDb / BYPASSRLS). `forTenant(ctx).snapshotState`
    // is the RLS-enforced canonical surface. Marked `@deprecated` in the
    // OrderLedger interface; task.5012 migrates the remaining callers.
    snapshotState(
      target_id: string,
      billing_account_id: string
    ): Promise<StateSnapshot> {
      return snapshotStateOnDb(deps.db, target_id, billing_account_id);
    },

    // bug.5022 — legacy root entry point. Delegates to `cumulativeIntentImpl`
    // running on `deps.db`. `forTenant(ctx).cumulativeIntentForMarketToken`
    // is the RLS-enforced canonical surface.
    cumulativeIntentForMarketToken(
      billing_account_id: string,
      market_id: string,
      token_id: string
    ): Promise<number> {
      return cumulativeIntentImpl(
        deps.db,
        billing_account_id,
        market_id,
        token_id
      );
    },

    // bug.5022 — legacy root entry point. Delegates to `insertPendingOnDb`
    // running on `deps.db`. `forTenant(ctx).insertPending` is the
    // RLS-enforced canonical surface; both paths share one implementation.
    insertPending(input: InsertPendingInput): Promise<void> {
      return insertPendingOnDb(deps.db, input);
    },

    async markOrderId(params: {
      client_order_id: string;
      receipt: import("@cogni/poly-market-provider").OrderReceipt;
    }): Promise<void> {
      // Update by `client_order_id` — unique-by-construction across rows since
      // cid is deterministic from `(target_id, fill_id)` (PK).
      const status: LedgerRow["status"] = mapReceiptStatus(
        params.receipt.status
      );
      const positionLifecycle = lifecycleFromOrderUpdate(
        status,
        params.receipt.filled_size_usdc
      );
      const fillColumns = realizedFillColumns(params.receipt);
      await deps.db
        .update(polyCopyTradeFills)
        .set({
          orderId: params.receipt.order_id,
          status,
          ...(positionLifecycle !== null
            ? {
                positionLifecycle: preserveTerminalLifecycle(positionLifecycle),
              }
            : {}),
          ...fillColumns,
          updatedAt: new Date(),
          attributes: sql`COALESCE(${polyCopyTradeFills.attributes}, '{}'::jsonb) || ${JSON.stringify(
            {
              filled_size_usdc: params.receipt.filled_size_usdc ?? 0,
              submitted_at: params.receipt.submitted_at,
            }
          )}::jsonb`,
        })
        .where(eq(polyCopyTradeFills.clientOrderId, params.client_order_id));
    },

    async markError(params: {
      client_order_id: string;
      error: string;
    }): Promise<void> {
      // Cap error string at 512 chars — matches executor log truncation to
      // keep jsonb bounded for grafana / dashboard rendering.
      const truncated =
        params.error.length > 512
          ? `${params.error.slice(0, 512)}…`
          : params.error;
      await deps.db
        .update(polyCopyTradeFills)
        .set({
          status: "error",
          updatedAt: new Date(),
          attributes: sql`COALESCE(${polyCopyTradeFills.attributes}, '{}'::jsonb) || ${JSON.stringify(
            { error: truncated }
          )}::jsonb`,
        })
        .where(eq(polyCopyTradeFills.clientOrderId, params.client_order_id));
    },

    // bug.5022 — legacy root entry point. Delegates to `recordDecisionOnDb`
    // running on `deps.db`. `forTenant(ctx).recordDecision` is the
    // RLS-enforced canonical surface.
    recordDecision(input: RecordDecisionInput): Promise<void> {
      return recordDecisionOnDb(deps.db, input);
    },

    async listRecent(opts: ListRecentOptions): Promise<LedgerRow[]> {
      const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
      // Tenant clamp is always applied — the adapter runs on the BYPASSRLS
      // service connection, so this WHERE is the only thing keeping the orders
      // route from leaking cross-tenant ledger rows.
      const whereClause = opts.target_id
        ? and(
            eq(polyCopyTradeFills.billingAccountId, opts.billing_account_id),
            eq(polyCopyTradeFills.targetId, opts.target_id)
          )
        : eq(polyCopyTradeFills.billingAccountId, opts.billing_account_id);

      const rows = await deps.db
        .select()
        .from(polyCopyTradeFills)
        .where(whereClause)
        .orderBy(desc(polyCopyTradeFills.observedAt))
        .limit(limit);

      return rows.map(mapLedgerRow);
    },

    async listTenantPositions(
      opts: ListTenantPositionsOptions
    ): Promise<LedgerRow[]> {
      const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
      const statuses = opts.statuses ?? ["open", "filled", "partial"];

      const rows = await deps.db
        .select()
        .from(polyCopyTradeFills)
        .where(
          and(
            eq(polyCopyTradeFills.billingAccountId, opts.billing_account_id),
            inArray(polyCopyTradeFills.status, statuses)
          )
        )
        .orderBy(desc(polyCopyTradeFills.observedAt))
        .limit(limit);

      return rows.map(mapLedgerRow);
    },

    async dailyTradeCounts(opts: {
      billing_account_id: string;
      capturedAt: Date;
      windowDays: number;
    }): Promise<Array<{ day: string; n: number }>> {
      const rows = (await deps.db.execute(sql`
        SELECT
          to_char(date_trunc('day', ${polyCopyTradeFills.observedAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
          COUNT(*)::int AS n
        FROM ${polyCopyTradeFills}
        WHERE ${polyCopyTradeFills.billingAccountId} = ${opts.billing_account_id}
          AND ${polyCopyTradeFills.observedAt} >= now() - (${opts.windowDays} || ' days')::interval
          AND (
            COALESCE((${polyCopyTradeFills.attributes}->>'filled_size_usdc')::numeric, 0) > 0
            OR (
              ${polyCopyTradeFills.status} IN ('filled','partial')
              AND COALESCE((${polyCopyTradeFills.attributes}->>'size_usdc')::numeric, 0) > 0
            )
          )
        GROUP BY 1
        ORDER BY 1
      `)) as unknown as { rows?: Array<Record<string, unknown>> };
      const list =
        rows.rows ?? (rows as unknown as Array<Record<string, unknown>>);
      const byDay = new Map<string, number>();
      for (const r of list as Array<Record<string, unknown>>) {
        byDay.set(String(r.day ?? ""), Number(r.n ?? 0));
      }
      return buildUtcDayWindow(opts.capturedAt, opts.windowDays).map((day) => ({
        day,
        n: byDay.get(day) ?? 0,
      }));
    },

    async listOpenOrPending(
      opts?: ListOpenOrPendingOptions
    ): Promise<LedgerRow[]> {
      const olderThanMs = opts?.olderThanMs ?? 30_000;
      const limit = opts?.limit ?? 200;

      const rows = await deps.db
        .select()
        .from(polyCopyTradeFills)
        .where(
          and(
            sql`${polyCopyTradeFills.status} IN ('pending','open')`,
            activeRestingPosition,
            sql`${polyCopyTradeFills.createdAt} < now() - make_interval(secs => ${olderThanMs} / 1000.0)`
          )
        )
        .orderBy(polyCopyTradeFills.createdAt)
        .limit(limit);

      return rows.map(mapLedgerRow);
    },

    async updateStatus(input: UpdateStatusInput): Promise<void> {
      // Build the attributes patch only for the fields actually provided.
      const patch: Record<string, unknown> = {};
      if (input.filled_size_usdc !== undefined) {
        patch.filled_size_usdc = input.filled_size_usdc;
      }
      if (input.reason !== undefined) {
        patch.reason = input.reason;
      }
      const fillColumns = realizedFillColumns(input);
      const positionLifecycle = lifecycleFromOrderUpdate(
        input.status,
        input.filled_size_usdc
      );

      await deps.db
        .update(polyCopyTradeFills)
        .set({
          status: input.status,
          ...(input.order_id !== undefined ? { orderId: input.order_id } : {}),
          ...(positionLifecycle !== null
            ? {
                positionLifecycle: preserveTerminalLifecycle(positionLifecycle),
              }
            : {}),
          ...fillColumns,
          updatedAt: new Date(),
          ...(Object.keys(patch).length > 0
            ? {
                attributes: sql`COALESCE(${polyCopyTradeFills.attributes}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
              }
            : {}),
        })
        .where(eq(polyCopyTradeFills.clientOrderId, input.client_order_id));
    },

    async markSynced(client_order_ids: string[]): Promise<void> {
      // No-op on empty array — avoids a vacuous UPDATE that touches no rows.
      if (client_order_ids.length === 0) return;
      await deps.db
        .update(polyCopyTradeFills)
        .set({ syncedAt: sql`now()` })
        .where(inArray(polyCopyTradeFills.clientOrderId, client_order_ids));
    },

    async markCanceled(params: {
      client_order_id: string;
      reason: LedgerCancelReason;
    }): Promise<void> {
      await deps.db
        .update(polyCopyTradeFills)
        .set({
          status: "canceled",
          updatedAt: new Date(),
          attributes: sql`COALESCE(${polyCopyTradeFills.attributes}, '{}'::jsonb) || ${JSON.stringify(
            { reason: params.reason }
          )}::jsonb`,
        })
        .where(eq(polyCopyTradeFills.clientOrderId, params.client_order_id));
    },

    async markPositionClosedByAsset(
      input: MarkPositionClosedByAssetInput
    ): Promise<number> {
      const rows = await deps.db
        .update(polyCopyTradeFills)
        .set({
          positionLifecycle: "closed",
          updatedAt: input.closed_at,
          attributes: sql`COALESCE(${polyCopyTradeFills.attributes}, '{}'::jsonb) || ${JSON.stringify(
            {
              closed_at: input.closed_at.toISOString(),
              close_order_id: input.close_order_id,
              close_client_order_id: input.close_client_order_id,
              close_reason: input.reason,
            }
          )}::jsonb`,
        })
        .where(
          and(
            eq(polyCopyTradeFills.billingAccountId, input.billing_account_id),
            sql`${polyCopyTradeFills.attributes}->>'token_id' = ${input.token_id}`,
            notPositionTerminal,
            hasPositionLifecycleOrExecution
          )
        )
        .returning({ clientOrderId: polyCopyTradeFills.clientOrderId });
      return rows.length;
    },

    async markPositionLifecycleByAsset(
      input: MarkPositionLifecycleByAssetInput
    ): Promise<number> {
      const incomingLifecycleIsTerminal = [
        "closed",
        "redeemed",
        "loser",
        "dust",
        "abandoned",
      ].includes(input.lifecycle);
      const terminalCorrectionGuard =
        input.terminal_correction === "redeem_reorg" &&
        input.lifecycle === "redeem_pending"
          ? sql`(${notPositionTerminal} OR ${polyCopyTradeFills.positionLifecycle} = 'redeemed')`
          : notPositionTerminal;
      const rows = await deps.db
        .update(polyCopyTradeFills)
        .set({
          positionLifecycle: input.lifecycle,
          updatedAt: input.updated_at,
        })
        .where(
          and(
            eq(polyCopyTradeFills.billingAccountId, input.billing_account_id),
            sql`${polyCopyTradeFills.attributes}->>'token_id' = ${input.token_id}`,
            incomingLifecycleIsTerminal ? undefined : terminalCorrectionGuard,
            hasPositionLifecycleOrExecution
          )
        )
        .returning({ clientOrderId: polyCopyTradeFills.clientOrderId });
      return rows.length;
    },

    async markPositionLifecycleByConditionId(
      input: MarkPositionLifecycleByConditionIdInput
    ): Promise<number> {
      const normalizedMarketId = `prediction-market:polymarket:${input.condition_id}`;
      const incomingLifecycleIsTerminal = [
        "closed",
        "redeemed",
        "loser",
        "dust",
        "abandoned",
      ].includes(input.lifecycle);
      const rows = await deps.db
        .update(polyCopyTradeFills)
        .set({
          positionLifecycle: input.lifecycle,
          updatedAt: input.updated_at,
        })
        .where(
          and(
            eq(polyCopyTradeFills.billingAccountId, input.billing_account_id),
            or(
              sql`${polyCopyTradeFills.attributes}->>'condition_id' = ${input.condition_id}`,
              eq(polyCopyTradeFills.marketId, input.condition_id),
              eq(polyCopyTradeFills.marketId, normalizedMarketId)
            ),
            incomingLifecycleIsTerminal ? undefined : notPositionTerminal,
            hasPositionLifecycleOrExecution
          )
        )
        .returning({ clientOrderId: polyCopyTradeFills.clientOrderId });
      return rows.length;
    },

    hasOpenForMarket(args: {
      billing_account_id: string;
      target_id: string;
      market_id: string;
    }): Promise<boolean> {
      return hasOpenForMarketImpl(deps.db, args);
    },

    findOpenForMarket(args: {
      billing_account_id: string;
      target_id: string;
      market_id: string;
    }): Promise<OpenOrderRow[]> {
      return findOpenForMarketImpl(deps.db, args);
    },

    async findStaleOpen(args: {
      max_age_minutes: number;
    }): Promise<OpenOrderRow[]> {
      const rows = await deps.db
        .select({
          clientOrderId: polyCopyTradeFills.clientOrderId,
          orderId: polyCopyTradeFills.orderId,
          status: polyCopyTradeFills.status,
          billingAccountId: polyCopyTradeFills.billingAccountId,
          targetId: polyCopyTradeFills.targetId,
          marketId: polyCopyTradeFills.marketId,
          createdAt: polyCopyTradeFills.createdAt,
          limitPrice: sql<
            string | null
          >`${polyCopyTradeFills.attributes}->>'limit_price'`,
        })
        .from(polyCopyTradeFills)
        .where(
          and(
            inArray(polyCopyTradeFills.status, ["pending", "open", "partial"]),
            activeRestingPosition,
            lt(
              polyCopyTradeFills.createdAt,
              sql`now() - make_interval(mins => ${args.max_age_minutes})`
            )
          )
        );
      return rows.map((r) => ({
        client_order_id: r.clientOrderId,
        order_id: r.orderId,
        status: r.status as LedgerRow["status"],
        billing_account_id: r.billingAccountId,
        target_id: r.targetId,
        market_id: r.marketId,
        created_at: r.createdAt,
        limit_price: parseLimitPrice(r.limitPrice),
      }));
    },

    async syncHealthSummary(): Promise<SyncHealthSummary> {
      // Single round-trip: three filtered aggregates in one SELECT.
      // oldest_ms — age of least-recently-synced row that HAS synced_at.
      //   Only rows with non-null synced_at qualify; never-synced rows are
      //   counted separately in never_synced.
      // stale_60s — rows whose synced_at is older than 60 seconds.
      // never_synced — rows with NULL synced_at.
      const rows = await deps.db.execute(
        sql<{
          oldest_ms: string | null;
          stale_60s: string;
          never_synced: string;
        }>`
          SELECT
            CAST(
              EXTRACT(EPOCH FROM (now() - MIN(${polyCopyTradeFills.syncedAt})))
              * 1000
              AS bigint
            ) AS oldest_ms,
            COUNT(*) FILTER (
              WHERE ${polyCopyTradeFills.syncedAt} IS NOT NULL
                AND ${polyCopyTradeFills.syncedAt} < now() - interval '60 seconds'
            ) AS stale_60s,
            COUNT(*) FILTER (
              WHERE ${polyCopyTradeFills.syncedAt} IS NULL
            ) AS never_synced
          FROM ${polyCopyTradeFills}
        `
      );

      // postgres-js Drizzle returns the rows as an array-like `RowList`
      // directly (no `.rows` wrapper). The pre-bug.5022 NodePgDatabase
      // cast made TypeScript think this was a node-postgres `QueryResult`
      // with a `.rows` field — but the underlying client was always
      // postgres-js, so `rows.rows[0]` quietly evaluated to `undefined`
      // at runtime and this method's `oldest_synced_row_age_ms` always
      // returned `null`. Now indexing the array directly.
      const row = (
        rows as unknown as Array<{
          oldest_ms: string | null;
          stale_60s: string;
          never_synced: string;
        }>
      )[0];

      return {
        oldest_synced_row_age_ms:
          row?.oldest_ms != null ? Number(row.oldest_ms) : null,
        rows_stale_over_60s: Number(row?.stale_60s ?? 0),
        rows_never_synced: Number(row?.never_synced ?? 0),
      };
    },
  };

  return root;
}

function mapLedgerRow(r: typeof polyCopyTradeFills.$inferSelect): LedgerRow {
  return {
    target_id: r.targetId,
    fill_id: r.fillId,
    observed_at: r.observedAt,
    client_order_id: r.clientOrderId,
    order_id: r.orderId,
    // Schema CHECK enforces the set; cast is safe at the type boundary.
    status: r.status as LedgerRow["status"],
    position_lifecycle:
      (r.positionLifecycle as LedgerPositionLifecycle | null) ?? null,
    attributes: (r.attributes as Record<string, unknown> | null) ?? null,
    synced_at: r.syncedAt,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    billing_account_id: r.billingAccountId,
    // Schema CHECK enforces ('live','paper'); cast is safe at the type boundary.
    mode: r.mode as LedgerRow["mode"],
  };
}

function realizedFillColumns(input: {
  fill_price?: number | undefined;
  total_shares?: number | undefined;
  fees_usdc?: number | undefined;
}): Partial<Record<"price" | "shares" | "feesUsdc", string>> {
  return {
    ...(typeof input.fill_price === "number"
      ? { price: input.fill_price.toString() }
      : {}),
    ...(typeof input.total_shares === "number"
      ? { shares: input.total_shares.toString() }
      : {}),
    ...(typeof input.fees_usdc === "number"
      ? { feesUsdc: input.fees_usdc.toString() }
      : {}),
  };
}

/**
 * Receipt `status` → ledger `status`. `OrderReceipt.status` is a narrower,
 * polymarket-shaped enum; map to the ledger's canonical set.
 */
function mapReceiptStatus(
  receiptStatus: import("@cogni/poly-market-provider").OrderReceipt["status"]
): LedgerRow["status"] {
  switch (receiptStatus) {
    case "filled":
      return "filled";
    case "partial":
      return "partial";
    case "canceled":
      return "canceled";
    case "open":
      return "open";
    default:
      // `unknown` / future additions fall through to `open` — CLOB accepted
      // it; surface it as live in the ledger until further state arrives.
      return "open";
  }
}

function lifecycleFromOrderUpdate(
  status: LedgerRow["status"],
  filledSizeUsdc: number | undefined
): LedgerPositionLifecycle | null {
  if (status === "filled" || status === "partial") return "open";
  if (filledSizeUsdc !== undefined && filledSizeUsdc > 0) return "open";
  return null;
}

function preserveTerminalLifecycle(next: LedgerPositionLifecycle) {
  return sql`CASE
    WHEN ${polyCopyTradeFills.positionLifecycle} IN ('closed','redeemed','loser','dust','abandoned')
      THEN ${polyCopyTradeFills.positionLifecycle}
    ELSE ${next}
  END`;
}

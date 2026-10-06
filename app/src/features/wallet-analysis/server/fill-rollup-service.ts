// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/fill-rollup-service`
 * Purpose: Incremental writer + shared read helpers for
 *   `poly_trader_fill_rollups_daily` — the per-(wallet, condition, token,
 *   UTC-day) rollup that replaces per-request full-history aggregation over
 *   `poly_trader_fills` in the four research reads (snapshot, benchmark,
 *   target-overlap, trader-comparison; 25-60s cold on prod 2026-09-28,
 *   task.research-rollup-read-models).
 * Scope: DB-only feature service. Caller injects DB/logger; owns the rollup
 *   accumulate/backfill SQL and the windowed-flows read fragment. No upstream
 *   HTTP anywhere in this module (the Data-API limiter is not involved).
 * Invariants:
 *   - SINGLE_STATEMENT_BATCH: each accumulate batch is ONE SQL statement
 *     (locked cursor read -> bounded fill batch -> rollup upsert -> watermark
 *     advance). A fill is folded into the rollup exactly once or the whole
 *     statement rolls back — re-running a window can never double-count.
 *   - WATERMARK_IS_INSERTION_KEY: the cursor stores the `(created_at, id)`
 *     tuple of the last rolled `poly_trader_fills` row. The tuple never
 *     round-trips through JS (Date would truncate Postgres microseconds and
 *     re-admit the boundary row); it moves only inside the batch statement.
 *   - CURSOR_ROW_SERIALIZES_ACCUMULATORS: `FOR UPDATE` on the cursor row makes
 *     concurrent accumulators (boot backfill vs observation tick) safe; the
 *     tick passes `skipIfLocked` (`NOWAIT`) so it never stalls behind the
 *     backfill walker.
 *   - FILLS_WRITERS_SERIALIZED_PER_WALLET: watermark soundness additionally
 *     requires per-wallet fills writers to be serialized, which holds today —
 *     the trader-observation tick is the only `poly_trader_fills` writer, is
 *     leader-elected (task.5016), and holds its tick guard until abandoned
 *     writers settle (bug.5297). `created_at` (insert-transaction start time)
 *     is therefore monotone per wallet across commits, so "max visible
 *     insertion key" can never skip a not-yet-visible fill.
 *   - READERS_ADD_THE_TAIL: `windowedFillFlowsSelect` emits rolled full days +
 *     the boundary-day fill fragment + the not-yet-rolled fill tail in one
 *     statement (single snapshot), so rollup-backed readers are exactly
 *     output-equivalent to the legacy full-scan aggregation at all times —
 *     including a wallet whose backfill has not run yet (everything is tail).
 * Side-effects: DB reads/writes via injected client; logs.
 * Links: work/items/task.research-rollup-read-models.md,
 *   src/features/wallet-analysis/server/trader-observation-service.ts,
 *   src/bootstrap/jobs/fill-rollup-backfill.job.ts
 * @public
 */

import { polyTraderWallets } from "@cogni/poly-db-schema/trader-activity";
import type { LoggerPort } from "@cogni/poly-market-provider";
import { type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import pLimit from "p-limit";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

/** Zero UUID — the cursor's "no fill rolled yet" tie-break sentinel. */
export const ROLLUP_ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** Full-history window start for `windowedFill*Select` (ALL / no window). */
export const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/** Fills folded per batch statement (design range 5-10k). */
export const DEFAULT_ROLLUP_BATCH_SIZE = 5_000;

/**
 * Hard ceiling for request-path research statements.
 *
 * The research routes intentionally degrade to slice warnings, so letting one
 * scan occupy a pool connection for minutes is strictly worse than cancelling
 * it. Keep this below the edge/readiness timeout: a dashboard request may use
 * every pool slot, and readiness must get a slot back before the boot SLO
 * declares a healthy replacement workload dead.
 */
export const RESEARCH_READ_STATEMENT_TIMEOUT_MS = 8_000;

/**
 * Batch budget per observation tick per wallet. Normal ticks ingest well under
 * one batch of new fills; the budget only matters while a wallet's history is
 * still draining (backfill job down), where 4x5k per 30s tick still converges.
 */
export const TICK_ROLLUP_MAX_BATCHES = 4;

/** Postgres error code for `FOR UPDATE NOWAIT` on a locked row. */
const LOCK_NOT_AVAILABLE = "55P03";

export interface AccumulateFillRollupsResult {
  /** Batch statements that folded at least one fill. */
  batches: number;
  /** Fills folded into the rollup by this call. */
  fills: number;
  /** True when the wallet's watermark reached the newest visible fill. */
  caughtUp: boolean;
  /** True when `skipIfLocked` was set and another accumulator held the cursor. */
  skippedLocked: boolean;
}

/**
 * Run request-path research reads with a Postgres-enforced statement ceiling.
 * SET LOCAL is transaction-scoped, so the timeout cannot leak through the
 * shared pool into trading or background jobs.
 */
export async function withResearchReadTimeout<T>(
  db: Db,
  fn: (tx: Db) => Promise<T>,
  timeoutMs = RESEARCH_READ_STATEMENT_TIMEOUT_MS
): Promise<T> {
  return await (db as unknown as {
    transaction: <R>(cb: (tx: Db) => Promise<R>) => Promise<R>;
  }).transaction(async (tx) => {
    await tx.execute(
      sql.raw(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`)
    );
    return await fn(tx);
  });
}

/**
 * Fold NEW `poly_trader_fills` rows (insertion key above the wallet's
 * watermark) into `poly_trader_fill_rollups_daily`, in bounded batches.
 * Idempotent: re-invoking with no new fills is a no-op; a crashed batch
 * leaves rollup + watermark untouched (single-statement atomicity).
 */
export async function accumulateFillRollups(
  db: Db,
  params: {
    traderWalletId: string;
    batchSize?: number;
    maxBatches?: number;
    /** Tick mode: skip (instead of block) when another accumulator holds the cursor row. */
    skipIfLocked?: boolean;
    /** Cooperative cancellation between batches (DB statements are not interruptible). */
    signal?: AbortSignal | undefined;
  }
): Promise<AccumulateFillRollupsResult> {
  const batchSize = Math.max(1, params.batchSize ?? DEFAULT_ROLLUP_BATCH_SIZE);
  const maxBatches = Math.max(1, params.maxBatches ?? Number.MAX_SAFE_INTEGER);

  await db.execute(sql`
    INSERT INTO poly_trader_fill_rollup_cursors (trader_wallet_id)
    VALUES (${params.traderWalletId}::uuid)
    ON CONFLICT (trader_wallet_id) DO NOTHING
  `);

  let batches = 0;
  let fills = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    if (params.signal?.aborted) {
      return { batches, fills, caughtUp: false, skippedLocked: false };
    }
    let batchFills: number;
    try {
      batchFills = await runAccumulateBatch(
        db,
        params.traderWalletId,
        batchSize,
        params.skipIfLocked === true
      );
    } catch (err: unknown) {
      if (params.skipIfLocked === true && isLockNotAvailable(err)) {
        return { batches, fills, caughtUp: false, skippedLocked: true };
      }
      throw err;
    }
    if (batchFills === 0) {
      return { batches, fills, caughtUp: true, skippedLocked: false };
    }
    batches += 1;
    fills += batchFills;
    if (batchFills < batchSize) {
      return { batches, fills, caughtUp: true, skippedLocked: false };
    }
  }
  return { batches, fills, caughtUp: false, skippedLocked: false };
}

/**
 * One accumulate batch as a single SQL statement (SINGLE_STATEMENT_BATCH /
 * WATERMARK_IS_INSERTION_KEY). Data-modifying CTEs share one snapshot; the
 * `FOR UPDATE` cursor read serializes concurrent accumulators, and under
 * READ COMMITTED a waiter re-reads the latest committed watermark before
 * selecting its batch, so overlapping batches cannot double-fold.
 * Returns the number of fills folded (0 = caught up).
 */
async function runAccumulateBatch(
  db: Db,
  traderWalletId: string,
  batchSize: number,
  skipIfLocked: boolean
): Promise<number> {
  const lockClause = skipIfLocked ? sql`FOR UPDATE NOWAIT` : sql`FOR UPDATE`;
  const result = (await db.execute(sql`
    WITH cur AS (
      SELECT c.last_created_at, c.last_fill_id
      FROM poly_trader_fill_rollup_cursors c
      WHERE c.trader_wallet_id = ${traderWalletId}::uuid
      ${lockClause}
    ),
    batch AS (
      -- LATERAL is load-bearing: it makes the cursor tuple a parameterized
      -- Index Cond on (trader_wallet_id, created_at, id). A plain join makes
      -- Postgres scan every already-rolled fill and apply the tuple as a Join
      -- Filter, turning each incremental batch into a growing history scan.
      SELECT f.condition_id, f.token_id, f.side, f.size_usdc, f.shares,
             f.observed_at, f.created_at, f.id
      FROM cur
      CROSS JOIN LATERAL (
        SELECT f.condition_id, f.token_id, f.side, f.size_usdc, f.shares,
               f.observed_at, f.created_at, f.id
        FROM poly_trader_fills f
        WHERE f.trader_wallet_id = ${traderWalletId}::uuid
          AND (f.created_at, f.id) > (cur.last_created_at, cur.last_fill_id)
        ORDER BY f.created_at ASC, f.id ASC
        LIMIT ${batchSize}
      ) f
    ),
    folded AS (
      INSERT INTO poly_trader_fill_rollups_daily AS r (
        trader_wallet_id, condition_id, token_id, day,
        fill_count, buy_count, sell_count,
        buy_usdc, sell_usdc, buy_shares, sell_shares,
        first_buy_observed_at, first_observed_at, last_observed_at, updated_at
      )
      SELECT
        ${traderWalletId}::uuid,
        b.condition_id,
        b.token_id,
        (b.observed_at AT TIME ZONE 'UTC')::date,
        COUNT(*)::int,
        COUNT(*) FILTER (WHERE b.side = 'BUY')::int,
        COUNT(*) FILTER (WHERE b.side = 'SELL')::int,
        COALESCE(SUM(b.size_usdc) FILTER (WHERE b.side = 'BUY'), 0),
        COALESCE(SUM(b.size_usdc) FILTER (WHERE b.side = 'SELL'), 0),
        COALESCE(SUM(b.shares) FILTER (WHERE b.side = 'BUY'), 0),
        COALESCE(SUM(b.shares) FILTER (WHERE b.side = 'SELL'), 0),
        MIN(b.observed_at) FILTER (WHERE b.side = 'BUY'),
        MIN(b.observed_at),
        MAX(b.observed_at),
        now()
      FROM batch b
      GROUP BY b.condition_id, b.token_id, (b.observed_at AT TIME ZONE 'UTC')::date
      ON CONFLICT (trader_wallet_id, condition_id, token_id, day) DO UPDATE SET
        fill_count = r.fill_count + EXCLUDED.fill_count,
        buy_count = r.buy_count + EXCLUDED.buy_count,
        sell_count = r.sell_count + EXCLUDED.sell_count,
        buy_usdc = r.buy_usdc + EXCLUDED.buy_usdc,
        sell_usdc = r.sell_usdc + EXCLUDED.sell_usdc,
        buy_shares = r.buy_shares + EXCLUDED.buy_shares,
        sell_shares = r.sell_shares + EXCLUDED.sell_shares,
        first_buy_observed_at = LEAST(r.first_buy_observed_at, EXCLUDED.first_buy_observed_at),
        first_observed_at = LEAST(r.first_observed_at, EXCLUDED.first_observed_at),
        last_observed_at = GREATEST(r.last_observed_at, EXCLUDED.last_observed_at),
        updated_at = EXCLUDED.updated_at
      RETURNING 1
    ),
    last AS (
      SELECT b.created_at, b.id
      FROM batch b
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT 1
    ),
    n AS (
      SELECT COUNT(*)::int AS batch_fills FROM batch
    )
    UPDATE poly_trader_fill_rollup_cursors c
    SET last_created_at = last.created_at,
        last_fill_id = last.id,
        rolled_fill_count = c.rolled_fill_count + n.batch_fills,
        updated_at = now()
    FROM last, n
    WHERE c.trader_wallet_id = ${traderWalletId}::uuid
    RETURNING n.batch_fills AS "batchFills"
  `)) as unknown as
    | Array<Record<string, unknown>>
    | { rows?: Array<Record<string, unknown>> };
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  const first = rows[0];
  return first ? Number(first.batchFills ?? 0) : 0;
}

function isLockNotAvailable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === LOCK_NOT_AVAILABLE;
}

/** Cap on per-wallet error messages surfaced in the backfill result. */
const MAX_REPORTED_BACKFILL_ERRORS = 5;

export interface BackfillFillRollupsResult {
  wallets: number;
  walletsCompleted: number;
  fills: number;
  batches: number;
  /** False when stopped early (signal) before every wallet caught up. */
  completed: boolean;
  /**
   * First few per-wallet error messages (capped). Per-wallet failures are
   * swallowed here (RESUMABLE at the watermark), so without this the boot
   * job's retry loop could not classify an all-wallets failure — e.g. the
   * rollup relation missing because the pod's migration lagged the image
   * (operator bug.5314).
   */
  errors: string[];
}

/**
 * One-shot backfill walker: drains EVERY observed wallet's fill history into
 * the rollup via the same accumulate function, strictly one wallet-batch at a
 * time (`pLimit(1)`), resumable at the per-wallet watermark. Safe to run
 * while the observation tick is live (CURSOR_ROW_SERIALIZES_ACCUMULATORS;
 * the tick side yields via NOWAIT). DB-only — no Polymarket calls.
 */
export async function backfillFillRollups(
  db: Db,
  params: {
    logger: LoggerPort;
    batchSize?: number;
    signal?: AbortSignal | undefined;
  }
): Promise<BackfillFillRollupsResult> {
  const log = params.logger.child({ component: "fill-rollup-backfill" });
  const limit = pLimit(1);
  // All wallets, including research-disabled ones — their historical fills
  // still exist and readers accept arbitrary addresses.
  const wallets = await db
    .select({ id: polyTraderWallets.id, address: polyTraderWallets.walletAddress })
    .from(polyTraderWallets)
    .orderBy(polyTraderWallets.createdAt);

  let fills = 0;
  let batches = 0;
  let walletsCompleted = 0;
  let stopped = false;
  const errors: string[] = [];

  await Promise.all(
    wallets.map((wallet) =>
      limit(async () => {
        if (stopped || params.signal?.aborted) {
          stopped = true;
          return;
        }
        const startedAt = Date.now();
        try {
          const result = await accumulateFillRollups(db, {
            traderWalletId: wallet.id,
            batchSize: params.batchSize ?? DEFAULT_ROLLUP_BATCH_SIZE,
            signal: params.signal,
          });
          fills += result.fills;
          batches += result.batches;
          if (result.caughtUp) walletsCompleted += 1;
          else stopped = true; // signal fired mid-wallet
          log.info(
            {
              event: "poly.fill_rollup.backfill_wallet",
              trader_wallet_id: wallet.id,
              wallet: wallet.address,
              fills: result.fills,
              batches: result.batches,
              caught_up: result.caughtUp,
              duration_ms: Date.now() - startedAt,
            },
            "fill-rollup backfill wallet pass complete"
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (errors.length < MAX_REPORTED_BACKFILL_ERRORS)
            errors.push(message);
          log.error(
            {
              event: "poly.fill_rollup.backfill_wallet_error",
              trader_wallet_id: wallet.id,
              wallet: wallet.address,
              err: message,
            },
            "fill-rollup backfill wallet failed — resumable at watermark"
          );
        }
      })
    )
  );

  return {
    wallets: wallets.length,
    walletsCompleted,
    fills,
    batches,
    completed: !stopped && walletsCompleted === wallets.length,
    errors,
  };
}

/**
 * Split a query window `[windowStartIso, now)` at the first UTC day boundary
 * at-or-after the window start. Rollup day-rows serve `day >= rollupFromDay`
 * exactly (their fills all have `observed_at >= rollupFromIso`); the
 * `[windowStartIso, rollupFromIso)` boundary fragment must be read from
 * fills directly (empty when the window starts exactly at UTC midnight —
 * including the epoch used for ALL/full-history reads).
 */
export function rollupWindowBounds(windowStartIso: string): {
  /** YYYY-MM-DD: first UTC day fully inside the window. */
  rollupFromDay: string;
  /** ISO timestamp of that day's start. */
  rollupFromIso: string;
} {
  const start = new Date(windowStartIso);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`rollupWindowBounds: invalid windowStartIso ${windowStartIso}`);
  }
  const dayStartMs = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate()
  );
  const fromMs =
    start.getTime() === dayStartMs ? dayStartMs : dayStartMs + 86_400_000;
  const from = new Date(fromMs);
  return {
    rollupFromDay: from.toISOString().slice(0, 10),
    rollupFromIso: from.toISOString(),
  };
}

/**
 * SQL fragment: per-(trader_wallet_id, condition_id, token_id) fill flows for
 * the window `[windowStartIso, now)`, exactly output-equivalent to grouping
 * the raw fills (READERS_ADD_THE_TAIL). Emits columns:
 * `trader_wallet_id, condition_id, token_id, fill_count, buy_count,
 * sell_count, buy_usdc, sell_usdc, buy_shares, sell_shares,
 * first_buy_observed_at, first_observed_at, last_observed_at`.
 *
 * Three disjoint, complete parts:
 *  1. rolled full days (`poly_trader_fill_rollups_daily.day >= rollupFromDay`),
 *  2. the boundary-day fill fragment `[windowStartIso, rollupFromIso)` read
 *     from fills regardless of rolled status (its rollup day-row is excluded),
 *  3. the not-yet-rolled tail: fills above the wallet's watermark with
 *     `observed_at >= rollupFromIso`.
 * Embed inside a single statement (one snapshot) — never split the parts
 * across statements or the watermark may move between them.
 *
 * `walletIds` may contain null (e.g. an absent comparison wallet): `IN (id,
 * NULL)` degrades to the non-null members, matching the legacy queries.
 */
/**
 * SQL fragment: per-wallet windowed fill COUNT (same three-part split as
 * `windowedFillFlowsSelect`, without the per-(condition, token) grouping).
 * Emits columns: `trader_wallet_id, trade_count`. Wallets with zero windowed
 * fills emit no row — COALESCE at the call site.
 */
export function windowedFillCountsSelect(params: {
  walletIds: ReadonlyArray<string | null>;
  windowStartIso: string;
}): SQL {
  const bounds = rollupWindowBounds(params.windowStartIso);
  const ids = sql.join(
    params.walletIds.map((id) => sql`${id}::uuid`),
    sql`, `
  );
  return sql`
    SELECT parts.trader_wallet_id, SUM(parts.n)::bigint AS trade_count
    FROM (
      SELECT r.trader_wallet_id, r.fill_count::bigint AS n
      FROM poly_trader_fill_rollups_daily r
      WHERE r.trader_wallet_id IN (${ids})
        AND r.day >= ${bounds.rollupFromDay}::date
      UNION ALL
      SELECT f.trader_wallet_id, 1::bigint
      FROM poly_trader_fills f
      WHERE f.trader_wallet_id IN (${ids})
        AND f.observed_at >= ${params.windowStartIso}::timestamptz
        AND f.observed_at < ${bounds.rollupFromIso}::timestamptz
      UNION ALL
      SELECT f.trader_wallet_id, 1::bigint
      FROM poly_trader_fills f
      LEFT JOIN poly_trader_fill_rollup_cursors c
        ON c.trader_wallet_id = f.trader_wallet_id
      WHERE f.trader_wallet_id IN (${ids})
        AND f.observed_at >= ${bounds.rollupFromIso}::timestamptz
        AND (f.created_at, f.id) > (
          COALESCE(c.last_created_at, 'epoch'::timestamptz),
          COALESCE(c.last_fill_id, ${ROLLUP_ZERO_UUID}::uuid)
        )
    ) parts
    GROUP BY parts.trader_wallet_id
  `;
}

export function windowedFillFlowsSelect(params: {
  walletIds: ReadonlyArray<string | null>;
  windowStartIso: string;
  /**
   * Optional condition scope. When set (non-empty), every part of the
   * three-way split (rolled days, boundary fragment, unrolled tail) is
   * filtered to `condition_id IN (...)` so the union stays exactly
   * output-equivalent to filtering the legacy full fills scan. `undefined`
   * or `[]` means no condition filter (existing callers unchanged).
   */
  conditionIds?: ReadonlyArray<string>;
  /**
   * Default preserves the historical byte-for-byte `condition_id IN (…)`
   * predicate. Dashboard identity-reconciliation readers opt into the
   * case-insensitive form for legacy differently-cased saved facts.
   */
  conditionIdentity?: "exact" | "case_insensitive";
}): SQL {
  const bounds = rollupWindowBounds(params.windowStartIso);
  const ids = sql.join(
    params.walletIds.map((id) => sql`${id}::uuid`),
    sql`, `
  );
  const conditionFilter = (column: SQL): SQL =>
    params.conditionIds !== undefined && params.conditionIds.length > 0
      ? sql` AND ${params.conditionIdentity === "case_insensitive" ? sql`lower(${column})` : column} IN (${sql.join(
          params.conditionIds.map((c) =>
            sql`${params.conditionIdentity === "case_insensitive" ? c.toLowerCase() : c}`
          ),
          sql`, `
        )})`
      : sql``;
  return sql`
    SELECT
      parts.trader_wallet_id,
      parts.condition_id,
      parts.token_id,
      SUM(parts.fill_count)::bigint AS fill_count,
      SUM(parts.buy_count)::bigint AS buy_count,
      SUM(parts.sell_count)::bigint AS sell_count,
      SUM(parts.buy_usdc) AS buy_usdc,
      SUM(parts.sell_usdc) AS sell_usdc,
      SUM(parts.buy_shares) AS buy_shares,
      SUM(parts.sell_shares) AS sell_shares,
      MIN(parts.first_buy_observed_at) AS first_buy_observed_at,
      MIN(parts.first_observed_at) AS first_observed_at,
      MAX(parts.last_observed_at) AS last_observed_at
    FROM (
      SELECT
        r.trader_wallet_id, r.condition_id, r.token_id,
        r.fill_count, r.buy_count, r.sell_count,
        r.buy_usdc, r.sell_usdc, r.buy_shares, r.sell_shares,
        r.first_buy_observed_at, r.first_observed_at, r.last_observed_at
      FROM poly_trader_fill_rollups_daily r
      WHERE r.trader_wallet_id IN (${ids})
        AND r.day >= ${bounds.rollupFromDay}::date${conditionFilter(sql`r.condition_id`)}
      UNION ALL
      SELECT
        f.trader_wallet_id, f.condition_id, f.token_id,
        1,
        CASE WHEN f.side = 'BUY' THEN 1 ELSE 0 END,
        CASE WHEN f.side = 'SELL' THEN 1 ELSE 0 END,
        CASE WHEN f.side = 'BUY' THEN f.size_usdc ELSE 0 END,
        CASE WHEN f.side = 'SELL' THEN f.size_usdc ELSE 0 END,
        CASE WHEN f.side = 'BUY' THEN f.shares ELSE 0 END,
        CASE WHEN f.side = 'SELL' THEN f.shares ELSE 0 END,
        CASE WHEN f.side = 'BUY' THEN f.observed_at END,
        f.observed_at,
        f.observed_at
      FROM poly_trader_fills f
      WHERE f.trader_wallet_id IN (${ids})
        AND f.observed_at >= ${params.windowStartIso}::timestamptz
        AND f.observed_at < ${bounds.rollupFromIso}::timestamptz${conditionFilter(sql`f.condition_id`)}
      UNION ALL
      SELECT
        f.trader_wallet_id, f.condition_id, f.token_id,
        1,
        CASE WHEN f.side = 'BUY' THEN 1 ELSE 0 END,
        CASE WHEN f.side = 'SELL' THEN 1 ELSE 0 END,
        CASE WHEN f.side = 'BUY' THEN f.size_usdc ELSE 0 END,
        CASE WHEN f.side = 'SELL' THEN f.size_usdc ELSE 0 END,
        CASE WHEN f.side = 'BUY' THEN f.shares ELSE 0 END,
        CASE WHEN f.side = 'SELL' THEN f.shares ELSE 0 END,
        CASE WHEN f.side = 'BUY' THEN f.observed_at END,
        f.observed_at,
        f.observed_at
      FROM poly_trader_fills f
      LEFT JOIN poly_trader_fill_rollup_cursors c
        ON c.trader_wallet_id = f.trader_wallet_id
      WHERE f.trader_wallet_id IN (${ids})
        AND f.observed_at >= ${bounds.rollupFromIso}::timestamptz
        AND (f.created_at, f.id) > (
          COALESCE(c.last_created_at, 'epoch'::timestamptz),
          COALESCE(c.last_fill_id, ${ROLLUP_ZERO_UUID}::uuid)
        )${conditionFilter(sql`f.condition_id`)}
    ) parts
    GROUP BY parts.trader_wallet_id, parts.condition_id, parts.token_id
  `;
}

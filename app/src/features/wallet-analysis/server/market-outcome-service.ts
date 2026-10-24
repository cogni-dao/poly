// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/market-outcome-service`
 * Purpose: Sibling tick to `runTraderObservationTick` that polls Polymarket CLOB
 *          `/markets/{conditionId}` for resolution outcomes and writes them into
 *          `poly_market_outcomes`. Iterates conditions (not wallets) so the table
 *          stays fresh for every `(condition_id, token_id)` touched by an active
 *          wallet — current open positions plus fill rollups observed within
 *          the last 30 days.
 * Scope: Feature service. Caller injects DB/clobClient/logger/metrics; the
 *        bootstrap job owns scheduling.
 * Invariants:
 *   - DEDUPE_BEFORE_UPSERT: rows are deduped by `(condition_id, token_id)` before
 *     `INSERT … ON CONFLICT DO UPDATE` to avoid Postgres "command cannot affect
 *     row a second time" failures (bug.5011).
 *   - PLIMIT_4_IS_SAFE: spike.5001 measured zero 429s up to 250 calls at
 *     `pLimit(4)` (~24 rps); higher concurrency hits a 37% 429 cliff.
 *   - BATCH_BOUNDED: per-tick batch capped (default 100) to bound runtime.
 *     Remaining stale conditions roll over to the next tick.
 *   - ACCOUNT_RECOVERY_FIRST: unresolved holdings of active trading wallets
 *     precede research history, so a terminal transition can unblock the
 *     account position observer without waiting for the historical sweep.
 *   - FINAL_IS_FINAL: complete terminal facts are never polled again. The
 *     monotone writer cannot change them; refreshing them only burns budget.
 *   - BACKFILL_ONCE: when `includeBackfill=true` the tick drops the 30-day
 *     rollup filter and walks the full historical condition set;
 *     callers flip the flag back to false after the first complete run.
 *   - NO_RAW_FILL_SCAN: condition discovery reads the compact daily rollup,
 *     never the multi-million-row raw fills table. The observation writer
 *     folds fills into the rollup before this independent background tick;
 *     active positions cover the live condition set while that fold settles.
 *   - TERMINAL_FACTS_ARE_MONOTONE: writers lowercase condition identity;
 *     unknown/conflicting refreshes cannot replace a saved terminal tuple,
 *     while a same-terminal refresh may fill only null payout/resolution time.
 * Side-effects: IO via injected DB + injected CLOB client.
 * Links: work/items/task.5012, work/items/task.5016, work/items/spike.5001
 * @public
 */

import { polyMarketOutcomes } from "@cogni/poly-db-schema";
import type { LoggerPort, MetricsPort } from "@cogni/poly-market-provider";
import type { PolymarketClobPublicClient } from "@cogni/poly-market-provider/adapters/polymarket";
import type { MarketResolutionInput } from "@cogni/poly-market-provider/analysis";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import pLimit from "p-limit";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

const DEFAULT_BATCH_SIZE = 100;
const UPSTREAM_CONCURRENCY = 4;

// TODO(task.5014, PR #1245): replace inline dedupe with `dedupeByKey`
// from `./observation-helpers` once CP2 lands on main.
function dedupeByKey<T, K>(rows: readonly T[], keyFn: (row: T) => K): T[] {
  const map = new Map<K, T>();
  for (const row of rows) {
    map.set(keyFn(row), row);
  }
  return Array.from(map.values());
}

export interface MarketOutcomeTickDeps {
  db: Db;
  clobClient: Pick<PolymarketClobPublicClient, "getMarketResolution">;
  logger: LoggerPort;
  metrics: MetricsPort;
  /** Per-tick cap on upstream calls. Default 100. */
  batchSize?: number;
  /** When true, drop the 30-day fills filter for a one-time historical fill. */
  includeBackfill?: boolean;
}

export interface MarketOutcomeTickResult {
  conditions: number;
  polled: number;
  upserted: number;
  errors: number;
}

interface ConditionTokenRow {
  condition_id: string;
  token_id: string;
  account_holding?: boolean;
}

interface UpsertRow {
  conditionId: string;
  tokenId: string;
  outcome: "winner" | "loser" | "unknown";
  payout: string | null;
  resolvedAt: Date | null;
  raw: Record<string, unknown>;
}

export async function runMarketOutcomeTick(
  deps: MarketOutcomeTickDeps
): Promise<MarketOutcomeTickResult> {
  const log = deps.logger.child({ component: "trader-market-outcome" });
  const startedAt = Date.now();
  const requestedBatchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const batchSize = Number.isFinite(requestedBatchSize)
    ? Math.max(1, Math.min(DEFAULT_BATCH_SIZE, Math.floor(requestedBatchSize)))
    : DEFAULT_BATCH_SIZE;
  const includeBackfill = deps.includeBackfill ?? false;

  const rollupFilter = includeBackfill
    ? sql``
    : sql`WHERE last_observed_at > now() - INTERVAL '30 days'`;
  // In backfill mode, the drain criterion is "every active condition has been
  // resolved at least once" — so we filter to never-resolved rows only. This
  // is reachable: once every active condition has an outcome row, the query
  // returns 0 candidates and the job flips backfillPending → false. In normal
  // mode we also refresh active markets older than 5 min so resolution status
  // stays fresh post-drain.
  const stalenessFilter = includeBackfill
    ? sql`m.updated_at IS NULL`
    : sql`m.updated_at IS NULL OR m.updated_at < now() - INTERVAL '5 minutes'`;

  const candidates = (await deps.db.execute(sql`
    WITH active_conditions AS (
      SELECT lower(condition_id) AS condition_id, token_id
      FROM poly_trader_current_positions
      WHERE active = true
      UNION
      SELECT lower(condition_id) AS condition_id, token_id
      FROM poly_trader_fill_rollups_daily
      ${rollupFilter}
    ), account_holdings AS (
      SELECT DISTINCT lower(p.condition_id) AS condition_id, p.token_id
      FROM poly_trader_current_positions p
      JOIN poly_trader_wallets w ON w.id = p.trader_wallet_id
      WHERE p.active = true
        AND w.kind = 'cogni_wallet'
        AND w.active_for_research = true
        AND w.disabled_at IS NULL
    ), outcome_freshness AS (
      SELECT lower(condition_id) AS condition_id, token_id,
        max(updated_at) AS updated_at,
        bool_or(outcome IN ('winner', 'loser') AND resolved_at IS NOT NULL) AS terminal
      FROM poly_market_outcomes
      GROUP BY lower(condition_id), token_id
    )
    SELECT a.condition_id, a.token_id, h.token_id IS NOT NULL AS account_holding
    FROM active_conditions a
    LEFT JOIN outcome_freshness m
      ON m.condition_id = a.condition_id
     AND m.token_id = a.token_id
    LEFT JOIN account_holdings h
      ON h.condition_id = a.condition_id
     AND h.token_id = a.token_id
    WHERE (${stalenessFilter})
      AND NOT COALESCE(m.terminal, false)
    -- Oldest stale (or never-resolved) rows first so the historical
    -- backfill drains progressively across ticks. Previously
    -- ORDER BY condition_id meant the tick re-processed the same
    -- alphabetically-first 100 every cycle, capping resolution at
    -- one batch per pod restart regardless of how long the job ran.
    -- A newly resolved, still-held loser can block the entire account's
    -- position publication until this writer records its terminal outcome.
    -- Spend the existing bounded budget there before research/backfill.
    ORDER BY (h.token_id IS NOT NULL) DESC,
      m.updated_at ASC NULLS FIRST, a.condition_id, a.token_id
    LIMIT ${batchSize}
  `)) as unknown as ConditionTokenRow[];

  const totalConditions = candidates.length;
  const selectionMs = Date.now() - startedAt;

  if (totalConditions === 0) {
    log.info(
      {
        event: "poly.market-outcome.tick_ok",
        phase: "ok",
        conditions: 0,
        polled: 0,
        upserted: 0,
        errors: 0,
        backfill: includeBackfill,
        account_holding_tokens: 0,
        upstream_request_limit: batchSize,
        upstream_concurrency_limit: UPSTREAM_CONCURRENCY,
        selection_ms: selectionMs,
        duration_ms: Date.now() - startedAt,
      },
      "market outcome tick — no stale conditions"
    );
    return { conditions: 0, polled: 0, upserted: 0, errors: 0 };
  }

  const upstreamLimit = pLimit(UPSTREAM_CONCURRENCY);
  let polled = 0;
  let errors = 0;
  const distinctConditions = Array.from(
    new Set(candidates.map((row) => row.condition_id))
  );

  const resolutionsByCondition = new Map<
    string,
    MarketResolutionInput | null
  >();

  await Promise.all(
    distinctConditions.map((conditionId) =>
      upstreamLimit(async () => {
        const startedAt = Date.now();
        let statusCode: "ok" | "null" | "error" = "ok";
        let resolution: MarketResolutionInput | null = null;
        try {
          resolution = await deps.clobClient.getMarketResolution(conditionId);
          statusCode = resolution === null ? "null" : "ok";
          polled += 1;
        } catch (err: unknown) {
          statusCode = "error";
          errors += 1;
          log.error(
            {
              event: "poly.market-outcome.outbound",
              phase: "error",
              conditionId,
              status_code: "error",
              latency_ms: Date.now() - startedAt,
              err: err instanceof Error ? err.message : String(err),
            },
            "market outcome upstream call failed"
          );
        }
        resolutionsByCondition.set(conditionId, resolution);
        if (statusCode !== "error") {
          log.info(
            {
              event: "poly.market-outcome.outbound",
              phase: "ok",
              conditionId,
              status_code: statusCode,
              latency_ms: Date.now() - startedAt,
            },
            "market outcome upstream call"
          );
        }
      })
    )
  );

  const upsertRows = candidates.flatMap((row): UpsertRow[] => {
    const resolution = resolutionsByCondition.get(row.condition_id);
    if (!resolution) return [];
    const tokenEntry = resolution.tokens.find(
      (t) => t.token_id === row.token_id
    );
    if (!tokenEntry) return [];
    const resolved =
      resolution.closed &&
      resolution.tokens.filter((token) => token.winner).length === 1;
    const outcome: UpsertRow["outcome"] = !resolved
      ? "unknown"
      : tokenEntry.winner
        ? "winner"
        : "loser";
    return [
      {
        conditionId: row.condition_id.toLowerCase(),
        tokenId: row.token_id,
        outcome,
        payout: null,
        resolvedAt: resolved ? new Date() : null,
        raw: resolution as unknown as Record<string, unknown>,
      },
    ];
  });

  const deduped = dedupeByKey(
    upsertRows,
    (r) => `${r.conditionId}:${r.tokenId}`
  );

  let upserted = 0;
  if (deduped.length > 0) {
    await deps.db
      .insert(polyMarketOutcomes)
      .values(
        deduped.map((row) => ({
          conditionId: row.conditionId,
          tokenId: row.tokenId,
          outcome: row.outcome,
          payout: row.payout,
          resolvedAt: row.resolvedAt,
          raw: row.raw,
        }))
      )
      .onConflictDoUpdate({
        target: [polyMarketOutcomes.conditionId, polyMarketOutcomes.tokenId],
        set: {
          outcome: sql`CASE
            WHEN ${polyMarketOutcomes.outcome} IN ('winner', 'loser')
              THEN ${polyMarketOutcomes.outcome}
            ELSE EXCLUDED.outcome
          END`,
          payout: sql`CASE
            WHEN ${polyMarketOutcomes.outcome} IN ('winner', 'loser')
              AND ${polyMarketOutcomes.outcome} <> EXCLUDED.outcome
              THEN ${polyMarketOutcomes.payout}
            ELSE COALESCE(${polyMarketOutcomes.payout}, EXCLUDED.payout)
          END`,
          resolvedAt: sql`CASE
            WHEN ${polyMarketOutcomes.outcome} IN ('winner', 'loser')
              AND ${polyMarketOutcomes.outcome} <> EXCLUDED.outcome
              THEN ${polyMarketOutcomes.resolvedAt}
            WHEN ${polyMarketOutcomes.outcome} IN ('winner', 'loser')
              THEN COALESCE(${polyMarketOutcomes.resolvedAt}, EXCLUDED.resolved_at, now())
            WHEN EXCLUDED.outcome IN ('winner', 'loser')
              THEN COALESCE(EXCLUDED.resolved_at, now())
            ELSE ${polyMarketOutcomes.resolvedAt}
          END`,
          raw: sql`CASE
            WHEN ${polyMarketOutcomes.outcome} IN ('winner', 'loser')
              THEN ${polyMarketOutcomes.raw}
            ELSE EXCLUDED.raw
          END`,
          updatedAt: sql`now()`,
        },
      });
    upserted = deduped.length;
  }

  log.info(
    {
      event: "poly.market-outcome.tick_ok",
      phase: "ok",
      conditions: totalConditions,
      polled,
      upserted,
      errors,
      backfill: includeBackfill,
      account_holding_tokens: candidates.filter((row) => row.account_holding)
        .length,
      upstream_request_limit: batchSize,
      upstream_concurrency_limit: UPSTREAM_CONCURRENCY,
      selection_ms: selectionMs,
      duration_ms: Date.now() - startedAt,
    },
    "market outcome tick complete"
  );

  return { conditions: totalConditions, polled, upserted, errors };
}

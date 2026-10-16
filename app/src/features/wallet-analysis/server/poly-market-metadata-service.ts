// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/poly-market-metadata-service`
 * Purpose: Refresh `poly_market_metadata` rows by projecting already-persisted
 *   `/positions` JSONB from `poly_trader_current_positions.raw` into typed
 *   columns. Owns the only writes to `poly_market_metadata`; readers JOIN on
 *   `condition_id`.
 * Scope: Pure server service. Caller owns DB + logger; this module runs a
 *   single SQL upsert per tick.
 * Invariants:
 *   - SINGLE_SOURCE_OF_TRUTH: one canonical typed row per `condition_id`.
 *   - NO_NEW_HTTP: the projection runs entirely off data we already polled
 *     via `/positions` — zero new Polymarket calls. The Gamma
 *     `/markets?condition_ids=…` endpoint silently ignores its filter and
 *     was removed; readers fall back via COALESCE to the position raw when
 *     metadata rows haven't materialized yet.
 *   - NONEMPTY_FIELD_WINS: when multiple traders hold the same market, the
 *     row sourced from the most recently observed position wins
 *     (DISTINCT ON + ORDER BY last_observed_at DESC). Market-level fields
 *     are stable across traders, so this is deterministic in practice.
 *   - WRITE_ONLY_ON_CHANGE: stable typed metadata is compared null-safely;
 *     unchanged rows do not rewrite `raw`/`fetched_at` every observation tick.
 * Side-effects: DB write (`poly_market_metadata`).
 * Links: nodes/poly/packages/db-schema/src/trader-activity.ts (table).
 * @internal
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

type LoggerPort = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
};

export type RefreshMarketMetadataResult = {
  /** Distinct condition_ids the projection covered. */
  scanned: number;
  /** Rows upserted into `poly_market_metadata`. */
  written: number;
};

/**
 * Refresh `poly_market_metadata` by projecting position-raw JSONB into typed
 * columns. Single-statement upsert; unchanged metadata performs zero writes.
 */
export async function refreshMarketMetadata(deps: {
  db: Db;
  logger: LoggerPort;
}): Promise<RefreshMarketMetadataResult> {
  try {
    const result = await deps.db.execute<{
      scanned: number | string;
      written: number | string;
    }>(sql`
      WITH candidates AS MATERIALIZED (
        SELECT lower(condition_id) AS condition_id,
          (array_agg(CASE WHEN raw->>'title' !~* '^(Polymarket|UNKNOWN|Market 0x)' THEN NULLIF(raw->>'title', '') END ORDER BY last_observed_at DESC, trader_wallet_id) FILTER (WHERE CASE WHEN raw->>'title' !~* '^(Polymarket|UNKNOWN|Market 0x)' THEN NULLIF(raw->>'title', '') END IS NOT NULL))[1] AS market_title,
          (array_agg(NULLIF(raw->>'slug', '') ORDER BY last_observed_at DESC, trader_wallet_id) FILTER (WHERE NULLIF(raw->>'slug', '') IS NOT NULL))[1] AS market_slug,
          (array_agg(NULLIF(raw->>'eventTitle', '') ORDER BY last_observed_at DESC, trader_wallet_id) FILTER (WHERE NULLIF(raw->>'eventTitle', '') IS NOT NULL))[1] AS event_title,
          (array_agg(NULLIF(raw->>'eventSlug', '') ORDER BY last_observed_at DESC, trader_wallet_id) FILTER (WHERE NULLIF(raw->>'eventSlug', '') IS NOT NULL))[1] AS event_slug,
          (array_agg((NULLIF(raw->>'endDate', ''))::timestamptz ORDER BY last_observed_at DESC, trader_wallet_id) FILTER (WHERE (NULLIF(raw->>'endDate', ''))::timestamptz IS NOT NULL))[1] AS end_date,
          (array_agg(raw ORDER BY last_observed_at DESC, trader_wallet_id))[1] AS raw
        FROM poly_trader_current_positions
        WHERE active = true AND raw IS NOT NULL AND condition_id <> ''
        GROUP BY lower(condition_id)
      ),
      upserted AS (
        INSERT INTO poly_market_metadata (
          condition_id,
          market_title,
          market_slug,
          event_title,
          event_slug,
          end_date,
          raw,
          fetched_at
        )
        SELECT
          condition_id,
          market_title,
          market_slug,
          event_title,
          event_slug,
          end_date,
          raw,
          now()
        FROM candidates
        ON CONFLICT (condition_id) DO UPDATE SET
          market_title = COALESCE(EXCLUDED.market_title, poly_market_metadata.market_title),
          market_slug = COALESCE(EXCLUDED.market_slug, poly_market_metadata.market_slug),
          event_title = COALESCE(EXCLUDED.event_title, poly_market_metadata.event_title),
          event_slug = COALESCE(EXCLUDED.event_slug, poly_market_metadata.event_slug),
          end_date = COALESCE(EXCLUDED.end_date, poly_market_metadata.end_date),
          raw          = EXCLUDED.raw,
          fetched_at   = EXCLUDED.fetched_at
        WHERE ROW(
          poly_market_metadata.market_title,
          poly_market_metadata.market_slug,
          poly_market_metadata.event_title,
          poly_market_metadata.event_slug,
          poly_market_metadata.end_date
        ) IS DISTINCT FROM ROW(
          COALESCE(EXCLUDED.market_title, poly_market_metadata.market_title),
          COALESCE(EXCLUDED.market_slug, poly_market_metadata.market_slug),
          COALESCE(EXCLUDED.event_title, poly_market_metadata.event_title),
          COALESCE(EXCLUDED.event_slug, poly_market_metadata.event_slug),
          COALESCE(EXCLUDED.end_date, poly_market_metadata.end_date)
        )
        RETURNING 1
      )
      SELECT
        (SELECT COUNT(*)::int FROM candidates) AS scanned,
        (SELECT COUNT(*)::int FROM upserted) AS written
    `);
    const counts = extractCounts(result);
    deps.logger.info(
      {
        event: "poly.market_metadata.refresh",
        phase: "tick_ok",
        scanned: counts.scanned,
        written: counts.written,
      },
      "market metadata refresh complete"
    );
    return counts;
  } catch (err: unknown) {
    deps.logger.warn(
      {
        event: "poly.market_metadata.refresh",
        phase: "projection_error",
        err: err instanceof Error ? err.message : String(err),
      },
      "market metadata projection failed"
    );
    return { scanned: 0, written: 0 };
  }
}

/**
 * `db.execute` returns different shapes across the two drizzle drivers
 * (`postgres-js` returns an array-like; `node-postgres` returns a `QueryResult`
 * with `.rows`). Normalize the single aggregate row from either driver.
 */
function extractCounts(result: unknown): RefreshMarketMetadataResult {
  let rows: unknown[] = [];
  if (Array.isArray(result)) rows = result;
  if (result && typeof result === "object") {
    const resultRows = (result as { rows?: unknown }).rows;
    if (Array.isArray(resultRows)) rows = resultRows;
  }
  const first = rows[0] as
    | { scanned?: number | string; written?: number | string }
    | undefined;
  return {
    scanned: Number(first?.scanned ?? 0),
    written: Number(first?.written ?? 0),
  };
}

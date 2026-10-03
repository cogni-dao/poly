// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/current-position-read-model`
 * Purpose: Read the DB-backed current-position inventory for tenant trading
 *   wallets from `poly_trader_current_positions`.
 * Scope: DB read + contract mapping only. Upstream Polymarket paging is owned
 *   by `trader-observation-service`; page-load routes must not call broad
 *   `/positions` directly.
 * Invariants:
 *   - DB_CURRENT_POSITIONS_ARE_PAGELOAD_TRUTH: dashboard overview/execution
 *     use this read model for current exposure.
 *   - OBSERVER_OWNS_UPSTREAM_PAGING: this module performs no Polymarket HTTP.
 *   - COMPLETE_POLLS_DEACTIVATE: missing rows are trusted only because the
 *     observer deactivates them after complete paged polls.
 *   - RAW_NEVER_SELECTED_WHOLESALE: the Data-API `raw` jsonb is projected
 *     to 7 scalar `raw->>` fields in SQL (dashboard read-path floor fix);
 *     the full blob never crosses the wire or gets decoded in V8.
 * Side-effects: DB read only.
 * Links: work/items/task.5007.poly-tenant-current-position-reconciler.md
 * @public
 */

import type {
  WalletExecutionLifecycleState,
  WalletExecutionPosition,
  WalletExecutionPositionStatus,
  WalletExecutionWarning,
} from "@cogni/poly-node-contracts";
import { type SQL, sql } from "drizzle-orm";
import { liveCurrentPositionSql } from "./current-position-staleness";

type Db = {
  execute(query: SQL): Promise<unknown>;
};

const POSITION_STALE_MS = 10 * 60_000;
const POSITION_PREVIEW_LIMIT = 500;
const OBSERVATION_SOURCE = "data-api-positions";

type CurrentPositionRow = {
  condition_id: string | null;
  token_id: string | null;
  shares: string | number | null;
  cost_basis_usdc: string | number | null;
  current_value_usdc: string | number | null;
  avg_price: string | number | null;
  last_observed_at: Date | string | null;
  first_observed_at: Date | string | null;
  /**
   * Scalar `raw->>` projections. The Data-API `raw` jsonb blob is never
   * selected wholesale (dashboard read-path floor fix) — only these
   * bounded text fields leave SQL; V8 no longer decodes the full blob.
   */
  raw_cur_price: string | null;
  raw_end_date: string | null;
  raw_title: string | null;
  raw_event_title: string | null;
  raw_slug: string | null;
  raw_event_slug: string | null;
  raw_outcome: string | null;
  cursor_last_success_at: Date | string | null;
  cursor_status: string | null;
  redeem_status: string | null;
  redeem_lifecycle_state: WalletExecutionLifecycleState | null;
  market_outcome: "winner" | "loser" | "unknown" | null;
  /**
   * `poly_market_metadata` JOIN — canonical Gamma values. Null when the
   * Gamma sweep has not yet seen this conditionId; the per-row code falls
   * back to `raw->>` JSONB-scrape so first deploy doesn't flicker.
   */
  metadata_market_title: string | null;
  metadata_market_slug: string | null;
  metadata_event_title: string | null;
  metadata_event_slug: string | null;
  metadata_end_date: Date | string | null;
  total_active_rows: string | number;
  total_positions_mtm: string | number;
};

export interface CurrentWalletPositionReadModel {
  positions: WalletExecutionPosition[];
  summary: {
    positionsMtm: number;
    syncedAt: string | null;
    syncAgeMs: number | null;
    stale: boolean;
    activeRows: number;
  };
  warnings: WalletExecutionWarning[];
}

export async function readCurrentWalletPositionModel(params: {
  db: Db;
  walletAddress: string;
  capturedAt: Date;
}): Promise<CurrentWalletPositionReadModel> {
  const rows = normalizeRows<CurrentPositionRow>(
    await params.db.execute(sql`
      SELECT
        p.condition_id,
        p.token_id,
        p.shares,
        p.cost_basis_usdc,
        p.current_value_usdc,
        p.avg_price,
        p.last_observed_at,
        p.first_observed_at,
        -- Scalar raw->> projections only — 5 of the old wholesale-raw
        -- fields duplicate the joined poly_market_metadata and are kept
        -- solely as first-deploy fallbacks; extracting them in SQL keeps
        -- the (potentially large) Data-API blob out of the wire + V8.
        p.raw->>'curPrice' AS raw_cur_price,
        p.raw->>'endDate' AS raw_end_date,
        p.raw->>'title' AS raw_title,
        p.raw->>'eventTitle' AS raw_event_title,
        p.raw->>'slug' AS raw_slug,
        p.raw->>'eventSlug' AS raw_event_slug,
        p.raw->>'outcome' AS raw_outcome,
        c.last_success_at AS cursor_last_success_at,
        c.status AS cursor_status,
        r.status AS redeem_status,
        r.lifecycle_state AS redeem_lifecycle_state,
        pmo.outcome AS market_outcome,
        pmm.market_title AS metadata_market_title,
        pmm.market_slug AS metadata_market_slug,
        pmm.event_title AS metadata_event_title,
        pmm.event_slug AS metadata_event_slug,
        pmm.end_date AS metadata_end_date,
        count(p.token_id) FILTER (
          WHERE p.current_value_usdc > 0
            AND (
              (pmo.outcome = 'winner' AND r.lifecycle_state IS DISTINCT FROM 'redeemed')
              OR (
                coalesce(pmo.outcome, 'unknown') NOT IN ('winner', 'loser')
                AND coalesce(r.lifecycle_state, '') NOT IN ('redeemed', 'loser', 'dust', 'closed')
              )
            )
        ) OVER () AS total_active_rows,
        coalesce(sum(p.current_value_usdc) FILTER (
          WHERE p.current_value_usdc > 0
            AND (
              (pmo.outcome = 'winner' AND r.lifecycle_state IS DISTINCT FROM 'redeemed')
              OR (
                coalesce(pmo.outcome, 'unknown') NOT IN ('winner', 'loser')
                AND coalesce(r.lifecycle_state, '') NOT IN ('redeemed', 'loser', 'dust', 'closed')
              )
            )
        ) OVER (), 0) AS total_positions_mtm
      FROM poly_trader_wallets w
      LEFT JOIN poly_trader_ingestion_cursors c
        ON c.trader_wallet_id = w.id
       AND c.source = ${OBSERVATION_SOURCE}
      LEFT JOIN poly_trader_current_positions p
        ON p.trader_wallet_id = w.id
       AND ${liveCurrentPositionSql("p")}
      LEFT JOIN poly_redeem_jobs r
        ON lower(r.funder_address) = w.wallet_address
       AND lower(r.condition_id) = p.condition_id
       AND r.position_id = p.token_id
      LEFT JOIN poly_market_outcomes pmo
        ON pmo.condition_id = p.condition_id
       AND pmo.token_id = p.token_id
      LEFT JOIN poly_market_metadata pmm
        ON pmm.condition_id = p.condition_id
      WHERE w.wallet_address = lower(${params.walletAddress})
        AND w.kind = 'cogni_wallet'
        AND w.active_for_research = true
        AND w.disabled_at IS NULL
        AND (
          p.token_id IS NULL
          OR (
            p.current_value_usdc > 0
            AND (
              (pmo.outcome = 'winner' AND r.lifecycle_state IS DISTINCT FROM 'redeemed')
              OR (
                coalesce(pmo.outcome, 'unknown') NOT IN ('winner', 'loser')
                AND coalesce(r.lifecycle_state, '') NOT IN ('redeemed', 'loser', 'dust', 'closed')
              )
            )
          )
        )
      ORDER BY p.current_value_usdc DESC NULLS LAST, p.last_observed_at DESC NULLS LAST
      LIMIT ${POSITION_PREVIEW_LIMIT}
    `)
  );

  const positions = rows.flatMap((row) =>
    rowToExecutionPosition(row, params.capturedAt)
  );
  const syncTimes = rows
    .map(
      (row) =>
        dateToMs(row.cursor_last_success_at) ?? dateToMs(row.last_observed_at)
    )
    .filter((time): time is number => time !== null);
  const latestSyncMs = syncTimes.length > 0 ? Math.max(...syncTimes) : null;
  const syncAgeMs =
    latestSyncMs === null
      ? null
      : Math.max(0, params.capturedAt.getTime() - latestSyncMs);
  const cursorStatus = rows.find(
    (row) => row.cursor_status !== null
  )?.cursor_status;
  const stale =
    rows.length > 0 &&
    (syncAgeMs === null ||
      syncAgeMs > POSITION_STALE_MS ||
      cursorStatus !== "ok");
  const warnings: WalletExecutionWarning[] = [];
  if (rows.length === 0) {
    warnings.push({
      code: "current_positions_wallet_missing",
      message:
        "No active DB observer wallet row is available for this trading wallet.",
    });
  } else if (stale) {
    warnings.push({
      code: "current_positions_stale",
      message:
        syncAgeMs !== null && syncAgeMs > POSITION_STALE_MS
          ? "Current-position read model is older than the 10-minute freshness window."
          : `Current positions are unavailable because the observer cursor is ${cursorStatus ?? "missing"}.`,
    });
  }

  return {
    positions,
    summary: {
      positionsMtm: roundToCents(
        toNumber(rows[0]?.total_positions_mtm ?? null)
      ),
      syncedAt:
        latestSyncMs !== null ? new Date(latestSyncMs).toISOString() : null,
      syncAgeMs,
      stale,
      activeRows: Math.max(
        0,
        Math.trunc(toNumber(rows[0]?.total_active_rows ?? null))
      ),
    },
    warnings,
  };
}

function rowToExecutionPosition(
  row: CurrentPositionRow,
  capturedAt: Date
): WalletExecutionPosition[] {
  if (row.condition_id === null || row.token_id === null) return [];
  const shares = toNumber(row.shares);
  const currentValue = toNumber(row.current_value_usdc);
  if (shares <= 0 || currentValue < 0) return [];
  const costBasis = toNumber(row.cost_basis_usdc);
  const avgPrice = positiveOrNull(toNumber(row.avg_price));
  const currentPrice =
    positiveOrNull(numberFromText(row.raw_cur_price)) ??
    positiveOrNull(currentValue / shares) ??
    0;
  const entryPrice =
    avgPrice ?? positiveOrNull(costBasis / shares) ?? currentPrice;
  const observedAt =
    isoOrNull(row.last_observed_at) ?? capturedAt.toISOString();
  const openedAt =
    isoOrNull(row.first_observed_at) ??
    isoOrNull(row.last_observed_at) ??
    capturedAt.toISOString();
  // Canonical resolution time: poly_market_metadata.end_date (Gamma).
  // Fall back to the legacy `raw.endDate` JSONB scrape so the first deploy
  // (where the metadata table has not yet been populated by the tick) does
  // not regress the dashboard. The fallback can be dropped in a follow-up
  // once `poly_market_metadata` is fully backfilled in prod.
  const endDate =
    isoOrNull(row.metadata_end_date) ?? isoString(optionalText(row.raw_end_date));
  const syncAgeMs = Math.max(0, capturedAt.getTime() - Date.parse(observedAt));
  const status = deriveCurrentPositionStatus({
    currentValue,
    marketOutcome: row.market_outcome,
    lifecycleState: row.redeem_lifecycle_state,
  });
  // Unrealized P/L from the snapshot row. Callers needing realized P/L
  // overlay `applyRealizedPnl` from `./realized-pnl-service` using the
  // fills+outcomes map produced by `readWalletTokenPnlMap`. Keeping this
  // module strictly bounded to its own SQL row makes it composable.
  const pnlUsd = roundToCents(currentValue - costBasis);
  const pnlPct = costBasis > 0 ? roundToCents((pnlUsd / costBasis) * 100) : 0;
  const terminalTs = status === "closed" ? observedAt : null;

  return [
    {
      positionId: `${row.condition_id}:${row.token_id}`,
      conditionId: row.condition_id,
      asset: row.token_id,
      // `??` only falls through on null/undefined, so a Gamma row that
      // landed with `marketTitle = ""` would render as empty instead of
      // hitting the JSONB fallback. `nonEmpty` collapses both null and ""
      // to undefined; mirrors the SQL `NULLIF(pmm.col, '')` pattern used
      // in `market-exposure-service.ts`. The raw_* fallbacks are the SQL
      // scalar projections of the old `raw->>` reads (same values).
      marketTitle:
        nonEmpty(row.metadata_market_title) ??
        optionalText(row.raw_title) ??
        "Polymarket",
      eventTitle:
        nonEmpty(row.metadata_event_title) ??
        optionalText(row.raw_event_title) ??
        null,
      marketSlug:
        nonEmpty(row.metadata_market_slug) ??
        optionalText(row.raw_slug) ??
        null,
      eventSlug:
        nonEmpty(row.metadata_event_slug) ??
        optionalText(row.raw_event_slug) ??
        null,
      marketUrl: marketUrl(row.raw_event_slug, row.raw_slug),
      outcome: optionalText(row.raw_outcome) ?? "UNKNOWN",
      status,
      lifecycleState: row.redeem_lifecycle_state,
      openedAt,
      closedAt: terminalTs,
      resolvesAt: endDate,
      gameStartTime: null,
      heldMinutes: Math.max(
        0,
        Math.floor((capturedAt.getTime() - Date.parse(openedAt)) / 60_000)
      ),
      entryPrice,
      currentPrice,
      size: roundToPrecision(shares, 4),
      // Closed positions have no remaining mark-to-market exposure even
      // when Polymarket's Data API row still echoes a stale `curPrice`
      // (the row outlives CTF burn by minutes). Realized P/L survives in
      // `pnlUsd` — this only zeros the *current* exposure column.
      currentValue: status === "closed" ? 0 : roundToCents(currentValue),
      pnlUsd,
      pnlPct,
      syncedAt: observedAt,
      syncAgeMs,
      syncStale: syncAgeMs > POSITION_STALE_MS,
      timeline: [],
      events: [
        { ts: observedAt, kind: "entry", price: entryPrice, shares },
        ...(terminalTs !== null
          ? [
              {
                ts: terminalTs,
                kind: "close" as const,
                price: currentPrice,
                shares,
              },
            ]
          : []),
      ],
    },
  ];
}

/**
 * Classify a current-position row into a single dashboard `status`.
 *
 * Authority precedence — chain truth first, job pipeline state second:
 *   1. `marketOutcome === 'loser'` (chain `payoutNumerator === 0`) →
 *      `closed`. Tokens are worthless, regardless of any other signal.
 *   2. `marketOutcome === 'winner'` (chain `payoutNumerator > 0`):
 *      - `lifecycleState === 'redeemed'` → `closed` (chain `PayoutRedemption`
 *        log confirmed the burn; cash is now in the wallet).
 *      - else → `redeemable`. Shares still on chain, awaiting redemption.
 *        This deliberately overrides any other job pipeline state so an
 *        `abandoned` redeem job can't hide a real winning position from
 *        the dashboard. (bug.5040: redeemPositions tx revert → 3 retries
 *        → markAbandoned → dashboard hid ~\$500 of real winnings.)
 *   3. `lifecycleState === 'winner'` (no chain outcome row yet, but the
 *      subscriber already classified) → `redeemable`. Race-window fallback.
 *   4. `lifecycleState ∈ {redeemed, loser, dust, closed}` (genuinely
 *      position-terminal job states) → `closed`. NOTE: `abandoned` is
 *      excluded — the JOB gave up on a tx flow, but the POSITION is
 *      still ours until chain says otherwise.
 *   5. `currentValue <= 0` → `closed` (no value to render).
 *   6. else → `open`.
 *
 * Polymarket Data-API `raw.redeemable` is **never** consulted — Polymarket
 * flags both winner AND loser sides as `redeemable=true` once a market
 * resolves, which is what produced the original split-brain (bug.5008).
 */
export function deriveCurrentPositionStatus(input: {
  currentValue: number;
  marketOutcome: "winner" | "loser" | "unknown" | null;
  lifecycleState: WalletExecutionLifecycleState | null;
}): WalletExecutionPositionStatus {
  if (input.marketOutcome === "loser") return "closed";
  if (input.marketOutcome === "winner") {
    return input.lifecycleState === "redeemed" ? "closed" : "redeemable";
  }
  if (input.lifecycleState === "winner") return "redeemable";
  if (
    input.lifecycleState === "redeemed" ||
    input.lifecycleState === "loser" ||
    input.lifecycleState === "dust" ||
    input.lifecycleState === "closed"
  ) {
    return "closed";
  }
  if (input.currentValue <= 0) return "closed";
  return "open";
}

function normalizeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    typeof result === "object" &&
    result !== null &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function marketUrl(
  rawEventSlug: string | null,
  rawSlug: string | null
): string | null {
  const eventSlug = optionalText(rawEventSlug);
  const slug = optionalText(rawSlug);
  if (!eventSlug || !slug) return null;
  return `https://polymarket.com/event/${eventSlug}/${slug}`;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isoString(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function dateToMs(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function toNumber(value: string | number | null): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Numeric parse of a SQL `raw->>…` text projection. Mirrors the old
 * in-V8 `readNumber(raw, key)` semantics: absent/malformed → 0.
 */
function numberFromText(value: string | null): number {
  if (value === null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Non-empty text of a SQL `raw->>…` projection, or undefined. Mirrors the
 * old in-V8 `readOptionalString(raw, key)` semantics for `??` chains.
 */
function optionalText(value: string | null): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Collapse null + empty-string to `undefined` so `??` chains can fall
 * through. Mirrors SQL `NULLIF(value, '')` for the metadata-table reads.
 */
function nonEmpty(value: string | null): string | undefined {
  if (value === null || value.length === 0) return undefined;
  return value;
}

function positiveOrNull(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundToPrecision(value: number, precision: number): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

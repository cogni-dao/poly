// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/copy-trade-attempts-read`
 * Purpose: Capability 2 of task.1791070959 — the frozen, cursor-paginated,
 *   account-wide, cross-market tape of copy-trade mirror ATTEMPTS. One bounded
 *   keyset query whose spine is `poly_copy_trade_decisions`, correlated to the
 *   placement/fill evidence in `poly_copy_trade_fills`.
 * Scope: Two bounded reads (one freshness probe, one page) on the dispatcher's
 *   app-role tenant transaction. No authorization, no HTTP, no container.
 * Invariants:
 *   - THE_SPINE_IS_DECISIONS_NOT_FILLS — this is the whole point. The dashboard
 *     card reads the FILLS ledger, so every `outcome='skipped'` decision and
 *     its `reason` is invisible today, and skips are the MAJORITY of mirror
 *     activity. `poly_copy_trade_decisions` had no account-wide read path at
 *     all (story.5051 — "write-only"); the only existing read is the
 *     per-market investigation service. This is a new read, not a port.
 *   - INTENDED_VS_EXECUTED_NEVER_COALESCE — `intended` comes from the decision
 *     `intent` JSONB, `executed` from the LEFT-JOINed ledger row. A skip has no
 *     ledger row and reports `availability:"no_order_placed"`, which is an
 *     EXPECTED absence. A `placed` decision with no ledger row reports
 *     `availability:"ledger_row_missing"` — a genuine inconsistency, tagged
 *     distinctly so it can never be read as a skip.
 *   - KEYSET_CURSOR_IS_TOTAL — ordering is `(decided_at DESC, id DESC)`. `id`
 *     is the table's uuid PRIMARY KEY, so the sort is a total order and no row
 *     can be skipped or repeated across pages even when many decisions share a
 *     `decided_at`. The cursor carries exactly that tuple.
 *   - STABLE_CUTOFF — `captured_at` freezes membership. Omitted on page 1 (the
 *     server freezes `clock_timestamp()` and returns it); required thereafter.
 *     A future `captured_at` is rejected rather than silently clamped, because
 *     it would let a caller page over rows that do not exist yet.
 *   - EVERY_PREDICATE_IN_SQL — mode, outcome, target, and window filters are
 *     real SQL predicates. The route this supersedes filtered `status` in JS
 *     AFTER the LIMIT, which silently returned short pages.
 *   - HARD_PAGE_BOUND — `limit` is capped at 200 by the contract AND clamped
 *     here; the query fetches limit+1 to OBSERVE truncation rather than guess.
 *   - NO_EXHAUSTIVE_PER_MARKET_PAGING — one account-wide pass. The mark and
 *     resolution lookups are per-row `LIMIT 1` index probes bounded by the page
 *     size, never a scan per market.
 *   - NO_FABRICATED_VALUES — mark and outcome are discriminated unions tagged
 *     `unavailable` with a reason. An unpriced token is never price 0, and an
 *     unresolved market is never a loss.
 * Side-effects: IO (two bounded SELECTs).
 * Links: task.1791070959, story.5004, story.5051,
 *   docs/spec/dashboard-agent-parity-inventory.md §9.2
 * @public
 */

import {
  POLY_COPY_ATTEMPTS_MAX_LIMIT,
  type PolyAccountRecentAttemptsQuery,
  type PolyAccountRecentAttemptsResponse,
  type PolyCopyTradeAttempt,
} from "@cogni/poly-node-contracts";
import { type SQL, sql } from "drizzle-orm";

import type { AgentGrantTransaction } from "@/features/agent-grants/authorization";

const STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Ledger market ids are stored with this prefix; `poly_market_outcomes` keys on
 * the bare Polymarket conditionId. Normalised in SQL for the resolution join.
 */
const POLYMARKET_LEDGER_PREFIX = "prediction-market:polymarket:";
/** Anchored prefix pattern for `regexp_replace`. Precomputed so the SQL
 * template below contains no nested template literal. */
const LEDGER_PREFIX_PATTERN = "^" + POLYMARKET_LEDGER_PREFIX;

/**
 * A tape older than this is reported `stale`. Chosen to be a few mirror poll
 * cadences wide, so a single missed tick does not flap the status.
 */
const FRESHNESS_STALE_AFTER_SECONDS = 900;

/** Opaque to clients; `(decided_at, id)` is the keyset tuple. */
export type AttemptCursor = {
  decidedAt: string;
  attemptId: string;
};

export class InvalidAttemptCursorError extends Error {
  constructor() {
    super("invalid_cursor");
    this.name = "InvalidAttemptCursorError";
  }
}

export class InvalidAttemptCapturedAtError extends Error {
  constructor() {
    super("captured_at_must_not_be_in_the_future");
    this.name = "InvalidAttemptCapturedAtError";
  }
}

export function encodeAttemptCursor(cursor: AttemptCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeAttemptCursor(value: string): AttemptCursor {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    );
    if (!parsed || typeof parsed !== "object") throw new Error("invalid");
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.decidedAt !== "string" ||
      !Number.isFinite(Date.parse(record.decidedAt)) ||
      typeof record.attemptId !== "string" ||
      record.attemptId.length === 0
    ) {
      throw new Error("invalid");
    }
    return { decidedAt: record.decidedAt, attemptId: record.attemptId };
  } catch {
    throw new InvalidAttemptCursorError();
  }
}

type AttemptRow = {
  attempt_id: string;
  decided_at: Date | string;
  target_id: string;
  target_wallet: string | null;
  fill_id: string;
  market_id: string | null;
  mode: string;
  outcome: "placed" | "skipped" | "error";
  reason: string | null;
  intended_side: string | null;
  intended_token_id: string | null;
  intended_limit_price: string | number | null;
  intended_size_usdc: string | number | null;
  position_branch: string | null;
  target_position_usdc: string | number | null;
  exec_status: string | null;
  exec_order_id: string | null;
  exec_observed_at: Date | string | null;
  exec_position_lifecycle: string | null;
  exec_price: string | number | null;
  exec_shares: string | number | null;
  exec_fees_usdc: string | number | null;
  exec_filled_size_usdc: string | number | null;
  exec_position_gap_version: string | null;
  exec_realized_fill_source: string | null;
  exec_synced_at: Date | string | null;
  mark_price: string | number | null;
  mark_observed_at: Date | string | null;
  resolution: string | null;
  resolution_payout: string | number | null;
  resolution_resolved_at: Date | string | null;
};

const rowsOf = <T>(result: unknown): T[] =>
  Array.isArray(result)
    ? (result as T[])
    : (((result as { rows?: T[] }).rows ?? []) as T[]);

const nullableNumber = (value: string | number | null): number | null =>
  value === null || value === undefined ? null : Number(value);

const toIso = (value: Date | string | null): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const side = (value: string | null): "BUY" | "SELL" | null =>
  value === "BUY" || value === "SELL" ? value : null;

const mode = (value: string): "live" | "paper" =>
  value === "paper" ? "paper" : "live";

function modeFilter(value: PolyAccountRecentAttemptsQuery["mode"]): SQL {
  return value === "all" ? sql`TRUE` : sql`d.mode = ${value}`;
}

function outcomeFilter(
  value: PolyAccountRecentAttemptsQuery["outcome"]
): SQL {
  return value === "all" ? sql`TRUE` : sql`d.outcome = ${value}`;
}

function windowFilter(query: PolyAccountRecentAttemptsQuery): SQL {
  const lower = query.since
    ? sql`d.decided_at >= ${query.since}::timestamptz`
    : sql`TRUE`;
  const upper = query.until
    ? sql`d.decided_at < ${query.until}::timestamptz`
    : sql`TRUE`;
  return sql`${lower} AND ${upper}`;
}

/**
 * Keyset predicate. Strictly-less-than on the full `(decided_at, id)` tuple —
 * a row-value comparison, so Postgres can satisfy it from the composite index
 * added in migration 0076 instead of filtering after a sort.
 */
function cursorFilter(cursor: AttemptCursor | null): SQL {
  if (!cursor) return sql`TRUE`;
  return sql`(d.decided_at, d.id) < (${cursor.decidedAt}::timestamptz, ${cursor.attemptId}::uuid)`;
}

function targetFilter(targetId: string | undefined): SQL {
  return targetId === undefined
    ? sql`TRUE`
    : sql`d.target_id = ${targetId}::uuid`;
}

/**
 * The exact production query, exported so a real-Postgres test can `EXPLAIN` it
 * and assert the keyset index is used rather than a sort over the account.
 */
export function copyTradeAttemptsSelect(
  query: PolyAccountRecentAttemptsQuery,
  capturedAt: string,
  cursor: AttemptCursor | null,
  limit: number
): SQL {
  return sql`
    SELECT
      d.id::text                                        AS attempt_id,
      d.decided_at,
      d.target_id::text                                 AS target_id,
      t.target_wallet,
      d.fill_id,
      COALESCE(NULLIF(d.intent->>'market_id', ''), f.market_id) AS market_id,
      d.mode,
      d.outcome,
      d.reason,
      CASE WHEN d.intent->>'side' IN ('BUY','SELL')
           THEN d.intent->>'side' END                   AS intended_side,
      NULLIF(d.intent->>'token_id', '')                 AS intended_token_id,
      NULLIF(d.intent->>'limit_price', '')::numeric     AS intended_limit_price,
      NULLIF(d.intent->>'size_usdc', '')::numeric       AS intended_size_usdc,
      NULLIF(d.intent->>'position_branch', '')          AS position_branch,
      NULLIF(d.intent->>'target_position_usdc', '')::numeric AS target_position_usdc,
      f.status                                          AS exec_status,
      f.order_id                                        AS exec_order_id,
      f.observed_at                                     AS exec_observed_at,
      f.position_lifecycle                              AS exec_position_lifecycle,
      f.price                                           AS exec_price,
      f.shares                                          AS exec_shares,
      f.fees_usdc                                       AS exec_fees_usdc,
      CASE WHEN COALESCE(f.attributes->>'filled_size_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$'
        THEN (f.attributes->>'filled_size_usdc')::numeric END AS exec_filled_size_usdc,
      f.attributes->>'position_gap_version'             AS exec_position_gap_version,
      f.attributes->>'realized_fill_source'             AS exec_realized_fill_source,
      f.synced_at                                       AS exec_synced_at,
      mark.price                                        AS mark_price,
      mark.ts                                           AS mark_observed_at,
      o.outcome                                         AS resolution,
      o.payout                                          AS resolution_payout,
      o.resolved_at                                     AS resolution_resolved_at
    FROM poly_copy_trade_decisions d
    -- Target label. Same tenant on both sides so the join cannot widen the
    -- RLS-visible row set.
    LEFT JOIN poly_copy_trade_targets t
      ON t.id = d.target_id
     AND t.billing_account_id = d.billing_account_id
    -- THE CORRELATION: decision evidence -> placement/fill evidence, on the
    -- fills PRIMARY KEY (billing_account_id, target_id, fill_id). LEFT, because
    -- a skipped attempt legitimately has no ledger row.
    LEFT JOIN poly_copy_trade_fills f
      ON f.billing_account_id = d.billing_account_id
     AND f.target_id = d.target_id
     AND f.fill_id = d.fill_id
     AND f.observed_at <= ${capturedAt}::timestamptz
    -- Mark availability: newest price at or before the cutoff for the intended
    -- token. One index probe per row, bounded by the page size.
    LEFT JOIN LATERAL (
      SELECT p.price, p.ts
      FROM poly_market_price_history p
      WHERE p.asset = NULLIF(d.intent->>'token_id', '')
        AND p.ts <= ${capturedAt}::timestamptz
      ORDER BY p.ts DESC
      LIMIT 1
    ) mark ON TRUE
    -- Resolution availability. poly_market_outcomes keys on the bare
    -- conditionId, so the ledger prefix is stripped here.
    LEFT JOIN poly_market_outcomes o
      ON o.condition_id = regexp_replace(
           COALESCE(NULLIF(d.intent->>'market_id', ''), f.market_id, ''),
           ${LEDGER_PREFIX_PATTERN}, ''
         )
     AND o.token_id = NULLIF(d.intent->>'token_id', '')
     AND o.updated_at <= ${capturedAt}::timestamptz
    WHERE d.billing_account_id = ${query.billing_account_id}
      AND d.decided_at <= ${capturedAt}::timestamptz
      AND ${modeFilter(query.mode)}
      AND ${outcomeFilter(query.outcome)}
      AND ${targetFilter(query.target_id)}
      AND ${windowFilter(query)}
      AND ${cursorFilter(cursor)}
    ORDER BY d.decided_at DESC, d.id DESC
    LIMIT ${limit + 1}
  `;
}

/** @internal Exported for the public truth-gating contract test. */
export function toExecuted(row: AttemptRow): PolyCopyTradeAttempt["executed"] {
  const observedAt = toIso(row.exec_observed_at);
  if (row.exec_status !== null && observedAt !== null) {
    const positionGapV3 = row.exec_position_gap_version === "3";
    const sourceVerified =
      row.exec_realized_fill_source === "clob_associated_trades" ||
      row.exec_realized_fill_source === "data_api_activity_position";
    const rawPrice = nullableNumber(row.exec_price);
    const rawShares = nullableNumber(row.exec_shares);
    const rawNotional = nullableNumber(row.exec_filled_size_usdc);
    const verifiedPositionGapFill =
      positionGapV3 &&
      sourceVerified &&
      rawPrice !== null &&
      rawPrice >= 0 &&
      rawShares !== null &&
      rawShares > 0 &&
      rawNotional !== null &&
      rawNotional > 0;
    const price = positionGapV3 && !verifiedPositionGapFill ? null : rawPrice;
    const shares =
      positionGapV3 && !verifiedPositionGapFill ? null : rawShares;
    const fillAccounting = positionGapV3
      ? verifiedPositionGapFill
        ? {
            status: "verified" as const,
            source: row.exec_realized_fill_source as
              | "clob_associated_trades"
              | "data_api_activity_position",
            matched_order_count: 1,
            realized_shares: rawShares,
            realized_entry_notional_usdc: rawNotional,
          }
        : {
            status: "pending" as const,
            source: "clob_order_receipt" as const,
          }
      : null;
    return {
      availability: "observed",
      status: row.exec_status,
      order_id: row.exec_order_id,
      observed_at: observedAt,
      position_lifecycle: row.exec_position_lifecycle,
      price,
      shares,
      fees_usdc:
        positionGapV3 && !verifiedPositionGapFill
          ? null
          : nullableNumber(row.exec_fees_usdc),
      // Executed notional is only knowable once BOTH legs are realized.
      // Deriving it from one of them would fabricate a value.
      filled_size_usdc: positionGapV3
        ? verifiedPositionGapFill
          ? rawNotional
          : null
        : price !== null && shares !== null
          ? price * shares
          : null,
      fill_accounting: fillAccounting,
      synced_at: toIso(row.exec_synced_at),
    };
  }
  if (row.outcome === "placed") {
    // Decision says placed, ledger has nothing. A real inconsistency.
    return {
      availability: "ledger_row_missing",
      reason: "placed_decision_without_ledger_row",
    };
  }
  return {
    availability: "no_order_placed",
    reason: row.outcome === "error" ? "decision_errored" : "decision_skipped",
  };
}

function toMark(row: AttemptRow): PolyCopyTradeAttempt["mark"] {
  if (row.intended_token_id === null) {
    return { availability: "unavailable", reason: "no_token_id_on_attempt" };
  }
  const price = nullableNumber(row.mark_price);
  const observedAt = toIso(row.mark_observed_at);
  if (price === null || observedAt === null) {
    return { availability: "unavailable", reason: "no_mark_on_file" };
  }
  return { availability: "available", price, observed_at: observedAt };
}

function toResolution(
  row: AttemptRow
): PolyCopyTradeAttempt["outcome_resolution"] {
  if (row.intended_token_id === null) {
    return { availability: "unavailable", reason: "no_token_id_on_attempt" };
  }
  if (row.resolution === null) {
    return { availability: "unavailable", reason: "market_unresolved" };
  }
  const resolution =
    row.resolution === "winner" || row.resolution === "loser"
      ? row.resolution
      : "unknown";
  return {
    availability: "resolved",
    resolution,
    payout: nullableNumber(row.resolution_payout),
    resolved_at: toIso(row.resolution_resolved_at),
  };
}

function toAttempt(row: AttemptRow, fallbackIso: string): PolyCopyTradeAttempt {
  return {
    attempt_id: row.attempt_id,
    decided_at: toIso(row.decided_at) ?? fallbackIso,
    target_id: row.target_id,
    target_wallet: row.target_wallet,
    fill_id: row.fill_id,
    market_id: row.market_id,
    mode: mode(row.mode),
    decision: { outcome: row.outcome, reason: row.reason },
    intended: {
      side: side(row.intended_side),
      token_id: row.intended_token_id,
      limit_price: nullableNumber(row.intended_limit_price),
      size_usdc: nullableNumber(row.intended_size_usdc),
      position_branch: row.position_branch,
      target_position_usdc: nullableNumber(row.target_position_usdc),
    },
    executed: toExecuted(row),
    mark: toMark(row),
    outcome_resolution: toResolution(row),
  };
}

/**
 * One frozen page of the account's mirror-attempt tape.
 *
 * Returns `null` only when the account has never attempted a mirror AND no
 * cursor was supplied — i.e. there is no tape here at all — which the executor
 * renders as a non-disclosing 404. An empty later page returns normally.
 */
export async function getRecentAttemptsForAccount(
  tx: AgentGrantTransaction,
  rawQuery: PolyAccountRecentAttemptsQuery,
  accountId: string
): Promise<PolyAccountRecentAttemptsResponse | null> {
  // ACCOUNT_IS_EXPLICIT — see the note in `copy-setup-read`. Overriding the
  // field here rather than threading a second parameter keeps the exported
  // `copyTradeAttemptsSelect` signature (and its EXPLAIN test) unchanged while
  // guaranteeing every predicate below is bound to the AUTHORIZED account.
  const query: PolyAccountRecentAttemptsQuery = {
    ...rawQuery,
    billing_account_id: accountId,
  };
  await tx.execute(
    sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
  );

  // Freeze the cutoff. Page 1 omits it; later pages MUST echo it back so tape
  // membership cannot shift underneath pagination.
  const clockRows = rowsOf<{ now: Date | string }>(
    await tx.execute(sql`SELECT clock_timestamp() AS now`)
  );
  const serverNowIso = toIso(clockRows[0]?.now ?? null) ?? new Date().toISOString();

  if (query.captured_at !== undefined) {
    // Reject rather than clamp: a future cutoff would page over rows that do
    // not exist yet, producing a tape that changes shape as time passes.
    if (Date.parse(query.captured_at) > Date.parse(serverNowIso)) {
      throw new InvalidAttemptCapturedAtError();
    }
  }
  const capturedAt = query.captured_at ?? serverNowIso;

  const cursor = query.cursor ? decodeAttemptCursor(query.cursor) : null;
  const limit = Math.min(query.limit, POLY_COPY_ATTEMPTS_MAX_LIMIT);

  // Freshness probe: the newest attempt at or before the cutoff, ignoring every
  // other filter so "stale" describes the TAPE, not the current slice.
  const freshnessRows = rowsOf<{ most_recent: Date | string | null }>(
    await tx.execute(sql`
      SELECT max(d.decided_at) AS most_recent
      FROM poly_copy_trade_decisions d
      WHERE d.billing_account_id = ${query.billing_account_id}
        AND d.decided_at <= ${capturedAt}::timestamptz
    `)
  );
  const mostRecentAttemptAt = toIso(freshnessRows[0]?.most_recent ?? null);

  // No tape at all and no cursor -> indistinguishable not-found.
  if (mostRecentAttemptAt === null && cursor === null) return null;

  const rawRows = rowsOf<AttemptRow>(
    await tx.execute(
      copyTradeAttemptsSelect(query, capturedAt, cursor, limit)
    )
  );

  // limit+1 was fetched, so truncation is OBSERVED rather than inferred.
  const truncated = rawRows.length > limit;
  const page = rawRows.slice(0, limit);
  const attempts = page.map((row) => toAttempt(row, capturedAt));
  const last = page.at(-1);

  const stalenessSeconds =
    mostRecentAttemptAt === null
      ? null
      : Math.max(
          0,
          Math.round(
            (Date.parse(capturedAt) - Date.parse(mostRecentAttemptAt)) / 1000
          )
        );

  const freshnessStatus =
    stalenessSeconds === null
      ? ("never_attempted" as const)
      : stalenessSeconds > FRESHNESS_STALE_AFTER_SECONDS
        ? ("stale" as const)
        : ("fresh" as const);

  const missingLedgerRow = attempts.filter(
    (attempt) => attempt.executed.availability === "ledger_row_missing"
  ).length;
  const missingMark = attempts.filter(
    (attempt) => attempt.mark.availability === "unavailable"
  ).length;

  return {
    billing_account_id: query.billing_account_id,
    mode: query.mode,
    outcome: query.outcome,
    target_id: query.target_id ?? null,
    since: query.since ?? null,
    until: query.until ?? null,
    captured_at: capturedAt,
    limit,
    attempts,
    next_cursor:
      truncated && last
        ? encodeAttemptCursor({
            decidedAt: toIso(last.decided_at) ?? capturedAt,
            attemptId: last.attempt_id,
          })
        : null,
    truncated,
    freshness: {
      most_recent_attempt_at: mostRecentAttemptAt,
      staleness_seconds: stalenessSeconds,
      status: freshnessStatus,
    },
    completeness: {
      complete: !truncated && missingLedgerRow === 0,
      truncated,
      attempts_missing_ledger_row: missingLedgerRow,
      attempts_missing_mark: missingMark,
      spine: "poly_copy_trade_decisions",
    },
  };
}

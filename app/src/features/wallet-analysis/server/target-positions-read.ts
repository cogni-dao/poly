// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/target-positions-read`
 * Purpose: Read one account's active copy-target position books from saved facts.
 * Scope: Bounded SQL on the capability-plane transaction. No upstream clients.
 * Invariants:
 *   - PAGE_LOAD_DB_ONLY and SAVED_FACTS_ONLY.
 *   - LIVE_POSITION_DEFINITION is the canonical active + shares + 6h predicate.
 *   - TARGET_SCOPE_IN_SQL clamps every row to the already-authorized account.
 *   - BOUNDED_KEYSET_PAGE returns at most 100 positions plus one truncation probe.
 *   - Vendor cashPnl/curPrice are read from persisted payloads, never re-derived.
 * Side-effects: DB reads only.
 * @public
 */

import {
	POLY_TARGET_POSITION_MAX_AGE_SECONDS,
	POLY_TARGET_POSITIONS_MAX_LIMIT,
	POLY_TARGET_POSITIONS_MAX_TARGETS,
	type PolyAccountTargetPositionsQuery,
	type PolyAccountTargetPositionsResponse,
	type PolyTargetPositionsSort,
} from "@cogni/poly-node-contracts";
import { type SQL, sql } from "drizzle-orm";

import type { AgentGrantTransaction } from "@/features/agent-grants/authorization";
import { liveCurrentPositionSql } from "./current-position-staleness";

const STATEMENT_TIMEOUT_MS = 5_000;
const FRESH_AFTER_SECONDS = 15 * 60;

type TargetCursor = {
	sort: PolyTargetPositionsSort;
	sortValue: string;
	targetWallet: string;
	conditionId: string;
	tokenId: string;
};

export class InvalidTargetPositionCursorError extends Error {
	constructor() {
		super("invalid_cursor");
		this.name = "InvalidTargetPositionCursorError";
	}
}

export function encodeTargetPositionCursor(cursor: TargetCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeTargetPositionCursor(
	value: string,
	expectedSort: PolyTargetPositionsSort,
): TargetCursor {
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		);
		if (!parsed || typeof parsed !== "object") throw new Error("invalid");
		const row = parsed as Record<string, unknown>;
		if (
			row.sort !== expectedSort ||
			typeof row.sortValue !== "string" ||
			!Number.isFinite(Number(row.sortValue)) ||
			typeof row.targetWallet !== "string" ||
			typeof row.conditionId !== "string" ||
			typeof row.tokenId !== "string"
		) {
			throw new Error("invalid");
		}
		return {
			sort: expectedSort,
			sortValue: row.sortValue,
			targetWallet: row.targetWallet,
			conditionId: row.conditionId,
			tokenId: row.tokenId,
		};
	} catch {
		throw new InvalidTargetPositionCursorError();
	}
}

type TargetSummaryRow = {
	captured_at: Date | string;
	target_id: string | null;
	target_wallet: string | null;
	label: string | null;
	wallet_id: string | null;
	position_count: string | number;
	portfolio_value_usdc: string | number;
	last_position_observed_at: Date | string | null;
	cursor_status: string | null;
	last_success_at: Date | string | null;
	staleness_seconds: string | number | null;
	active_target_count: string | number | null;
};

type PopulatedTargetSummaryRow = TargetSummaryRow & {
	target_id: string;
	target_wallet: string;
};

type PositionRow = {
	target_id: string;
	target_wallet: string;
	target_label: string | null;
	condition_id: string;
	token_id: string;
	market_title: string | null;
	event_title: string | null;
	outcome: string | null;
	market_slug: string | null;
	event_slug: string | null;
	shares: string | number;
	cost_basis_usdc: string | number;
	current_value_usdc: string | number;
	portfolio_weight: string | number;
	entry_price: string | number;
	current_price: string | number | null;
	cash_pnl_usdc: string | number | null;
	last_observed_at: Date | string;
	sort_value: string | number;
};

const rowsOf = <T>(result: unknown): T[] =>
	Array.isArray(result)
		? (result as T[])
		: (((result as { rows?: T[] }).rows ?? []) as T[]);

const toIso = (value: Date | string | null): string | null => {
	if (value === null) return null;
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const nullableNumber = (value: string | number | null): number | null =>
	value === null ? null : Number(value);

function canonicalMarketUrl(
	eventSlug: string | null,
	marketSlug: string | null,
): string | null {
	if (eventSlug && marketSlug) {
		return `https://polymarket.com/event/${eventSlug}/${marketSlug}`;
	}
	if (marketSlug) return `https://polymarket.com/market/${marketSlug}`;
	if (eventSlug) return `https://polymarket.com/event/${eventSlug}`;
	return null;
}

function sortValueExpression(sort: PolyTargetPositionsSort): SQL {
	switch (sort) {
		case "current_value":
			return sql`current_value_usdc`;
		case "pnl":
			return sql`coalesce(cash_pnl_usdc, -1e100::numeric)`;
		case "last_observed":
			return sql`extract(epoch from last_observed_at)::numeric`;
		default:
			return sql`portfolio_weight`;
	}
}

function cursorFilter(cursor: TargetCursor | null): SQL {
	if (!cursor) return sql`TRUE`;
	return sql`(
    sort_value < ${cursor.sortValue}::numeric
    OR (
      sort_value = ${cursor.sortValue}::numeric
      AND (target_wallet, condition_id, token_id) >
          (${cursor.targetWallet}, ${cursor.conditionId}, ${cursor.tokenId})
    )
  )`;
}

function targetFilter(targetWallet: string | undefined): SQL {
	return targetWallet
		? sql`lower(t.target_wallet) = ${targetWallet.toLowerCase()}`
		: sql`TRUE`;
}

/** Bounded target summary query, exported for component EXPLAIN evidence. */
export function targetSummarySelect(accountId: string): SQL {
	return sql`
    WITH captured AS (
      SELECT clock_timestamp() AS captured_at
    ), target_rows AS (
      SELECT
        t.id::text AS target_id,
        lower(t.target_wallet) AS target_wallet,
        w.label,
        w.id::text AS wallet_id,
        coalesce(position_summary.position_count, 0) AS position_count,
        coalesce(position_summary.portfolio_value_usdc, 0) AS portfolio_value_usdc,
        position_summary.last_position_observed_at,
        cursor.status AS cursor_status,
        cursor.last_success_at,
        count(*) OVER () AS active_target_count
      FROM poly_copy_trade_targets t
      LEFT JOIN LATERAL (
        SELECT candidate.id, candidate.label
        FROM poly_trader_wallets candidate
        WHERE lower(candidate.wallet_address) = lower(t.target_wallet)
        ORDER BY candidate.updated_at DESC, candidate.id
        LIMIT 1
      ) w ON TRUE
      LEFT JOIN poly_trader_ingestion_cursors cursor
        ON cursor.trader_wallet_id = w.id
       AND cursor.source = 'data-api-positions'
      LEFT JOIN LATERAL (
        SELECT count(*) AS position_count,
               coalesce(sum(p.current_value_usdc), 0) AS portfolio_value_usdc,
               max(p.last_observed_at) AS last_position_observed_at
        FROM poly_trader_current_positions p
        WHERE p.trader_wallet_id = w.id
          AND ${liveCurrentPositionSql("p")}
      ) position_summary ON TRUE
      WHERE t.billing_account_id = ${accountId}
        AND t.disabled_at IS NULL
      ORDER BY lower(t.target_wallet), t.id
      LIMIT ${POLY_TARGET_POSITIONS_MAX_TARGETS + 1}
    )
    SELECT
      captured.captured_at,
      target_rows.*,
      CASE WHEN target_rows.last_success_at IS NULL THEN NULL
           ELSE greatest(
             0,
             extract(epoch from (captured.captured_at - target_rows.last_success_at))
           )
      END AS staleness_seconds
    FROM captured
    LEFT JOIN target_rows ON TRUE
    ORDER BY target_rows.target_wallet, target_rows.target_id
  `;
}

/** Exact page query, exported for component EXPLAIN evidence. */
export function targetPositionRowsSelect(args: {
	accountId: string;
	query: Omit<PolyAccountTargetPositionsQuery, "billing_account_id">;
	cursor: TargetCursor | null;
	limit: number;
}): SQL {
	const sortValue = sortValueExpression(args.query.sort);
	const after = cursorFilter(args.cursor);
	return sql`
    WITH position_facts AS (
      SELECT
        t.id::text AS target_id,
        lower(t.target_wallet) AS target_wallet,
        w.label AS target_label,
        lower(p.condition_id) AS condition_id,
        p.token_id,
        metadata.market_title,
        metadata.event_title,
        metadata.market_slug,
        metadata.event_slug,
        nullif(p.raw->>'outcome', '') AS outcome,
        p.shares,
        p.cost_basis_usdc,
        p.current_value_usdc,
        p.avg_price AS entry_price,
        CASE
          WHEN coalesce(p.raw->>'curPrice', '') ~ '^[0-9]+([.][0-9]+)?$'
          THEN (p.raw->>'curPrice')::numeric
        END AS current_price,
        CASE
          WHEN coalesce(p.raw->>'cashPnl', '') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN (p.raw->>'cashPnl')::numeric
        END AS cash_pnl_usdc,
        p.last_observed_at,
        sum(p.current_value_usdc) OVER (PARTITION BY t.id) AS target_value_usdc
      FROM poly_copy_trade_targets t
      JOIN LATERAL (
        SELECT candidate.id, candidate.label
        FROM poly_trader_wallets candidate
        WHERE lower(candidate.wallet_address) = lower(t.target_wallet)
        ORDER BY candidate.updated_at DESC, candidate.id
        LIMIT 1
      ) w ON TRUE
      JOIN poly_trader_current_positions p
        ON p.trader_wallet_id = w.id
       AND ${liveCurrentPositionSql("p")}
      LEFT JOIN LATERAL (
        SELECT candidate.market_title, candidate.event_title,
               candidate.market_slug, candidate.event_slug
        FROM poly_market_metadata candidate
        WHERE lower(candidate.condition_id) = lower(p.condition_id)
        ORDER BY candidate.fetched_at DESC, candidate.condition_id
        LIMIT 1
      ) metadata ON TRUE
      WHERE t.billing_account_id = ${args.accountId}
        AND t.disabled_at IS NULL
        AND ${targetFilter(args.query.target_wallet)}
    ), weighted AS (
      SELECT *,
        CASE WHEN target_value_usdc > 0
             THEN current_value_usdc / target_value_usdc
             ELSE 0::numeric END AS portfolio_weight
      FROM position_facts
    ), ordered AS (
      SELECT *, ${sortValue} AS sort_value
      FROM weighted
    )
    SELECT *
    FROM ordered
    WHERE ${after}
    ORDER BY sort_value DESC, target_wallet, condition_id, token_id
    LIMIT ${args.limit + 1}
  `;
}

function classifyObservation(row: TargetSummaryRow) {
	const lastSuccessAt = toIso(row.last_success_at);
	const stalenessSeconds = nullableNumber(row.staleness_seconds);
	const freshness =
		lastSuccessAt === null
			? ("never_observed" as const)
			: (stalenessSeconds ?? Number.POSITIVE_INFINITY) <= FRESH_AFTER_SECONDS
				? ("fresh" as const)
				: ("stale" as const);
	if (row.wallet_id === null) {
		return {
			cursor_status: null,
			last_success_at: null,
			last_position_observed_at: null,
			staleness_seconds: null,
			freshness: "never_observed" as const,
			completeness: "unavailable" as const,
			reason: "wallet_not_observed" as const,
		};
	}
	if (lastSuccessAt === null) {
		return {
			cursor_status: cursorStatus(row.cursor_status),
			last_success_at: null,
			last_position_observed_at: toIso(row.last_position_observed_at),
			staleness_seconds: null,
			freshness,
			completeness: "unavailable" as const,
			reason: "positions_never_observed" as const,
		};
	}
	if (row.cursor_status !== "ok") {
		return {
			cursor_status: cursorStatus(row.cursor_status),
			last_success_at: lastSuccessAt,
			last_position_observed_at: toIso(row.last_position_observed_at),
			staleness_seconds: stalenessSeconds,
			freshness,
			completeness: "partial" as const,
			reason: "positions_cursor_not_ok" as const,
		};
	}
	return {
		cursor_status: "ok" as const,
		last_success_at: lastSuccessAt,
		last_position_observed_at: toIso(row.last_position_observed_at),
		staleness_seconds: stalenessSeconds,
		freshness,
		completeness: "complete" as const,
		reason: "complete_saved_snapshot" as const,
	};
}

function cursorStatus(
	value: string | null,
): PolyAccountTargetPositionsResponse["targets"][number]["observation"]["cursor_status"] {
	return value === "pending" ||
		value === "ok" ||
		value === "partial" ||
		value === "stale" ||
		value === "error"
		? value
		: null;
}

/** One account-scoped, saved-facts-only target portfolio read. */
export async function getTargetPositionsForAccount(
	tx: AgentGrantTransaction,
	accountId: string,
	query: Omit<PolyAccountTargetPositionsQuery, "billing_account_id">,
): Promise<PolyAccountTargetPositionsResponse> {
	await tx.execute(
		sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`),
	);

	const summaryRows = rowsOf<TargetSummaryRow>(
		await tx.execute(targetSummarySelect(accountId)),
	);
	const capturedAt = toIso(summaryRows[0]?.captured_at ?? null);
	if (!capturedAt) throw new Error("invalid_database_clock");
	const targetRows = summaryRows.filter(
		(row): row is PopulatedTargetSummaryRow =>
			row.target_id !== null && row.target_wallet !== null,
	);

	const activeTargetCount = Number(summaryRows[0]?.active_target_count ?? 0);
	const targetsTruncated =
		targetRows.length > POLY_TARGET_POSITIONS_MAX_TARGETS;
	const pagedTargetRows = targetRows.slice(
		0,
		POLY_TARGET_POSITIONS_MAX_TARGETS,
	);
	const targets = pagedTargetRows.map((row) => ({
		target_id: row.target_id,
		target_wallet: row.target_wallet,
		label: row.label,
		live_position_count: Number(row.position_count),
		live_portfolio_value_usdc: Number(row.portfolio_value_usdc),
		observation: classifyObservation(row),
	}));

	const limit = Math.min(query.limit, POLY_TARGET_POSITIONS_MAX_LIMIT);
	const cursor = query.cursor
		? decodeTargetPositionCursor(query.cursor, query.sort)
		: null;
	const rawPositions = rowsOf<PositionRow>(
		await tx.execute(
			targetPositionRowsSelect({ accountId, query, cursor, limit }),
		),
	);
	const truncated = rawPositions.length > limit;
	const pageRows = rawPositions.slice(0, limit);
	const positions = pageRows.map((row) => ({
		target_id: row.target_id,
		target_wallet: row.target_wallet,
		target_label: row.target_label,
		condition_id: row.condition_id,
		token_id: row.token_id,
		market_title: row.market_title,
		event_title: row.event_title,
		outcome: row.outcome,
		market_slug: row.market_slug,
		event_slug: row.event_slug,
		market_url: canonicalMarketUrl(row.event_slug, row.market_slug),
		shares: Number(row.shares),
		cost_basis_usdc: Number(row.cost_basis_usdc),
		current_value_usdc: Number(row.current_value_usdc),
		portfolio_weight: Number(row.portfolio_weight),
		entry_price: Number(row.entry_price),
		current_price: nullableNumber(row.current_price),
		cash_pnl_usdc: nullableNumber(row.cash_pnl_usdc),
		last_observed_at: toIso(row.last_observed_at) ?? capturedAt,
	}));
	const last = pageRows.at(-1);
	const nextCursor =
		truncated && last
			? encodeTargetPositionCursor({
					sort: query.sort,
					sortValue: String(last.sort_value),
					targetWallet: last.target_wallet,
					conditionId: last.condition_id,
					tokenId: last.token_id,
				})
			: null;

	const completeTargets = targets.filter(
		(target) => target.observation.completeness === "complete",
	).length;
	const partialTargets = targets.filter(
		(target) => target.observation.completeness === "partial",
	).length;
	const unavailableTargets = targets.filter(
		(target) => target.observation.completeness === "unavailable",
	).length;
	const successTimes = targets
		.map((target) => target.observation.last_success_at)
		.filter((value): value is string => value !== null)
		.sort();
	const positionTimes = targets
		.map((target) => target.observation.last_position_observed_at)
		.filter((value): value is string => value !== null)
		.sort();

	return {
		billing_account_id: accountId,
		captured_at: capturedAt,
		target_wallet: query.target_wallet ?? null,
		sort: query.sort,
		limit,
		targets,
		positions,
		next_cursor: nextCursor,
		truncated,
		live_position_rule: {
			active: true,
			shares_greater_than: 0,
			max_age_seconds: POLY_TARGET_POSITION_MAX_AGE_SECONDS,
		},
		freshness: {
			oldest_target_success_at: successTimes[0] ?? null,
			newest_position_observed_at: positionTimes.at(-1) ?? null,
		},
		completeness: {
			complete:
				!targetsTruncated &&
				targets.length === activeTargetCount &&
				completeTargets === targets.length,
			active_target_count: activeTargetCount,
			targets_returned: targets.length,
			targets_truncated: targetsTruncated,
			complete_targets: completeTargets,
			partial_targets: partialTargets,
			unavailable_targets: unavailableTargets,
		},
		sources: {
			targets: "poly_copy_trade_targets",
			positions: "poly_trader_current_positions",
			metadata: "poly_market_metadata",
			observation: "poly_trader_ingestion_cursors",
		},
	};
}

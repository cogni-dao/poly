// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/target-positions-read`
 * Purpose: Read one account's persisted target and Position-gap decision books.
 * Scope: Bounded SQL on the capability-plane transaction. No upstream clients.
 * Invariants:
 *   - PAGE_LOAD_DB_ONLY and PERSISTED_FACTS_ONLY.
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
	PolyPositionGapDecisionReasonSchema,
	type PolyTargetPositionsSort,
} from "@cogni/poly-node-contracts";
import { type SQL, sql } from "drizzle-orm";

import type { AgentGrantTransaction } from "@/features/agent-grants/authorization";
import { targetIdFromWallet } from "@/shared/util/poly-target-id";
import { liveCurrentPositionSql } from "./current-position-staleness";
import { COPY_TARGET_POSITION_CURSOR_SOURCE } from "./position-observation-sources";
import { readPositionGapRuntimeByWallet } from "./position-gap-runtime-read";

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
	sizing_policy_kind: string | null;
};

type PopulatedTargetSummaryRow = TargetSummaryRow & {
	target_id: string;
	target_wallet: string;
};

type ConfiguredSizingPolicyKind =
	| "auto"
	| "min_bet"
	| "target_percentile_scaled"
	| "position_gap"
	| "mirror_fill_exact";
type EffectiveSizingPolicyKind = Exclude<ConfiguredSizingPolicyKind, "auto">;

export type TargetPositionsReadBinding = {
	resolveEffectiveKind: (
		targetWallet: `0x${string}`,
		configuredKind: ConfiguredSizingPolicyKind,
	) => EffectiveSizingPolicyKind;
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
	row_source: "saved_only" | "saved_and_runtime" | "runtime_only";
	shares: string | number | null;
	cost_basis_usdc: string | number | null;
	current_value_usdc: string | number | null;
	portfolio_weight: string | number;
	entry_price: string | number | null;
	current_price: string | number | null;
	cash_pnl_usdc: string | number | null;
	last_observed_at: Date | string;
	sort_value: string | number;
	runtime_decision_reasons: string | null;
	runtime_target_weight: string | number | null;
	runtime_desired_shares: string | number | null;
	runtime_held_shares: string | number | null;
	runtime_open_shares: string | number | null;
	runtime_gap_shares: string | number | null;
	runtime_locked_overweight_shares: string | number | null;
	runtime_price_cap: string | number | null;
	runtime_market_floor_usdc: string | number | null;
	runtime_minimum_sleeve_usdc: string | number | null;
	runtime_cohort_count: string | number | null;
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
			return sql`coalesce(current_value_usdc, runtime_current_value_usdc, 0::numeric)`;
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
export function targetSummarySelect(
	accountId: string,
	targetWallet?: string,
): SQL {
	return sql`
    WITH captured AS (
      SELECT clock_timestamp() AS captured_at
    ), target_rows AS (
      SELECT
        t.id::text AS target_id,
        lower(t.target_wallet) AS target_wallet,
        w.label,
		w.id::text AS wallet_id,
		t.sizing_policy_kind,
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
       AND cursor.source = ${COPY_TARGET_POSITION_CURSOR_SOURCE}
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
        AND ${targetFilter(targetWallet)}
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
	runtimeTargets: readonly {
		wallet: string;
		targetId: string;
		runId: string;
	}[];
}): SQL {
	const sortValue = sortValueExpression(args.query.sort);
	const after = cursorFilter(args.cursor);
	const runtimeTargets =
		args.runtimeTargets.length > 0
			? sql`(VALUES ${sql.join(
					args.runtimeTargets.map(
						(target) =>
							sql`(${target.wallet}, ${target.targetId}::uuid, ${target.runId}::uuid)`,
					),
					sql`, `,
				)})`
			: sql`(SELECT NULL::text AS wallet, NULL::uuid AS target_id, NULL::uuid AS run_id WHERE FALSE)`;
	return sql`
    WITH runtime_targets(wallet, target_id, run_id) AS ${runtimeTargets},
    active_targets AS (
      SELECT
        t.id::text AS target_id,
        lower(t.target_wallet) AS target_wallet,
        w.id AS wallet_id,
        w.label AS target_label,
        runtime_targets.target_id AS runtime_target_id,
        runtime_targets.run_id AS runtime_run_id
      FROM poly_copy_trade_targets t
      LEFT JOIN runtime_targets
        ON runtime_targets.wallet = lower(t.target_wallet)
      LEFT JOIN LATERAL (
        SELECT candidate.id, candidate.label
        FROM poly_trader_wallets candidate
        WHERE lower(candidate.wallet_address) = lower(t.target_wallet)
        ORDER BY candidate.updated_at DESC, candidate.id
        LIMIT 1
      ) w ON TRUE
      WHERE t.billing_account_id = ${args.accountId}
        AND t.disabled_at IS NULL
        AND ${targetFilter(args.query.target_wallet)}
      ORDER BY lower(t.target_wallet), t.id
      LIMIT ${POLY_TARGET_POSITIONS_MAX_TARGETS}
    ), latest_runs AS (
      SELECT active_targets.*, runtime.plan, runtime.target_snapshot_as_of,
             runtime.started_at, runtime.eligible_net_nav_usdc
      FROM active_targets
      LEFT JOIN poly_position_gap_runs runtime
        ON runtime.billing_account_id = ${args.accountId}
       AND runtime.target_id = active_targets.runtime_target_id
       AND runtime.id = active_targets.runtime_run_id
    ), runtime_diagnostics AS (
      SELECT
        latest_runs.target_id,
        latest_runs.target_wallet,
        latest_runs.target_label,
        diagnostic.value->>'conditionId' AS condition_id,
        diagnostic.value->>'tokenId' AS token_id,
        diagnostic.value->>'reason' AS decision_reason,
        (diagnostic.value->>'desiredShares')::numeric AS desired_shares,
        (diagnostic.value->>'heldShares')::numeric AS held_shares,
        (diagnostic.value->>'openShares')::numeric AS open_shares,
        (diagnostic.value->>'gapShares')::numeric AS gap_shares,
        (diagnostic.value->>'targetWeight')::numeric AS target_weight,
        CASE WHEN coalesce(diagnostic.value->>'limitPrice', '') ~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
             THEN (diagnostic.value->>'limitPrice')::numeric END AS price_cap,
        CASE WHEN coalesce(diagnostic.value->>'floorNotionalUsdc', '') ~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
             THEN (diagnostic.value->>'floorNotionalUsdc')::numeric END AS market_floor_usdc,
        CASE WHEN coalesce(diagnostic.value->>'minimumSleeveUsdc', '') ~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
             THEN (diagnostic.value->>'minimumSleeveUsdc')::numeric END AS minimum_sleeve_usdc,
        coalesce(latest_runs.target_snapshot_as_of, latest_runs.started_at) AS last_observed_at,
        latest_runs.eligible_net_nav_usdc
      FROM latest_runs
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(latest_runs.plan->'diagnostics') = 'array'
             THEN latest_runs.plan->'diagnostics' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS diagnostic(value, ordinal)
      WHERE diagnostic.ordinal <= 2000
        AND coalesce(diagnostic.value->>'conditionId', '') <> ''
        AND coalesce(diagnostic.value->>'tokenId', '') <> ''
        AND diagnostic.value->>'reason' IN (
          'allocated','allocation_headroom','below_market_floor',
          'blocked_by_opposite_hold','cohort_waiting','condition_closed',
          'invalid_target_mark','invalid_cohort','invalid_quote','missing_cohort',
          'no_gap','per_order_cap','venue_unknown'
        )
        AND coalesce(diagnostic.value->>'desiredShares', '') ~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
        AND coalesce(diagnostic.value->>'heldShares', '') ~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
        AND coalesce(diagnostic.value->>'openShares', '') ~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
        AND coalesce(diagnostic.value->>'gapShares', '') ~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
        AND coalesce(diagnostic.value->>'targetWeight', '') ~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
    ), runtime_locked AS (
      SELECT
        latest_runs.target_id,
        locked.value->>'conditionId' AS condition_id,
        locked.value->>'tokenId' AS token_id,
        sum((locked.value->>'excessShares')::numeric) AS locked_overweight_shares
      FROM latest_runs
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(latest_runs.plan->'lockedOverweights') = 'array'
             THEN latest_runs.plan->'lockedOverweights' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS locked(value, ordinal)
      WHERE locked.ordinal <= 2000
        AND coalesce(locked.value->>'conditionId', '') <> ''
        AND coalesce(locked.value->>'tokenId', '') <> ''
        AND coalesce(locked.value->>'excessShares', '') ~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
      GROUP BY latest_runs.target_id, locked.value->>'conditionId', locked.value->>'tokenId'
    ), runtime_facts AS (
      SELECT
        runtime_diagnostics.target_id,
        runtime_diagnostics.target_wallet,
        runtime_diagnostics.target_label,
        runtime_diagnostics.condition_id,
        runtime_diagnostics.token_id,
        string_agg(DISTINCT runtime_diagnostics.decision_reason, ',' ORDER BY runtime_diagnostics.decision_reason) AS decision_reasons,
        sum(runtime_diagnostics.desired_shares) AS desired_shares,
        sum(runtime_diagnostics.held_shares) AS held_shares,
        sum(runtime_diagnostics.open_shares) AS open_shares,
        sum(runtime_diagnostics.gap_shares) AS gap_shares,
        max(runtime_diagnostics.target_weight) AS target_weight,
        min(runtime_diagnostics.price_cap) AS price_cap,
        min(runtime_diagnostics.market_floor_usdc) AS market_floor_usdc,
        min(runtime_diagnostics.minimum_sleeve_usdc) AS minimum_sleeve_usdc,
        max(runtime_diagnostics.last_observed_at) AS last_observed_at,
        max(runtime_diagnostics.eligible_net_nav_usdc) AS eligible_net_nav_usdc,
        count(*) AS cohort_count,
        coalesce(max(runtime_locked.locked_overweight_shares), 0) AS locked_overweight_shares
      FROM runtime_diagnostics
      LEFT JOIN runtime_locked
        ON runtime_locked.target_id = runtime_diagnostics.target_id
       AND runtime_locked.condition_id = runtime_diagnostics.condition_id
       AND runtime_locked.token_id = runtime_diagnostics.token_id
      GROUP BY runtime_diagnostics.target_id, runtime_diagnostics.target_wallet,
               runtime_diagnostics.target_label, runtime_diagnostics.condition_id,
               runtime_diagnostics.token_id
    ), position_facts AS (
      SELECT
        active_targets.target_id,
        active_targets.target_wallet,
        active_targets.target_label,
        lower(p.condition_id) AS condition_id,
        p.token_id,
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
        sum(p.current_value_usdc) OVER (PARTITION BY active_targets.target_id) AS target_value_usdc
      FROM active_targets
      JOIN poly_trader_current_positions p
        ON p.trader_wallet_id = active_targets.wallet_id
       AND ${liveCurrentPositionSql("p")}
    ), weighted AS (
      SELECT *,
        CASE WHEN target_value_usdc > 0
             THEN current_value_usdc / target_value_usdc
             ELSE 0::numeric END AS portfolio_weight
      FROM position_facts
    ), combined AS (
      SELECT
        coalesce(saved.target_id, runtime.target_id) AS target_id,
        coalesce(saved.target_wallet, runtime.target_wallet) AS target_wallet,
        coalesce(saved.target_label, runtime.target_label) AS target_label,
        coalesce(saved.condition_id, runtime.condition_id) AS condition_id,
        coalesce(saved.token_id, runtime.token_id) AS token_id,
        saved.outcome,
        saved.shares,
        saved.cost_basis_usdc,
        saved.current_value_usdc,
        coalesce(saved.portfolio_weight, runtime.target_weight, 0::numeric) AS portfolio_weight,
        saved.entry_price,
        saved.current_price,
        saved.cash_pnl_usdc,
        greatest(saved.last_observed_at, runtime.last_observed_at) AS last_observed_at,
        CASE WHEN saved.token_id IS NOT NULL AND runtime.token_id IS NOT NULL THEN 'saved_and_runtime'
             WHEN runtime.token_id IS NOT NULL THEN 'runtime_only'
             ELSE 'saved_only' END AS row_source,
        runtime.decision_reasons AS runtime_decision_reasons,
        runtime.target_weight AS runtime_target_weight,
        runtime.desired_shares AS runtime_desired_shares,
        runtime.held_shares AS runtime_held_shares,
        runtime.open_shares AS runtime_open_shares,
        runtime.gap_shares AS runtime_gap_shares,
        runtime.locked_overweight_shares AS runtime_locked_overweight_shares,
        runtime.price_cap AS runtime_price_cap,
        runtime.market_floor_usdc AS runtime_market_floor_usdc,
        runtime.minimum_sleeve_usdc AS runtime_minimum_sleeve_usdc,
        runtime.cohort_count AS runtime_cohort_count,
        runtime.target_weight * runtime.eligible_net_nav_usdc AS runtime_current_value_usdc
      FROM weighted saved
      FULL OUTER JOIN runtime_facts runtime
        ON runtime.target_id = saved.target_id
       AND runtime.condition_id = saved.condition_id
       AND runtime.token_id = saved.token_id
    ), enriched AS (
      SELECT combined.*, metadata.market_title, metadata.event_title,
             metadata.market_slug, metadata.event_slug
      FROM combined
      LEFT JOIN LATERAL (
        SELECT candidate.market_title, candidate.event_title,
               candidate.market_slug, candidate.event_slug
        FROM poly_market_metadata candidate
        WHERE lower(candidate.condition_id) = lower(combined.condition_id)
        ORDER BY candidate.fetched_at DESC, candidate.condition_id
        LIMIT 1
      ) metadata ON TRUE
    ), ordered AS (
      SELECT *, ${sortValue} AS sort_value
      FROM enriched
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
	if (freshness === "stale") {
		return {
			cursor_status: "ok" as const,
			last_success_at: lastSuccessAt,
			last_position_observed_at: toIso(row.last_position_observed_at),
			staleness_seconds: stalenessSeconds,
			freshness,
			completeness: "partial" as const,
			reason: "saved_snapshot_stale" as const,
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

/** One account-scoped, persisted-facts-only target portfolio read. */
export async function getTargetPositionsForAccount(
	tx: AgentGrantTransaction,
	accountId: string,
	query: Omit<PolyAccountTargetPositionsQuery, "billing_account_id">,
	binding: TargetPositionsReadBinding,
): Promise<PolyAccountTargetPositionsResponse> {
	await tx.execute(
		sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`),
	);

	const summaryRows = rowsOf<TargetSummaryRow>(
		await tx.execute(targetSummarySelect(accountId, query.target_wallet)),
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
	const capturedAtDate = new Date(capturedAt);
	const effectiveKindByWallet = new Map(
		pagedTargetRows.map((row) => [
			row.target_wallet.toLowerCase(),
			binding.resolveEffectiveKind(
				row.target_wallet as `0x${string}`,
				(row.sizing_policy_kind ?? "auto") as ConfiguredSizingPolicyKind,
			),
		]),
	);
	const positionGapWallets = pagedTargetRows
		.filter(
			(row) =>
				effectiveKindByWallet.get(row.target_wallet.toLowerCase()) ===
				"position_gap",
		)
		.map((row) => row.target_wallet);
	const runtimeByWallet = await readPositionGapRuntimeByWallet(
		tx,
		accountId,
		positionGapWallets,
		capturedAtDate,
	);
	const targets = pagedTargetRows.map((row) => ({
		target_id: row.target_id,
		target_wallet: row.target_wallet,
		label: row.label,
		live_position_count: Number(row.position_count),
		live_portfolio_value_usdc: Number(row.portfolio_value_usdc),
		observation: classifyObservation(row),
		position_gap_runtime:
			runtimeByWallet.get(row.target_wallet.toLowerCase()) ??
			(effectiveKindByWallet.get(row.target_wallet.toLowerCase()) ===
			"position_gap"
				? ({ status: "pending", reason: "no_reconciliation_run" } as const)
				: ({ status: "not_applicable" } as const)),
	}));

	const limit = Math.min(query.limit, POLY_TARGET_POSITIONS_MAX_LIMIT);
	const cursor = query.cursor
		? decodeTargetPositionCursor(query.cursor, query.sort)
		: null;
	const rawPositions = rowsOf<PositionRow>(
		await tx.execute(
			targetPositionRowsSelect({
				accountId,
				query,
				cursor,
				limit,
				runtimeTargets: pagedTargetRows.flatMap((row) => {
					const runtime = runtimeByWallet.get(row.target_wallet.toLowerCase());
					return runtime?.status === "observed"
						? [
								{
									wallet: row.target_wallet.toLowerCase(),
									targetId: targetIdFromWallet(
										row.target_wallet as `0x${string}`,
									),
									runId: runtime.run.run_id,
								},
							]
						: [];
				}),
			}),
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
		row_source: row.row_source,
		shares: nullableNumber(row.shares),
		cost_basis_usdc: nullableNumber(row.cost_basis_usdc),
		current_value_usdc: nullableNumber(row.current_value_usdc),
		portfolio_weight: Number(row.portfolio_weight),
		entry_price: nullableNumber(row.entry_price),
		current_price: nullableNumber(row.current_price),
		cash_pnl_usdc: nullableNumber(row.cash_pnl_usdc),
		last_observed_at: toIso(row.last_observed_at) ?? capturedAt,
		runtime:
			row.runtime_cohort_count === null
				? null
				: {
						decision_reasons: (row.runtime_decision_reasons ?? "")
							.split(",")
							.filter(Boolean)
							.map((reason) =>
								PolyPositionGapDecisionReasonSchema.parse(reason),
							),
						target_weight: Number(row.runtime_target_weight),
						desired_shares: Number(row.runtime_desired_shares),
						held_shares: Number(row.runtime_held_shares),
						open_shares: Number(row.runtime_open_shares),
						gap_shares: Number(row.runtime_gap_shares),
						locked_overweight_shares: Number(
							row.runtime_locked_overweight_shares,
						),
						price_cap: nullableNumber(row.runtime_price_cap),
						market_floor_usdc: nullableNumber(row.runtime_market_floor_usdc),
						minimum_sleeve_usdc: nullableNumber(
							row.runtime_minimum_sleeve_usdc,
						),
						cohort_count: Number(row.runtime_cohort_count),
					},
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

	const targetCompleteness = targets.map((target) => {
		const runtime = target.position_gap_runtime;
		if (target.observation.completeness === "unavailable") return "unavailable";
		if (runtime.status === "pending" || runtime.status === "unavailable") {
			return "unavailable";
		}
		if (
			target.observation.completeness === "partial" ||
			(runtime.status === "observed" &&
				(runtime.snapshot.completeness !== "complete" ||
					runtime.snapshot.freshness !== "fresh" ||
					runtime.positions_truncated))
		) {
			return "partial";
		}
		return "complete";
	});
	const completeTargets = targetCompleteness.filter(
		(value) => value === "complete",
	).length;
	const partialTargets = targetCompleteness.filter(
		(value) => value === "partial",
	).length;
	const unavailableTargets = targetCompleteness.filter(
		(value) => value === "unavailable",
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
			runtime: "poly_position_gap_runs.plan.diagnostics",
		},
	};
}

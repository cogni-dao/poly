// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/copy-target-position-hydration-service`
 * Purpose: Hydrate the exact active-copy-target position cohorts for locally
 * held, fill-backed mirror positions when a power trader's whole-wallet V1
 * position walk cannot publish completely.
 * Scope: Off-render observation only. Selects a bounded cohort from saved
 * placement/current-position lineage, reads Data API V2 through the shared
 * provider, and atomically persists existing position facts.
 * Invariants:
 *   - PAGE_LOAD_DB_ONLY: dashboard routes never import or invoke this writer.
 *   - LINEAGE_SCOPED: only active target rows whose tenant currently holds an
 *     exact condition+token produced by a realized copy-fill are eligible.
 *   - COMPLETE_COHORTS_ONLY: the provider must complete every cursor/chunk
 *     before any row for that target is persisted.
 *   - PRESERVE_UNRELATED_ROWS: publication touches only the requested target
 *     wallet and condition cohort; other conditions and wallets are unchanged.
 *   - NO_V1_FALLBACK: failures preserve the last saved facts and return an
 *     error count; they never widen to the capped legacy walk.
 * Side-effects: Data API V2 reads and Postgres writes through injected deps.
 */

import { createHash } from "node:crypto";
import {
	polyTraderCurrentPositions,
	polyTraderPositionSnapshots,
	polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import type { LoggerPort } from "@cogni/poly-market-provider";
import type {
	PolymarketDataApiClient,
	PolymarketUserPosition,
} from "@cogni/poly-market-provider/adapters/polymarket";
import { eq, type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { targetIdFromWallet } from "@/shared/util/poly-target-id";
import { liveCurrentPositionSql } from "./current-position-staleness";

type Db =
	| NodePgDatabase<Record<string, unknown>>
	| PostgresJsDatabase<Record<string, unknown>>;

type CohortRow = {
	target_wallet: string | null;
	target_id: string | null;
	condition_id: string | null;
	token_id: string | null;
};

export type CopyTargetPositionCohort = {
	targetWallet: string;
	conditions: string[];
	exactLocalKeys: Array<{ conditionId: string; tokenId: string }>;
};

export type CopyTargetPositionHydrationResult = {
	cohorts: number;
	conditions: number;
	rows: number;
	errors: number;
};

/**
 * Select the dashboard's locally-held population through durable execution
 * lineage. This is a bounded DISTINCT projection — no raw fill population is
 * hydrated into V8.
 */
export async function readCopyTargetPositionCohorts(db: {
	execute(query: SQL): Promise<unknown>;
}): Promise<CopyTargetPositionCohort[]> {
	const rows = normalizeRows<CohortRow>(
		await db.execute(sql`
    WITH active_targets AS (
      -- Match dbTargetSource.listAllActive's live-mode activation predicate:
      -- target row + unrevoked connection + unrevoked/unexpired grant.
      SELECT DISTINCT
        t.billing_account_id,
        lower(t.target_wallet) AS target_wallet,
        lower(c.funder_address) AS local_wallet
      FROM poly_copy_trade_targets t
      JOIN poly_wallet_connections c
        ON c.billing_account_id = t.billing_account_id
       AND c.revoked_at IS NULL
      JOIN poly_wallet_grants g
        ON g.wallet_connection_id = c.id
       AND g.revoked_at IS NULL
       AND (g.expires_at IS NULL OR g.expires_at > NOW())
      WHERE t.disabled_at IS NULL
    ), realized_copy_lineage_ranked AS (
      SELECT
        f.billing_account_id,
        f.target_id::text AS target_id,
        lower(NULLIF(f.attributes->>'target_wallet', '')) AS target_wallet,
        lower(COALESCE(
          NULLIF(f.attributes->>'condition_id', ''),
          NULLIF(regexp_replace(
            f.market_id,
            '^prediction-market:polymarket:',
            ''
          ), '')
        )) AS condition_id,
        NULLIF(f.attributes->>'token_id', '') AS token_id,
        f.position_lifecycle,
        row_number() OVER (
          PARTITION BY
            f.billing_account_id,
            f.target_id,
            lower(COALESCE(
              NULLIF(f.attributes->>'condition_id', ''),
              NULLIF(regexp_replace(
                f.market_id,
                '^prediction-market:polymarket:',
                ''
              ), '')
            )),
            NULLIF(f.attributes->>'token_id', '')
          ORDER BY f.observed_at DESC, f.updated_at DESC, f.client_order_id DESC
        ) AS identity_rank
      FROM poly_copy_trade_fills f
      WHERE f.order_id IS NOT NULL
        AND f.mode = 'live'
        AND (
          COALESCE(f.attributes->>'position_gap_version', '') <> '3'
          OR f.attributes->>'realized_fill_source' IN ('clob_associated_trades', 'data_api_activity_position')
        )
        AND (
          COALESCE(f.shares, 0) > 0
          OR f.status = 'filled'
          OR (
            COALESCE(f.attributes->>'filled_size_usdc', '')
              ~ '^[0-9]+(\\.[0-9]+)?$'
            AND (f.attributes->>'filled_size_usdc')::numeric > 0
          )
        )
    ), realized_copy_lineage AS (
      SELECT
        billing_account_id,
        target_id,
        target_wallet,
        condition_id,
        token_id,
        position_lifecycle IN ('closed', 'redeemed', 'loser', 'dust') AS terminal
      FROM realized_copy_lineage_ranked
      WHERE identity_rank = 1
    )
    SELECT DISTINCT
      target.target_wallet,
      lineage.target_id,
      lineage.condition_id,
      lineage.token_id
    FROM active_targets target
    JOIN realized_copy_lineage lineage
      ON lineage.billing_account_id = target.billing_account_id
     AND lineage.target_wallet = target.target_wallet
    JOIN poly_trader_wallets local_wallet
      ON lower(local_wallet.wallet_address) = target.local_wallet
     AND local_wallet.kind = 'cogni_wallet'
     AND local_wallet.active_for_research = true
     AND local_wallet.disabled_at IS NULL
    LEFT JOIN poly_trader_current_positions local_position
      ON local_position.trader_wallet_id = local_wallet.id
     AND lower(local_position.condition_id) = lineage.condition_id
     AND local_position.token_id = lineage.token_id
    WHERE (
      (${liveCurrentPositionSql("local_position")})
      OR lineage.terminal
    )
    ORDER BY target.target_wallet, lineage.condition_id, lineage.token_id
  `),
	);

	const byTarget = new Map<string, CopyTargetPositionCohort>();
	for (const row of rows) {
		if (
			typeof row.target_wallet !== "string" ||
			!/^0x[0-9a-f]{40}$/.test(row.target_wallet) ||
			row.target_id !==
				targetIdFromWallet(row.target_wallet as `0x${string}`) ||
			typeof row.condition_id !== "string" ||
			!/^0x[0-9a-f]{64}$/.test(row.condition_id) ||
			typeof row.token_id !== "string" ||
			row.token_id.length === 0
		) {
			throw new Error("invalid copy-target position cohort lineage");
		}
		const cohort = byTarget.get(row.target_wallet) ?? {
			targetWallet: row.target_wallet,
			conditions: [],
			exactLocalKeys: [],
		};
		if (!cohort.conditions.includes(row.condition_id)) {
			cohort.conditions.push(row.condition_id);
		}
		cohort.exactLocalKeys.push({
			conditionId: row.condition_id,
			tokenId: row.token_id,
		});
		byTarget.set(row.target_wallet, cohort);
	}
	return [...byTarget.values()];
}

export async function hydrateCopyTargetPositions(input: {
	db: Db;
	client: PolymarketDataApiClient;
	logger: LoggerPort;
	signal?: AbortSignal | undefined;
}): Promise<CopyTargetPositionHydrationResult> {
	const cohorts = await readCopyTargetPositionCohorts(input.db);
	let conditions = 0;
	let rows = 0;
	let errors = 0;
	for (const cohort of cohorts) {
		input.signal?.throwIfAborted();
		try {
			const positions = await input.client.listUserPositionsV2(
				cohort.targetWallet,
				{
					conditions: cohort.conditions,
					...(input.signal === undefined ? {} : { signal: input.signal }),
				},
			);
			const positivePositions = positions.filter(
				(position) => position.size > 0,
			);
			await persistScopedTargetPositions({
				db: input.db,
				targetWallet: cohort.targetWallet,
				conditions: cohort.conditions,
				positions: positivePositions,
			});
			conditions += cohort.conditions.length;
			rows += positivePositions.length;
		} catch (error) {
			if (input.signal?.aborted) throw error;
			errors += 1;
			input.logger.warn(
				{
					event: "poly.trader.target_positions_v2",
					phase: "cohort_rejected",
					condition_count: cohort.conditions.length,
					error_class: classifyHydrationError(error),
				},
				"copy-target V2 position cohort rejected; saved facts preserved",
			);
		}
	}
	input.logger.info(
		{
			event: "poly.trader.target_positions_v2",
			phase: errors === 0 ? "ok" : "partial",
			cohort_count: cohorts.length,
			condition_count: conditions,
			position_rows: rows,
			errors,
		},
		"copy-target V2 position hydration complete",
	);
	return { cohorts: cohorts.length, conditions, rows, errors };
}

async function persistScopedTargetPositions(input: {
	db: Db;
	targetWallet: string;
	conditions: readonly string[];
	positions: readonly PolymarketUserPosition[];
}): Promise<void> {
	const observedAt = new Date();
	const observedAtIso = observedAt.toISOString();
	await (
		input.db as unknown as {
			transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
		}
	).transaction(async (tx) => {
		const wallet = await resolveTargetWallet(
			tx,
			input.targetWallet,
			observedAt,
		);
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${`poly:positions:${wallet.id}`}, 0))`,
		);
		const values = input.positions.map((position) => ({
			traderWalletId: wallet.id,
			conditionId: position.conditionId.toLowerCase(),
			tokenId: position.asset,
			shares: position.size.toFixed(8),
			costBasisUsdc: positionCostUsdc(position).toFixed(8),
			currentValueUsdc: position.currentValue.toFixed(8),
			avgPrice: position.avgPrice.toFixed(8),
			contentHash: hashPositionFact(position),
			capturedAt: observedAt,
			raw: position as unknown as Record<string, unknown>,
		}));
		if (values.length > 0) {
			await tx
				.insert(polyTraderPositionSnapshots)
				.values(values)
				.onConflictDoNothing({
					target: [
						polyTraderPositionSnapshots.traderWalletId,
						polyTraderPositionSnapshots.conditionId,
						polyTraderPositionSnapshots.tokenId,
						polyTraderPositionSnapshots.contentHash,
					],
				});
			await tx
				.insert(polyTraderCurrentPositions)
				.values(
					values.map((value) => ({
						traderWalletId: value.traderWalletId,
						conditionId: value.conditionId,
						tokenId: value.tokenId,
						active: true,
						shares: value.shares,
						costBasisUsdc: value.costBasisUsdc,
						currentValueUsdc: value.currentValueUsdc,
						avgPrice: value.avgPrice,
						contentHash: value.contentHash,
						lastObservedAt: observedAt,
						raw: value.raw,
					})),
				)
				.onConflictDoUpdate({
					target: [
						polyTraderCurrentPositions.traderWalletId,
						polyTraderCurrentPositions.conditionId,
						polyTraderCurrentPositions.tokenId,
					],
					set: {
						active: true,
						shares: sql`excluded.shares`,
						costBasisUsdc: sql`excluded.cost_basis_usdc`,
						currentValueUsdc: sql`excluded.current_value_usdc`,
						avgPrice: sql`excluded.avg_price`,
						contentHash: sql`excluded.content_hash`,
						lastObservedAt: observedAt,
						raw: sql`excluded.raw`,
					},
				});
		}

		const conditionRows = JSON.stringify(
			input.conditions.map((conditionId) => ({ condition_id: conditionId })),
		);
		const observedKeys = JSON.stringify(
			values.map((value) => ({
				condition_id: value.conditionId,
				token_id: value.tokenId,
			})),
		);
		await tx.execute(sql`
      UPDATE poly_trader_current_positions p
      SET active = false, last_observed_at = ${observedAtIso}::timestamptz
      WHERE p.trader_wallet_id = ${wallet.id}::uuid
        AND EXISTS (
          SELECT 1
          FROM jsonb_to_recordset(${conditionRows}::jsonb)
            AS requested(condition_id text)
          WHERE lower(requested.condition_id) = lower(p.condition_id)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset(${observedKeys}::jsonb)
            AS observed(condition_id text, token_id text)
          WHERE lower(observed.condition_id) = lower(p.condition_id)
            AND observed.token_id = p.token_id
        )
    `);
	});
}

async function resolveTargetWallet(
	db: Db,
	targetWallet: string,
	observedAt: Date,
): Promise<{ id: string }> {
	const candidates = normalizeRows<{ id: string }>(
		await db.execute(sql`
    SELECT id
    FROM poly_trader_wallets
    WHERE lower(wallet_address) = lower(${targetWallet})
    ORDER BY updated_at DESC, created_at DESC, id
  `),
	);
	if (candidates.length > 1) {
		throw new Error("ambiguous target wallet identity");
	}
	const existing = candidates[0];
	if (existing) return existing;
	const [created] = await db
		.insert(polyTraderWallets)
		.values({
			walletAddress: targetWallet.toLowerCase(),
			kind: "copy_target",
			label: "Copy target",
			activeForResearch: true,
			disabledAt: null,
			updatedAt: observedAt,
		})
		.onConflictDoNothing({ target: polyTraderWallets.walletAddress })
		.returning({ id: polyTraderWallets.id });
	if (created) return created;
	const [raced] = await db
		.select({ id: polyTraderWallets.id })
		.from(polyTraderWallets)
		.where(eq(polyTraderWallets.walletAddress, targetWallet.toLowerCase()));
	if (!raced) throw new Error("target wallet identity unavailable");
	return raced;
}

function hashPositionFact(position: PolymarketUserPosition): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				conditionId: position.conditionId.toLowerCase(),
				asset: position.asset,
				size: position.size,
				avgPrice: position.avgPrice,
				initialValue: position.initialValue,
			}),
		)
		.digest("hex");
}

function positionCostUsdc(position: PolymarketUserPosition): number {
	return position.initialValue;
}

function classifyHydrationError(error: unknown): string {
	if (error && typeof error === "object") {
		const code = (error as { code?: unknown }).code;
		if (code === "VALIDATION_FAILED") return "validation_failed";
		if (code === "INVALID_V2_POSITIONS_WALK") return "invalid_walk";
	}
	return "upstream_or_persistence_error";
}

function normalizeRows<T>(result: unknown): T[] {
	if (Array.isArray(result)) return result as T[];
	const rows = (result as { rows?: unknown } | null)?.rows;
	return Array.isArray(rows) ? (rows as T[]) : [];
}

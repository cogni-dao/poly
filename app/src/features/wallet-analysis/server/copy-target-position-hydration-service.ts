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
 *   - LINEAGE_SCOPED: target enablement controls execution, never durable
 *     observability. Active or soft-disabled target rows remain eligible only
 *     while their tenant holds an exact condition+token produced by an
 *     authoritative realized copy-fill.
 *   - COMPLETE_COHORTS_ONLY: the provider must complete every cursor/chunk
 *     before any row for that target is persisted.
 *   - SCOPE_MATCHES_COMPLETENESS: V2 cohort publication preserves unrelated
 *     conditions; a complete Position-gap book may replace the whole wallet.
 *   - MONOTONIC_COMPLETE_BOOKS: an older complete Position-gap book cannot
 *     overwrite a newer complete book for the same target wallet.
 *   - NO_V1_FALLBACK: failures preserve the last saved facts and return an
 *     error count; they never widen to the capped legacy walk.
 * Side-effects: Data API V2 reads and Postgres writes through injected deps.
 */

import { createHash } from "node:crypto";
import {
	polyTraderCurrentPositions,
	polyTraderIngestionCursors,
	polyTraderPositionSnapshots,
	polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import type {
	LoggerPort,
	TargetBookSnapshotV1,
} from "@cogni/poly-market-provider";
import type {
	PolymarketDataApiClient,
	PolymarketUserPosition,
} from "@cogni/poly-market-provider/adapters/polymarket";
import { and, eq, type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { targetIdFromWallet } from "@/shared/util/poly-target-id";
import { liveCurrentPositionSql } from "./current-position-staleness";
import { COPY_TARGET_POSITION_CURSOR_SOURCE } from "./position-observation-sources";

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

export type PositionGapTargetSnapshotPublication = {
	applied: boolean;
	positions: number;
	snapshotId: string;
};

type PersistedTargetPosition = {
	conditionId: string;
	tokenId: string;
	shares: string;
	costBasisUsdc: string;
	currentValueUsdc: string;
	avgPrice: string;
	contentHash: string;
	raw: Record<string, unknown>;
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
    WITH observable_targets AS (
      -- Execution eligibility still lives in dbTargetSource.listAllActive.
      -- This read-side cohort intentionally includes soft-disabled target rows:
      -- the realized lineage join below prevents disable from erasing the
      -- target facts needed to explain holdings the algorithm already created.
      SELECT DISTINCT
        t.billing_account_id,
        lower(t.target_wallet) AS target_wallet,
        lower(c.funder_address) AS local_wallet
      FROM poly_copy_trade_targets t
      JOIN poly_wallet_connections c
        ON c.billing_account_id = t.billing_account_id
        -- Hydration reads REAL on-chain positions for local_wallet. A
        -- kind='paper' row's address is synthetic and has no chain presence,
        -- so without this filter a tenant holding both kinds would produce two
        -- cohorts per target, the second of which can only ever hydrate empty.
       AND c.kind = 'privy_live'
       AND c.revoked_at IS NULL
      JOIN poly_wallet_grants g
        ON g.wallet_connection_id = c.id
       AND g.revoked_at IS NULL
       AND (g.expires_at IS NULL OR g.expires_at > NOW())
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
    FROM observable_targets target
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

/**
 * Publish the exact complete target book already accepted by Position-gap.
 * This is a saved-fact projection only: it performs no upstream read and a
 * caller must never make execution depend on its success.
 */
export async function persistPositionGapTargetSnapshot(input: {
	db: Db;
	snapshot: TargetBookSnapshotV1;
}): Promise<PositionGapTargetSnapshotPublication> {
	const { snapshot } = input;
	if (
		snapshot.version !== 1 ||
		snapshot.complete !== true ||
		!/^0x[0-9a-f]{40}$/.test(snapshot.targetWallet) ||
		!Number.isFinite(snapshot.updatedAtMs) ||
		!Number.isSafeInteger(snapshot.refreshStats.sourceMaxSyncedBlock) ||
		snapshot.refreshStats.sourceMaxSyncedBlock <= 0
	) {
		throw new Error("invalid Position-gap target snapshot publication");
	}
	const observedAt = new Date(snapshot.updatedAtMs);
	if (!Number.isFinite(observedAt.getTime())) {
		throw new Error("invalid Position-gap target snapshot timestamp");
	}
	const positions: PersistedTargetPosition[] = [];
	for (const condition of snapshot.conditions) {
		if (!/^0x[0-9a-f]{64}$/.test(condition.conditionId)) {
			throw new Error("invalid Position-gap target condition identity");
		}
		for (const token of condition.tokens) {
			if (
				token.tokenId.length === 0 ||
				token.oppositeTokenId.length === 0 ||
				!Number.isFinite(token.shares) ||
				!Number.isFinite(token.averagePrice) ||
				!Number.isFinite(token.markPrice) ||
				token.shares < 0 ||
				token.averagePrice < 0 ||
				token.markPrice < 0
			) {
				throw new Error("invalid Position-gap target position fact");
			}
			if (token.shares === 0) continue;
			const costBasisUsdc = token.shares * token.averagePrice;
			const currentValueUsdc = token.shares * token.markPrice;
			if (
				!Number.isFinite(costBasisUsdc) ||
				!Number.isFinite(currentValueUsdc)
			) {
				throw new Error("invalid Position-gap target position economics");
			}
			const raw = {
				proxyWallet: snapshot.targetWallet,
				asset: token.tokenId,
				conditionId: condition.conditionId,
				size: token.shares,
				avgPrice: token.averagePrice,
				initialValue: costBasisUsdc,
				currentValue: currentValueUsdc,
				curPrice: token.markPrice,
				outcomeIndex: token.outcomeIndex,
				oppositeAsset: token.oppositeTokenId,
				endDate: condition.endDate,
				negativeRisk: condition.negativeRisk,
				positionGapTargetBook: {
					version: snapshot.version,
					snapshotId: snapshot.snapshotId,
					sourceComputedAt: snapshot.refreshStats.sourceComputedAt,
					sourceMaxSyncedBlock: snapshot.refreshStats.sourceMaxSyncedBlock,
				},
			};
			positions.push({
				conditionId: condition.conditionId,
				tokenId: token.tokenId,
				shares: token.shares.toFixed(8),
				costBasisUsdc: costBasisUsdc.toFixed(8),
				currentValueUsdc: currentValueUsdc.toFixed(8),
				avgPrice: token.averagePrice.toFixed(8),
				contentHash: hashPositionIdentity({
					conditionId: condition.conditionId,
					tokenId: token.tokenId,
					shares: token.shares,
					avgPrice: token.averagePrice,
					costBasisUsdc,
				}),
				raw,
			});
		}
	}
	const applied = await persistTargetPositionFacts({
		db: input.db,
		targetWallet: snapshot.targetWallet,
		positions,
		observedAt,
		scopeConditions: null,
		cursorNativeId: snapshot.snapshotId,
	});
	return {
		applied,
		positions: positions.length,
		snapshotId: snapshot.snapshotId,
	};
}

async function persistScopedTargetPositions(input: {
	db: Db;
	targetWallet: string;
	conditions: readonly string[];
	positions: readonly PolymarketUserPosition[];
}): Promise<void> {
	const observedAt = new Date();
	const positions: PersistedTargetPosition[] = input.positions.map(
		(position) => ({
			conditionId: position.conditionId.toLowerCase(),
			tokenId: position.asset,
			shares: position.size.toFixed(8),
			costBasisUsdc: positionCostUsdc(position).toFixed(8),
			currentValueUsdc: position.currentValue.toFixed(8),
			avgPrice: position.avgPrice.toFixed(8),
			contentHash: hashPositionFact(position),
			raw: position as unknown as Record<string, unknown>,
		}),
	);
	await persistTargetPositionFacts({
		db: input.db,
		targetWallet: input.targetWallet,
		positions,
		observedAt,
		scopeConditions: input.conditions,
		cursorNativeId: null,
	});
}

async function persistTargetPositionFacts(input: {
	db: Db;
	targetWallet: string;
	positions: readonly PersistedTargetPosition[];
	observedAt: Date;
	/** null means the producer proved a complete whole-wallet publication. */
	scopeConditions: readonly string[] | null;
	cursorNativeId: string | null;
}): Promise<boolean> {
	const observedAtIso = input.observedAt.toISOString();
	return (
		input.db as unknown as {
			transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
		}
	).transaction(async (tx) => {
		const wallet = await resolveTargetWallet(
			tx,
			input.targetWallet,
			input.observedAt,
		);
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${`poly:positions:${wallet.id}`}, 0))`,
		);
		if (input.cursorNativeId !== null) {
			const [existingCompleteCursor] = await tx
				.select({ lastSeenAt: polyTraderIngestionCursors.lastSeenAt })
				.from(polyTraderIngestionCursors)
				.where(
					and(
						eq(polyTraderIngestionCursors.traderWalletId, wallet.id),
						eq(
							polyTraderIngestionCursors.source,
							COPY_TARGET_POSITION_CURSOR_SOURCE,
						),
					),
				)
				.limit(1);
			if (
				existingCompleteCursor?.lastSeenAt &&
				existingCompleteCursor.lastSeenAt.getTime() >= input.observedAt.getTime()
			) {
				return false;
			}
		}
		const values = input.positions.map((position) => ({
			traderWalletId: wallet.id,
			...position,
			capturedAt: input.observedAt,
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
						lastObservedAt: input.observedAt,
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
						lastObservedAt: input.observedAt,
						raw: sql`excluded.raw`,
					},
					setWhere: sql`${polyTraderCurrentPositions.lastObservedAt} <= excluded.last_observed_at`,
				});
		}

		const observedKeys = JSON.stringify(
			values.map((value) => ({
				condition_id: value.conditionId,
				token_id: value.tokenId,
			})),
		);
		const scopePredicate =
			input.scopeConditions === null
				? sql`TRUE`
				: sql`EXISTS (
            SELECT 1
            FROM jsonb_to_recordset(${JSON.stringify(
							input.scopeConditions.map((conditionId) => ({
								condition_id: conditionId,
							})),
						)}::jsonb) AS requested(condition_id text)
            WHERE lower(requested.condition_id) = lower(p.condition_id)
          )`;
		await tx.execute(sql`
      UPDATE poly_trader_current_positions p
      SET active = false, last_observed_at = ${observedAtIso}::timestamptz
      WHERE p.trader_wallet_id = ${wallet.id}::uuid
        AND ${scopePredicate}
		AND p.last_observed_at <= ${observedAtIso}::timestamptz
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset(${observedKeys}::jsonb)
            AS observed(condition_id text, token_id text)
          WHERE lower(observed.condition_id) = lower(p.condition_id)
            AND observed.token_id = p.token_id
        )
    `);
		const cursorIdentity =
			input.cursorNativeId === null
				? {}
				: {
						lastSeenAt: input.observedAt,
						lastSeenNativeId: input.cursorNativeId,
					};
		await tx
			.insert(polyTraderIngestionCursors)
			.values({
				traderWalletId: wallet.id,
				source: COPY_TARGET_POSITION_CURSOR_SOURCE,
				...cursorIdentity,
				lastSuccessAt: input.observedAt,
				status: "ok",
				errorMessage: null,
				updatedAt: input.observedAt,
			})
			.onConflictDoUpdate({
				target: [
					polyTraderIngestionCursors.traderWalletId,
					polyTraderIngestionCursors.source,
				],
				set: {
					...cursorIdentity,
					lastSuccessAt: sql`GREATEST(${polyTraderIngestionCursors.lastSuccessAt}, excluded.last_success_at)`,
					status: "ok",
					errorMessage: null,
					updatedAt: sql`GREATEST(${polyTraderIngestionCursors.updatedAt}, excluded.updated_at)`,
				},
			});
		return true;
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
	return hashPositionIdentity({
		conditionId: position.conditionId.toLowerCase(),
		tokenId: position.asset,
		shares: position.size,
		avgPrice: position.avgPrice,
		costBasisUsdc: position.initialValue,
	});
}

function hashPositionIdentity(input: {
	conditionId: string;
	tokenId: string;
	shares: number;
	avgPrice: number;
	costBasisUsdc: number;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				conditionId: input.conditionId,
				asset: input.tokenId,
				size: input.shares,
				avgPrice: input.avgPrice,
				initialValue: input.costBasisUsdc,
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

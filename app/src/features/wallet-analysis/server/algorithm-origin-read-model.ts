// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Durable algorithm-origin projection for wallet economic positions.
 *
 * Positive executed fill rows prove origin even when the append-only decision
 * audit row is absent. Immutable planner input supplies target-at-decision;
 * the observer's current position is a separate, optional target-now fact.
 * One layer is retained per assignment + algorithm version + config. Within a
 * layer we select the latest complete cumulative snapshot and never add
 * snapshots together.
 *
 * PAGE_LOAD_DB_ONLY. SAVED_FACTS_ONLY. No vendor calls and no raw-row scan
 * crosses into V8. The response is bounded to 20 layers per supplied position.
 */
import type {
  WalletDashboardOriginCoverage,
  WalletExecutionCopyOrigin,
} from "@cogni/poly-node-contracts";
import { type SQL, sql } from "drizzle-orm";

type ExecuteDb = { execute(query: SQL): Promise<unknown> };

const ORIGIN_LAYER_LIMIT = 20;

type PositionKey = Readonly<{ conditionId: string; tokenId: string }>;

type OriginRow = {
  origin_position_count: string | number | null;
  origin_event_count: string | number | null;
  complete_event_count: string | number | null;
  legacy_partial_event_count: string | number | null;
  incomplete_event_count: string | number | null;
  identity_ambiguous_event_count: string | number | null;
  origin_layer_count: string | number | null;
  comparable_layer_count: string | number | null;
  preview_layer_count: string | number | null;
  preview_truncated: boolean | null;
  condition_id: string | null;
  token_id: string | null;
  algorithm_id: WalletExecutionCopyOrigin["algorithmId"] | null;
  algorithm_version_id: string | null;
  config_hash: string | null;
  input_snapshot_id: string | null;
  assignment_id: string | null;
  correlation_id: string | null;
  evidence: WalletExecutionCopyOrigin["evidence"] | null;
  target_wallet: string | null;
  first_executed_at: Date | string | null;
  last_executed_at: Date | string | null;
  executed_fill_count: string | number | null;
  decision_shares: string | number | null;
  decision_cost_usdc: string | number | null;
  decision_average_price: string | number | null;
  decision_observed_at: Date | string | null;
  now_shares: string | number | null;
  now_cost_usdc: string | number | null;
  now_current_value_usdc: string | number | null;
  now_average_price: string | number | null;
  now_observed_at: Date | string | null;
  now_identity_count: string | number | null;
  position_layer_count: string | number | null;
};

export type AlgorithmOriginRead = Readonly<{
  byPositionKey: ReadonlyMap<string, readonly WalletExecutionCopyOrigin[]>;
  layerCountByPositionKey: ReadonlyMap<string, number>;
  coverage: WalletDashboardOriginCoverage;
}>;

export async function readAlgorithmOriginProjection(params: {
  db: ExecuteDb;
  billingAccountId: string;
  connectionKind: "privy_live" | "paper";
  capturedAt: Date;
  previewPositionKeys: readonly PositionKey[];
}): Promise<AlgorithmOriginRead> {
  const mode = params.connectionKind === "paper" ? "paper" : "live";
  const uniquePreviewKeys = [
    ...new Map(
      params.previewPositionKeys.map((key) => [
        positionKey(key.conditionId, key.tokenId),
        {
          conditionId: canonicalIdentity(key.conditionId),
          tokenId: key.tokenId,
        },
      ])
    ).values(),
  ];
  const previewRelation =
    uniquePreviewKeys.length === 0
      ? sql`SELECT NULL::text AS condition_id, NULL::text AS token_id WHERE FALSE`
      : sql`VALUES ${sql.join(
          uniquePreviewKeys.map(
            (key) => sql`(${key.conditionId}, ${key.tokenId})`
          ),
          sql`, `
        )}`;

  const rows = normalizeRows<OriginRow>(await params.db.execute(sql`
    WITH preview_keys(condition_id, token_id) AS (
      ${previewRelation}
    ), executed_events AS MATERIALIZED (
      SELECT
        lower(NULLIF(COALESCE(
          NULLIF(f.attributes->>'condition_id', ''),
          NULLIF(regexp_replace(f.market_id, '^prediction-market:polymarket:', ''), '')
        ), '')) AS condition_id,
        NULLIF(f.attributes->>'token_id', '') AS token_id,
        f.algorithm_id,
        f.algorithm_version_id,
        f.config_hash,
        f.input_snapshot_id,
        f.assignment_id,
        f.correlation_id,
        f.attributes,
        f.observed_at,
        f.client_order_id,
        s.algorithm_id AS snapshot_algorithm_id,
        s.canonical_input,
        s.created_at AS snapshot_created_at
      FROM poly_copy_trade_fills f
      LEFT JOIN poly_algorithm_input_snapshots s
        ON s.billing_account_id = f.billing_account_id
       AND s.input_snapshot_id = f.input_snapshot_id
      WHERE f.billing_account_id = ${params.billingAccountId}
        AND f.mode = ${mode}
        AND f.observed_at <= ${params.capturedAt.toISOString()}::timestamptz
        AND f.order_id IS NOT NULL
        AND (
          COALESCE(f.shares, 0) > 0
          OR (
            COALESCE(f.attributes->>'filled_size_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            AND (f.attributes->>'filled_size_usdc')::numeric > 0
          )
          OR (
            f.status IN ('filled', 'partial')
            AND COALESCE(f.attributes->>'size_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            AND (f.attributes->>'size_usdc')::numeric > 0
          )
        )
    ), decoded AS MATERIALIZED (
      SELECT
        e.*,
        lower(NULLIF(COALESCE(
          e.canonical_input #>> '{fill,attributes,condition_id}',
          e.canonical_input #>> '{fill,attributes,conditionId}',
          regexp_replace(e.canonical_input #>> '{fill,market_id}', '^prediction-market:polymarket:', '')
        ), '')) AS input_fill_condition_id,
        NULLIF(COALESCE(
          e.canonical_input #>> '{fill,attributes,asset}',
          e.canonical_input #>> '{fill,attributes,token_id}',
          e.canonical_input #>> '{fill,attributes,tokenId}'
        ), '') AS input_fill_token_id,
        lower(NULLIF(e.canonical_input #>> '{state,target_position,condition_id}', ''))
          AS input_target_position_condition_id,
        lower(NULLIF(COALESCE(
          e.canonical_input #>> '{fill,target_wallet}',
          e.canonical_input #>> '{snapshot,targetWallet}',
          e.attributes->>'target_wallet'
        ), '')) AS target_wallet,
        fill_target.cost_usdc AS fill_target_cost_usdc,
        fill_target.size_shares AS fill_target_shares,
        fill_target.average_price AS fill_target_average_price,
        book_target.cost_usdc AS book_target_cost_usdc,
        book_target.shares AS book_target_shares,
        book_target.average_price AS book_target_average_price,
        book_target.observed_at AS book_target_observed_at,
        book_target.identity_match AS book_identity_match
      FROM executed_events e
      LEFT JOIN LATERAL (
        SELECT
          CASE WHEN COALESCE(token->>'cost_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (token->>'cost_usdc')::numeric END AS cost_usdc,
          CASE WHEN COALESCE(token->>'size_shares', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (token->>'size_shares')::numeric END AS size_shares,
          CASE
            WHEN COALESCE(token->>'cost_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$'
             AND COALESCE(token->>'size_shares', '') ~ '^[0-9]+(\\.[0-9]+)?$'
             AND (token->>'size_shares')::numeric > 0
            THEN (token->>'cost_usdc')::numeric / (token->>'size_shares')::numeric
          END AS average_price
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(e.canonical_input #> '{state,target_position,tokens}') = 'array'
              THEN e.canonical_input #> '{state,target_position,tokens}'
            ELSE '[]'::jsonb
          END
        ) token
        WHERE NULLIF(token->>'token_id', '') = e.token_id
          AND lower(NULLIF(e.canonical_input #>> '{state,target_position,condition_id}', ''))
            = e.condition_id
        ORDER BY token->>'token_id'
        LIMIT 1
      ) fill_target ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          CASE
            WHEN COALESCE(token->>'shares', '') ~ '^[0-9]+(\\.[0-9]+)?$'
             AND COALESCE(token->>'averagePrice', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (token->>'shares')::numeric * (token->>'averagePrice')::numeric
          END AS cost_usdc,
          CASE WHEN COALESCE(token->>'shares', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (token->>'shares')::numeric END AS shares,
          CASE WHEN COALESCE(token->>'averagePrice', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (token->>'averagePrice')::numeric END AS average_price,
          CASE WHEN COALESCE(e.canonical_input #>> '{snapshot,updatedAtMs}', '') ~ '^[0-9]+$'
            THEN to_timestamp((e.canonical_input #>> '{snapshot,updatedAtMs}')::numeric / 1000.0)
          END AS observed_at,
          lower(NULLIF(condition->>'conditionId', '')) = e.condition_id
            AND NULLIF(token->>'tokenId', '') = e.token_id AS identity_match
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(e.canonical_input #> '{snapshot,conditions}') = 'array'
              THEN e.canonical_input #> '{snapshot,conditions}'
            ELSE '[]'::jsonb
          END
        ) condition
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(condition->'tokens') = 'array'
            THEN condition->'tokens' ELSE '[]'::jsonb END
        ) token
        WHERE lower(NULLIF(condition->>'conditionId', '')) = e.condition_id
          AND NULLIF(token->>'tokenId', '') = e.token_id
        ORDER BY condition->>'conditionId', token->>'tokenId'
        LIMIT 1
      ) book_target ON TRUE
    ), classified_events AS MATERIALIZED (
      SELECT
        d.*,
        CASE
          WHEN d.condition_id IS NULL OR d.token_id IS NULL
            OR d.algorithm_id IS NULL OR d.algorithm_version_id IS NULL
            OR d.config_hash IS NULL OR d.input_snapshot_id IS NULL
            OR d.assignment_id IS NULL OR d.correlation_id IS NULL
            OR d.target_wallet IS NULL
            OR d.target_wallet !~ '^0x[a-f0-9]{40}$'
            THEN 'incomplete'
          WHEN d.canonical_input IS NOT NULL AND (
            d.snapshot_algorithm_id IS DISTINCT FROM d.algorithm_id
            OR NOT (
              (d.algorithm_id = 'poly.copy-mirror.position-gap' AND COALESCE(d.book_identity_match, false))
              OR (
                d.algorithm_id <> 'poly.copy-mirror.position-gap'
                AND d.input_fill_condition_id = d.condition_id
                AND d.input_fill_token_id = d.token_id
                AND (
                  d.input_target_position_condition_id IS NULL
                  OR d.input_target_position_condition_id = d.condition_id
                )
              )
            )
          ) THEN 'identity_ambiguous'
          WHEN d.canonical_input IS NOT NULL THEN 'complete'
          WHEN d.target_wallet ~ '^0x[a-f0-9]{40}$'
            AND COALESCE(d.attributes->>'target_token_cost_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN 'legacy_partial'
          ELSE 'incomplete'
        END AS evidence,
        COALESCE(
          CASE
            WHEN d.algorithm_id = 'poly.copy-mirror.position-gap'
              THEN d.book_target_cost_usdc
            ELSE COALESCE(
              d.fill_target_cost_usdc,
              CASE WHEN COALESCE(d.canonical_input #>> '{fill,size_usdc}', '') ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (d.canonical_input #>> '{fill,size_usdc}')::numeric END
            )
          END,
          CASE WHEN COALESCE(d.attributes->>'target_token_cost_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (d.attributes->>'target_token_cost_usdc')::numeric END
        ) AS decision_cost_usdc,
        COALESCE(CASE
          WHEN d.algorithm_id = 'poly.copy-mirror.position-gap'
            THEN d.book_target_shares
          ELSE COALESCE(
            d.fill_target_shares,
            CASE
              WHEN COALESCE(d.canonical_input #>> '{fill,size_usdc}', '') ~ '^[0-9]+(\\.[0-9]+)?$'
               AND COALESCE(d.canonical_input #>> '{fill,price}', '') ~ '^[0-9]+(\\.[0-9]+)?$'
               AND (d.canonical_input #>> '{fill,price}')::numeric > 0
              THEN (d.canonical_input #>> '{fill,size_usdc}')::numeric
                / (d.canonical_input #>> '{fill,price}')::numeric
            END
          )
        END,
          CASE
            WHEN COALESCE(d.attributes->>'target_token_cost_usdc', '') ~ '^[0-9]+(\\.[0-9]+)?$'
             AND COALESCE(d.attributes->>'limit_price', '') ~ '^[0-9]+(\\.[0-9]+)?$'
             AND (d.attributes->>'limit_price')::numeric > 0
            THEN (d.attributes->>'target_token_cost_usdc')::numeric
              / (d.attributes->>'limit_price')::numeric
          END
        ) AS decision_shares,
        COALESCE(CASE
          WHEN d.algorithm_id = 'poly.copy-mirror.position-gap'
            THEN d.book_target_average_price
          ELSE COALESCE(
            d.fill_target_average_price,
            CASE WHEN COALESCE(d.canonical_input #>> '{fill,price}', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (d.canonical_input #>> '{fill,price}')::numeric END
          )
        END,
          CASE WHEN COALESCE(d.attributes->>'limit_price', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (d.attributes->>'limit_price')::numeric END
        ) AS decision_average_price,
        CASE
          WHEN d.algorithm_id = 'poly.copy-mirror.position-gap'
            THEN d.book_target_observed_at
          WHEN COALESCE(d.canonical_input #>> '{fill,observed_at}', '') <> ''
            THEN (d.canonical_input #>> '{fill,observed_at}')::timestamptz
          ELSE d.snapshot_created_at
        END AS decision_observed_at
      FROM decoded d
    ), proven_events AS MATERIALIZED (
      SELECT * FROM classified_events
      WHERE evidence IN ('complete', 'legacy_partial')
        AND target_wallet ~ '^0x[a-f0-9]{40}$'
    ), layer_ranked AS MATERIALIZED (
      SELECT
        p.*,
        min(p.observed_at) OVER layer AS first_executed_at,
        max(p.observed_at) OVER layer AS last_executed_at,
        count(*) OVER layer AS executed_fill_count,
        row_number() OVER (
          PARTITION BY p.condition_id, p.token_id, p.assignment_id,
            p.algorithm_id, p.algorithm_version_id, p.config_hash
          ORDER BY CASE WHEN p.evidence = 'complete' THEN 0 ELSE 1 END,
            p.observed_at DESC, p.correlation_id DESC, p.input_snapshot_id DESC,
            p.client_order_id DESC
        ) AS selected_rank
      FROM proven_events p
      WINDOW layer AS (
        PARTITION BY p.condition_id, p.token_id, p.assignment_id,
          p.algorithm_id, p.algorithm_version_id, p.config_hash
      )
    ), selected_layers AS MATERIALIZED (
      SELECT * FROM layer_ranked WHERE selected_rank = 1
    ), layers_with_now AS MATERIALIZED (
      SELECT
        l.*,
        now_fact.shares AS now_shares,
        now_fact.cost_basis_usdc AS now_cost_usdc,
        now_fact.current_value_usdc AS now_current_value_usdc,
        now_fact.avg_price AS now_average_price,
        now_fact.last_observed_at AS now_observed_at,
        COALESCE(now_fact.identity_count, 0) AS now_identity_count,
        CASE
          WHEN l.decision_cost_usdc IS NULL OR l.decision_cost_usdc <= 0
            THEN 'target_at_decision_unavailable'
          WHEN COALESCE(now_fact.identity_count, 0) > 1
            THEN 'target_now_identity_ambiguous'
          WHEN now_fact.cost_basis_usdc IS NULL OR now_fact.cost_basis_usdc <= 0
            THEN 'target_now_unavailable'
          ELSE 'comparable'
        END AS comparison_status
      FROM selected_layers l
      LEFT JOIN LATERAL (
        SELECT
          candidate.shares,
          candidate.cost_basis_usdc,
          candidate.current_value_usdc,
          candidate.avg_price,
          candidate.last_observed_at,
          candidate.identity_count
        FROM (
          SELECT
            p.shares,
            p.cost_basis_usdc,
            p.current_value_usdc,
            p.avg_price,
            p.last_observed_at,
            count(*) OVER ()::int AS identity_count,
            row_number() OVER (
              ORDER BY p.last_observed_at DESC, w.updated_at DESC,
                w.created_at DESC, w.id, p.condition_id
            ) AS identity_rank
          FROM poly_trader_current_positions p
          JOIN poly_trader_wallets w ON w.id = p.trader_wallet_id
          WHERE lower(w.wallet_address) = l.target_wallet
            AND lower(p.condition_id) = l.condition_id
            AND p.token_id = l.token_id
            AND p.active = true
            AND p.shares > 0
            AND p.last_observed_at <= ${params.capturedAt.toISOString()}::timestamptz
        ) candidate
        WHERE candidate.identity_rank = 1
      ) now_fact ON TRUE
    ), preview_ranked AS MATERIALIZED (
      SELECT
        l.*,
        count(*) OVER (
          PARTITION BY l.condition_id, l.token_id
        )::int AS position_layer_count,
        row_number() OVER (
          PARTITION BY l.condition_id, l.token_id
          ORDER BY l.last_executed_at DESC, l.assignment_id,
            l.algorithm_id, l.algorithm_version_id, l.config_hash
        ) AS preview_rank
      FROM layers_with_now l
      JOIN preview_keys k USING (condition_id, token_id)
    ), preview AS MATERIALIZED (
      SELECT * FROM preview_ranked WHERE preview_rank <= ${ORIGIN_LAYER_LIMIT}
    ), coverage AS (
      SELECT
        (SELECT count(DISTINCT (condition_id, token_id)) FROM selected_layers)::int
          AS origin_position_count,
        count(*)::int AS origin_event_count,
        count(*) FILTER (WHERE evidence = 'complete')::int AS complete_event_count,
        count(*) FILTER (WHERE evidence = 'legacy_partial')::int AS legacy_partial_event_count,
        count(*) FILTER (WHERE evidence = 'incomplete')::int AS incomplete_event_count,
        count(*) FILTER (WHERE evidence = 'identity_ambiguous')::int
          AS identity_ambiguous_event_count,
        (SELECT count(*) FROM selected_layers)::int AS origin_layer_count,
        (SELECT count(*) FROM layers_with_now WHERE comparison_status = 'comparable')::int
          AS comparable_layer_count,
        (SELECT count(*) FROM preview)::int AS preview_layer_count,
        (SELECT count(*) FROM selected_layers) > (SELECT count(*) FROM preview)
          AS preview_truncated
      FROM classified_events
    )
    SELECT
      c.*,
      p.condition_id,
      p.token_id,
      p.algorithm_id,
      p.algorithm_version_id,
      p.config_hash,
      p.input_snapshot_id,
      p.assignment_id,
      p.correlation_id,
      p.evidence,
      p.target_wallet,
      p.first_executed_at,
      p.last_executed_at,
      p.executed_fill_count,
      p.decision_shares,
      p.decision_cost_usdc,
      p.decision_average_price,
      p.decision_observed_at,
      p.now_shares,
      p.now_cost_usdc,
      p.now_current_value_usdc,
      p.now_average_price,
      p.now_observed_at,
      p.now_identity_count,
      p.position_layer_count
    FROM coverage c
    LEFT JOIN preview p ON TRUE
    ORDER BY p.condition_id, p.token_id, p.preview_rank
  `));

  const first = rows[0];
  const mutable = new Map<string, WalletExecutionCopyOrigin[]>();
  const layerCountByPositionKey = new Map<string, number>();
  for (const row of rows) {
    const origin = toOrigin(row);
    if (
      origin === null ||
      row.condition_id === null ||
      row.token_id === null
    ) {
      continue;
    }
    const key = positionKey(row.condition_id, row.token_id);
    const bucket = mutable.get(key) ?? [];
    bucket.push(origin);
    mutable.set(key, bucket);
    layerCountByPositionKey.set(key, nonnegativeInt(row.position_layer_count));
  }
  return {
    byPositionKey: mutable,
    layerCountByPositionKey,
    coverage: {
      status: "available",
      originPositionCount: nonnegativeInt(first?.origin_position_count),
      originEventCount: nonnegativeInt(first?.origin_event_count),
      completeEventCount: nonnegativeInt(first?.complete_event_count),
      legacyPartialEventCount: nonnegativeInt(first?.legacy_partial_event_count),
      incompleteEventCount: nonnegativeInt(first?.incomplete_event_count),
      identityAmbiguousEventCount: nonnegativeInt(
        first?.identity_ambiguous_event_count
      ),
      originLayerCount: nonnegativeInt(first?.origin_layer_count),
      comparableLayerCount: nonnegativeInt(first?.comparable_layer_count),
      previewLayerCount: nonnegativeInt(first?.preview_layer_count),
      previewTruncated: first?.preview_truncated === true,
    },
  };
}

export function unavailableOriginCoverage(): WalletDashboardOriginCoverage {
  return {
    status: "unavailable",
    originPositionCount: null,
    originEventCount: null,
    completeEventCount: null,
    legacyPartialEventCount: null,
    incompleteEventCount: null,
    identityAmbiguousEventCount: null,
    originLayerCount: null,
    comparableLayerCount: null,
    previewLayerCount: null,
    previewTruncated: null,
  };
}

function toOrigin(row: OriginRow): WalletExecutionCopyOrigin | null {
  if (
    row.condition_id === null ||
    row.token_id === null ||
    row.algorithm_id === null ||
    row.algorithm_version_id === null ||
    row.config_hash === null ||
    row.input_snapshot_id === null ||
    row.assignment_id === null ||
    row.correlation_id === null ||
    row.evidence === null ||
    row.target_wallet === null
  ) {
    return null;
  }
  const firstExecutedAt = iso(row.first_executed_at);
  const lastExecutedAt = iso(row.last_executed_at);
  if (firstExecutedAt === null || lastExecutedAt === null) return null;
  const decisionCost = nullableNumber(row.decision_cost_usdc);
  const decisionShares = nullableNumber(row.decision_shares);
  const nowCost = nullableNumber(row.now_cost_usdc);
  const nowShares = nullableNumber(row.now_shares);
  const nowIdentityCount = nonnegativeInt(row.now_identity_count);
  const targetAtDecision =
    decisionCost === null && decisionShares === null
      ? null
      : {
          walletAddress: row.target_wallet as `0x${string}`,
          conditionId: row.condition_id,
          tokenId: row.token_id,
          shares: decisionShares,
          costBasisUsdc: decisionCost,
          currentValueUsdc: null,
          averagePrice: nullableNumber(row.decision_average_price),
          observedAt: iso(row.decision_observed_at),
        };
  const targetNow =
    nowIdentityCount === 1 && (nowCost !== null || nowShares !== null)
      ? {
          walletAddress: row.target_wallet as `0x${string}`,
          conditionId: row.condition_id,
          tokenId: row.token_id,
          shares: nowShares,
          costBasisUsdc: nowCost,
          currentValueUsdc: nullableNumber(row.now_current_value_usdc),
          averagePrice: nullableNumber(row.now_average_price),
          observedAt: iso(row.now_observed_at),
        }
      : null;
  const comparisonStatus: WalletExecutionCopyOrigin["comparisonStatus"] =
    targetAtDecision?.costBasisUsdc == null
      ? "target_at_decision_unavailable"
      : nowIdentityCount > 1
        ? "target_now_identity_ambiguous"
        : targetNow?.costBasisUsdc == null
          ? "target_now_unavailable"
          : "comparable";
  return {
    layerId: [
      row.assignment_id,
      row.algorithm_id,
      row.algorithm_version_id,
      row.config_hash,
    ].join(":"),
    algorithmId: row.algorithm_id,
    algorithmVersionId: row.algorithm_version_id,
    configHash: row.config_hash,
    inputSnapshotId: row.input_snapshot_id,
    assignmentId: row.assignment_id,
    correlationId: row.correlation_id,
    evidence: row.evidence,
    targetWalletAddress: row.target_wallet as `0x${string}`,
    firstExecutedAt,
    lastExecutedAt,
    executedFillCount: Math.max(1, nonnegativeInt(row.executed_fill_count)),
    targetAtDecision,
    targetNow,
    comparisonStatus,
  };
}

export function positionKey(conditionId: string, tokenId: string): string {
  return `${canonicalIdentity(conditionId)}\u0000${tokenId}`;
}

function canonicalIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function nullableNumber(
  value: string | number | null | undefined
): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function nonnegativeInt(value: string | number | null | undefined): number {
  const number = value === null || value === undefined ? 0 : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

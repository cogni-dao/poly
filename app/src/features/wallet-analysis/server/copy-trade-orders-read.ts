// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/copy-trade-orders-read`
 * Purpose: The grant-aware replacement read behind `GET /api/v1/poly/copy-trade/orders`.
 *   One bounded `SELECT` over `poly_copy_trade_fills` on the dispatcher's
 *   app-role tenant transaction, plus the `toContractRow` mapping moved here
 *   from the route so the route keeps zero queries of its own.
 * Scope: One query + one pure mapper. No authorization, no HTTP, no container.
 * Invariants:
 *   - NEVER_EXTEND_THE_FROZEN_LEDGER — `features/trading/order-ledger.types.ts`
 *     and `features/trading/index.ts` are port-frozen `exact`/P1, and
 *     `LEDGER_PORT_SHAPE_IS_STABLE` makes adding a field a breaking change.
 *     `TenantOrderLedger` has no read-list method at all, and its
 *     `forTenant(ctx)` envelope keys RLS on `created_by_user_id` — write-shaped
 *     principal semantics, wrong for a delegated read. So this is a NEW module
 *     rather than a ledger extension. Nothing here imports the ledger port.
 *   - RLS_IS_THE_CLAMP_NOW — the old route read through
 *     `container.orderLedger.listRecent`, which runs on the BYPASSRLS service
 *     connection where the route's `WHERE billing_account_id` was the ONLY
 *     thing preventing a cross-tenant leak (its own header said so). This
 *     module runs on the app-role tenant transaction the executor opens, so the
 *     `poly_copy_trade_fills_select` policy from migration 0074 is a real second
 *     line of defence. The explicit `eq(billingAccountId)` below is retained as
 *     defence in depth, NOT as the sole clamp.
 *   - STATUS_FILTERED_IN_SQL — the old route applied `status` in JS AFTER the
 *     SQL `LIMIT`, so a page could come back short or empty while more matching
 *     rows existed. The predicate is pushed into the query here.
 *   - HARD_PAGE_BOUND — the limit is clamped to `ORDERS_MAX_PAGE` in this
 *     module, independent of whatever the caller asked for.
 *   - ACCOUNT_IS_EXPLICIT — the authorized account arrives as the handler's
 *     third argument and is never re-derived here. One source of truth for
 *     which tenant the read describes. This module briefly did re-derive it
 *     from `app.current_user_id` while the seam was still `(tx, input)`; that
 *     was wrong twice over — two sources that could drift, and an
 *     ownership-based lookup resolves a DELEGATED agent to its own empty
 *     account (every approved agent owns one via `/agent/register`), which
 *     then passes `authorize()` as `owner` and returns a 200 for the wrong
 *     tenant. The seam now resolves by reachability instead.
 *   - NO_FABRICATED_VALUES — an absent attribute is `null`, never `0`.
 *   - CANONICAL_MARKET_IDENTITY — the bounded ledger page resolves the bare
 *     condition id through `poly_market_metadata`; saved metadata wins over
 *     legacy display attributes without adding an upstream render call.
 * Side-effects: IO (one SELECT).
 * Links: task.1791070959, story.5004, docs/spec/capability-plane.md
 * @public
 */

import { polyCopyTradeFills } from "@cogni/poly-db-schema/copy-trade";
import {
  polyMarketMetadata,
  polyTraderCurrentPositions,
} from "@cogni/poly-db-schema/trader-activity";
import type {
  PolyCopyTradeOrderRow,
  PolyCopyTradeOrdersInput,
  PolyCopyTradeOrdersOutput,
} from "@cogni/poly-node-contracts";
import { and, eq, sql } from "drizzle-orm";

import type { AgentGrantTransaction } from "@/features/agent-grants/authorization";

/**
 * Hard ceiling on one page, enforced here rather than at the transport. The
 * frozen orders contract already caps `limit` at 200; this makes the bound a
 * property of the query instead of a property of the validator.
 */
export const ORDERS_MAX_PAGE = 200;
export const ORDERS_DEFAULT_PAGE = 50;

/** The exact column set the contract row needs. Nothing wider is selected. */
type OrdersRow = {
  targetId: string;
  fillId: string;
  clientOrderId: string;
  orderId: string | null;
  status: string;
  marketId: string;
  observedAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  syncedAt: Date | string | null;
  mode: string;
  shares: string | number;
  attributes: Record<string, unknown> | null;
  metadataMarketTitle: string | null;
};

const rowsOf = <T>(result: unknown): T[] =>
  Array.isArray(result)
    ? (result as T[])
    : (((result as { rows?: T[] }).rows ?? []) as T[]);

const dateOf = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

/**
 * Only ledger-owned cancellation codes may cross the public read boundary.
 * `attributes.reason` is JSONB and predates the typed ledger seam, so validate
 * it here instead of trusting an arbitrary historical string.
 */
const LEDGER_CANCEL_REASONS = new Set([
  "target_exited_market",
  "ttl_expired",
  "stale_resting_layer_up",
  "position_gap_reconciled",
  "position_gap_runtime_safety",
  "multi_target_position_gap_unsupported",
]);

function publicAttemptReason(
  status: string,
  attrs: Record<string, unknown>,
): string | null {
  if (status === "error") {
    return typeof attrs.error === "string" ? attrs.error : null;
  }
  if (status !== "canceled" || typeof attrs.reason !== "string") return null;
  return LEDGER_CANCEL_REASONS.has(attrs.reason) ? attrs.reason : null;
}

function humanMarketTitle(value: string | null): string | null {
  const title = value?.trim();
  return title && title !== "0" && title !== "1" ? title : null;
}

/**
 * Map one ledger row to the frozen contract row.
 *
 * Moved from `copy-trade/orders/route.ts:43-87` so the route remains a pure
 * transport. The frozen
 * `poly.copy-trade.orders.v1.contract` is unchanged — this mapper produces
 * exactly the same 22 fields it already produced, including the dormant
 * `polymarket_profile_url: null`.
 */
export function toContractRow(
  row: OrdersRow,
  now: number,
): PolyCopyTradeOrderRow {
  const attrs = row.attributes ?? {};
  const readStr = (key: string): string | null =>
    typeof attrs[key] === "string" ? (attrs[key] as string) : null;
  const readNum = (key: string): number | null =>
    typeof attrs[key] === "number" ? (attrs[key] as number) : null;
  const positionGapV3 = readStr("position_gap_version") === "3";
  const realizedFillSource = readStr("realized_fill_source");
  const verifiedPositionGapFill =
    positionGapV3 &&
    (realizedFillSource === "clob_associated_trades" ||
      realizedFillSource === "data_api_activity_position");
  const realizedShares = Number(row.shares);
  const realizedNotional = readNum("filled_size_usdc");
  const fillAccounting = positionGapV3
    ? verifiedPositionGapFill &&
      Number.isFinite(realizedShares) &&
      realizedShares > 0 &&
      realizedNotional !== null &&
      realizedNotional > 0
      ? {
          status: "verified" as const,
          source: realizedFillSource as
            | "clob_associated_trades"
            | "data_api_activity_position",
          matched_order_count: 1,
          realized_shares: realizedShares,
          realized_entry_notional_usdc: realizedNotional,
        }
      : {
          status: "pending" as const,
          source: "clob_order_receipt" as const,
        }
    : null;

  const sideRaw = readStr("side");
  const side: PolyCopyTradeOrderRow["side"] =
    sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : null;

  // Dormant post-Stage-4 purge: this used to link to the single-operator
  // wallet's trade page. The per-tenant replacement lands with the Money-page
  // rework. Kept explicitly null rather than omitted — the contract requires
  // the key and NO_FABRICATED_VALUES forbids inventing a URL.
  const polymarketProfileUrl: string | null = null;

  const syncedAt = row.syncedAt === null ? null : dateOf(row.syncedAt);

  return {
    target_id: row.targetId,
    target_wallet: readStr("target_wallet"),
    fill_id: row.fillId,
    client_order_id: row.clientOrderId,
    order_id: row.orderId,
    status: row.status,
    // Promoted to a real column in task.5001; the attribute remains the
    // fallback for rows written before that backfill.
    market_id: row.marketId || readStr("market_id"),
    market_title:
      humanMarketTitle(row.metadataMarketTitle) ??
      humanMarketTitle(readStr("title")),
    market_tx_hash: readStr("transaction_hash"),
    outcome: readStr("outcome"),
    side,
    size_usdc: readNum("size_usdc"),
    limit_price: readNum("limit_price"),
    filled_size_usdc:
      !positionGapV3 || fillAccounting?.status === "verified"
        ? realizedNotional
        : null,
    fill_accounting: fillAccounting,
    // The frozen field name is `error`, but the card column is "Reason". For
    // canceled rows expose the bounded ledger cancellation code; error rows
    // retain the venue error text.
    error: publicAttemptReason(row.status, attrs),
    observed_at: dateOf(row.observedAt).toISOString(),
    created_at: dateOf(row.createdAt).toISOString(),
    updated_at: dateOf(row.updatedAt).toISOString(),
    polymarket_profile_url: polymarketProfileUrl,
    synced_at: syncedAt?.toISOString() ?? null,
    // Derived server-side so every client agrees on staleness.
    staleness_ms: syncedAt !== null ? now - syncedAt.getTime() : null,
    mode: row.mode,
  } as PolyCopyTradeOrderRow;
}

/**
 * One bounded page of the authorized account's recent mirror orders.
 *
 * `accountId` is the third handler argument: the account the executor ALREADY
 * resolved and authorized. The handler does not re-derive it, so there is
 * exactly one source of truth for which tenant this read describes.
 *
 * That matters more than it looks. This operation is `accountFrom: "principal"`
 * — forced, because the frozen `poly.copy-trade.orders.v1` input schema cannot
 * carry a `billing_account_id`. An ownership-based resolution would be wrong:
 * `POST /api/v1/agent/register` calls `getOrCreateBillingAccountForUser`, so
 * every approved agent OWNS an account, and a delegated agent would resolve to
 * its own empty one and then pass `authorize()` as `accessKind: "owner"` — a
 * 200 describing the wrong tenant. The seam's `resolveSubjectAccountId`
 * resolves by REACHABILITY for the required scope instead (live grants ∪
 * owned), so an agent that can reach two accounts gets a loud `invalid_input`
 * telling it to name one, and an agent that can reach none is denied.
 *
 * An account with no orders yet returns `{ orders: [] }` — a real answer, not a
 * not-found. Nothing here can create a billing account.
 */
export async function listCopyTradeOrdersForAccount(
  tx: AgentGrantTransaction,
  query: PolyCopyTradeOrdersInput,
  accountId: string,
): Promise<PolyCopyTradeOrdersOutput | null> {
  const billingAccountId = accountId;

  const limit = Math.min(query.limit ?? ORDERS_DEFAULT_PAGE, ORDERS_MAX_PAGE);

  // Every predicate is in SQL. `status` in particular MUST NOT be filtered
  // after the limit — that was the old route's bug.
  const predicates = [
    eq(polyCopyTradeFills.billingAccountId, billingAccountId),
    ...(query.target_id !== undefined
      ? [eq(polyCopyTradeFills.targetId, query.target_id)]
      : []),
    ...(query.status !== undefined && query.status !== "all"
      ? [eq(polyCopyTradeFills.status, query.status)]
      : []),
  ];

  const rows = rowsOf<OrdersRow>(
    await tx.execute(sql`
      WITH ordered_fills AS MATERIALIZED (
        SELECT
          ${polyCopyTradeFills.targetId} AS target_id,
          ${polyCopyTradeFills.fillId} AS fill_id,
          ${polyCopyTradeFills.clientOrderId} AS client_order_id,
          ${polyCopyTradeFills.orderId} AS order_id,
          ${polyCopyTradeFills.status} AS status,
          ${polyCopyTradeFills.marketId} AS market_id,
          ${polyCopyTradeFills.observedAt} AS observed_at,
          ${polyCopyTradeFills.createdAt} AS created_at,
          ${polyCopyTradeFills.updatedAt} AS updated_at,
          ${polyCopyTradeFills.syncedAt} AS synced_at,
          ${polyCopyTradeFills.mode} AS mode,
          ${polyCopyTradeFills.shares} AS shares,
          ${polyCopyTradeFills.attributes} AS attributes
        FROM ${polyCopyTradeFills}
        WHERE ${and(...predicates)}
        ORDER BY
          ${polyCopyTradeFills.observedAt} DESC,
          ${polyCopyTradeFills.targetId} DESC,
          ${polyCopyTradeFills.fillId} DESC
        LIMIT ${limit}
      )
      SELECT
        f.target_id AS "targetId",
        f.fill_id AS "fillId",
        f.client_order_id AS "clientOrderId",
        f.order_id AS "orderId",
        f.status AS "status",
        f.market_id AS "marketId",
        f.observed_at AS "observedAt",
        f.created_at AS "createdAt",
        f.updated_at AS "updatedAt",
        f.synced_at AS "syncedAt",
        f.mode AS "mode",
        f.shares AS "shares",
        f.attributes AS "attributes",
        COALESCE(metadata.market_title, position.market_title)
          AS "metadataMarketTitle"
      FROM ordered_fills f
      LEFT JOIN LATERAL (
        SELECT NULLIF(candidate.market_title, '') AS market_title
        FROM ${polyMarketMetadata} candidate
        WHERE lower(candidate.condition_id) = lower(COALESCE(
          NULLIF(f.attributes->>'condition_id', ''),
          NULLIF(regexp_replace(
            f.market_id,
            '^prediction-market:polymarket:',
            ''
          ), '')
        ))
        ORDER BY candidate.fetched_at DESC, candidate.condition_id
        LIMIT 1
      ) metadata ON TRUE
      -- Position-gap snapshots intentionally carry structural identity only.
      -- When the metadata projector has not materialized this condition yet,
      -- recover the same persisted Data-API title from the bounded current-
      -- position read model. Token identity and the already-bounded ledger page
      -- constrain each lookup; no upstream request occurs on dashboard render.
      LEFT JOIN LATERAL (
        SELECT NULLIF(candidate.raw->>'title', '') AS market_title
        FROM ${polyTraderCurrentPositions} candidate
        WHERE lower(candidate.condition_id) = lower(COALESCE(
          NULLIF(f.attributes->>'condition_id', ''),
          NULLIF(regexp_replace(
            f.market_id,
            '^prediction-market:polymarket:',
            ''
          ), '')
        ))
          AND candidate.token_id = NULLIF(f.attributes->>'token_id', '')
          AND NULLIF(candidate.raw->>'title', '') IS NOT NULL
        ORDER BY candidate.active DESC, candidate.last_observed_at DESC
        LIMIT 1
      ) position ON metadata.market_title IS NULL
      ORDER BY f.observed_at DESC, f.target_id DESC, f.fill_id DESC
    `),
  );

  // One clock read for the whole page so two rows in the same response cannot
  // report staleness against different "now"s.
  const now = Date.now();
  return { orders: rows.map((row) => toContractRow(row, now)) };
}

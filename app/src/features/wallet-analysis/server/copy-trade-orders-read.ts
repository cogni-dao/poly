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
 *   - NO_FABRICATED_VALUES — an absent attribute is `null`, never `0`.
 * Side-effects: IO (one SELECT).
 * Links: task.1791070959, story.5004, docs/spec/capability-plane.md
 * @public
 */

import { billingAccounts } from "@cogni/db-schema";
import { polyCopyTradeFills } from "@cogni/poly-db-schema/copy-trade";
import type {
  PolyCopyTradeOrderRow,
  PolyCopyTradeOrdersInput,
  PolyCopyTradeOrdersOutput,
} from "@cogni/poly-node-contracts";
import { and, desc, eq, sql } from "drizzle-orm";

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
  observedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  syncedAt: Date | null;
  mode: string;
  attributes: Record<string, unknown> | null;
};

/**
 * Map one ledger row to the frozen contract row.
 *
 * Moved verbatim-in-behaviour from `copy-trade/orders/route.ts:43-87` so the
 * route becomes a pure transport. The frozen
 * `poly.copy-trade.orders.v1.contract` is unchanged — this mapper produces
 * exactly the same 22 fields it already produced, including the dormant
 * `polymarket_profile_url: null`.
 */
export function toContractRow(
  row: OrdersRow,
  now: number
): PolyCopyTradeOrderRow {
  const attrs = row.attributes ?? {};
  const readStr = (key: string): string | null =>
    typeof attrs[key] === "string" ? (attrs[key] as string) : null;
  const readNum = (key: string): number | null =>
    typeof attrs[key] === "number" ? (attrs[key] as number) : null;

  const sideRaw = readStr("side");
  const side: PolyCopyTradeOrderRow["side"] =
    sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : null;

  // Dormant post-Stage-4 purge: this used to link to the single-operator
  // wallet's trade page. The per-tenant replacement lands with the Money-page
  // rework. Kept explicitly null rather than omitted — the contract requires
  // the key and NO_FABRICATED_VALUES forbids inventing a URL.
  const polymarketProfileUrl: string | null = null;

  const syncedAt = row.syncedAt ?? null;

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
    market_title: readStr("title"),
    market_tx_hash: readStr("transaction_hash"),
    outcome: readStr("outcome"),
    side,
    size_usdc: readNum("size_usdc"),
    limit_price: readNum("limit_price"),
    filled_size_usdc: readNum("filled_size_usdc"),
    error: readStr("error"),
    observed_at: row.observedAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    polymarket_profile_url: polymarketProfileUrl,
    synced_at: syncedAt?.toISOString() ?? null,
    // Derived server-side so every client agrees on staleness.
    staleness_ms: syncedAt !== null ? now - syncedAt.getTime() : null,
    mode: row.mode,
  } as PolyCopyTradeOrderRow;
}

/**
 * Resolve the billing account OWNED by the principal on this transaction.
 *
 * Why this exists: the capability seam's `AccountReadHandler` signature is
 * `(tx, input)`, and the frozen orders contract has no `billing_account_id`
 * input field, so the handler cannot be handed the account id the executor
 * already authorized. Relying on RLS alone would be WRONG here — the
 * `poly_copy_trade_fills_select` policy admits the principal's own account AND
 * every account they hold a grant on, so a delegate would receive two tenants'
 * rows interleaved in one response under a descriptor whose authorization was
 * evaluated against only one of them.
 *
 * So the account is re-derived from `app.current_user_id` — the same session
 * variable `withTenantScope` set and the same predicate
 * `resolvePrincipalAccountId` uses. This is SCOPING, not a second authorization
 * decision: the executor has already allowed the read, and this cannot widen
 * the row set beyond what RLS permits, only narrow it to the one authorized
 * account. It is a plain SELECT and never creates an account.
 */
async function resolveOwnedAccountId(
  tx: AgentGrantTransaction
): Promise<string | null> {
  const rows = await tx
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(
      sql`${billingAccounts.ownerUserId} = current_setting('app.current_user_id', true)`
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * One bounded page of the account's recent mirror orders.
 *
 * Returns `null` when the principal owns no billing account, which the executor
 * renders as a non-disclosing 404 — notably WITHOUT creating one, unlike the
 * `resolveBillingAccountId` call this replaces. An account with no orders yet
 * legitimately returns `{ orders: [] }`: a real answer, not a not-found.
 */
export async function listCopyTradeOrdersForAccount(
  tx: AgentGrantTransaction,
  query: PolyCopyTradeOrdersInput
): Promise<PolyCopyTradeOrdersOutput | null> {
  const billingAccountId = await resolveOwnedAccountId(tx);
  if (!billingAccountId) return null;

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

  const rows = await tx
    .select({
      targetId: polyCopyTradeFills.targetId,
      fillId: polyCopyTradeFills.fillId,
      clientOrderId: polyCopyTradeFills.clientOrderId,
      orderId: polyCopyTradeFills.orderId,
      status: polyCopyTradeFills.status,
      marketId: polyCopyTradeFills.marketId,
      observedAt: polyCopyTradeFills.observedAt,
      createdAt: polyCopyTradeFills.createdAt,
      updatedAt: polyCopyTradeFills.updatedAt,
      syncedAt: polyCopyTradeFills.syncedAt,
      mode: polyCopyTradeFills.mode,
      attributes: polyCopyTradeFills.attributes,
    })
    .from(polyCopyTradeFills)
    .where(and(...predicates))
    .orderBy(
      desc(polyCopyTradeFills.observedAt),
      desc(polyCopyTradeFills.targetId),
      desc(polyCopyTradeFills.fillId)
    )
    .limit(limit);

  // One clock read for the whole page so two rows in the same response cannot
  // report staleness against different "now"s.
  const now = Date.now();
  return { orders: rows.map((row) => toContractRow(row as OrdersRow, now)) };
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/copy-trade/orders`
 * Purpose: HTTP GET — recent order-ledger rows for the calling principal's
 *   account. AGENT-FIRST INVERSION (task.1791070959): this route now holds ZERO
 *   queries and ZERO authorization of its own and is a thin client of the
 *   capability plane, exactly like every other actor.
 * Scope: Transport binding only.
 * Invariants:
 *   - NO_PRIVILEGED_TRANSPORT — the route no longer resolves a tenant, no
 *     longer touches the container, and no longer maps rows. It forwards the
 *     session principal and renders the outcome.
 *   - SERVICE_ROLE_PATTERN_RETIRED — the previous implementation read through
 *     `container.orderLedger.listRecent`, which runs on the BYPASSRLS service
 *     connection; its own header stated that omitting the route's clamp
 *     "leaks rows across tenants", making this route the ONLY enforcement
 *     point. The read now runs inside the executor's app-role tenant
 *     transaction, where the `poly_copy_trade_fills_select` policy from
 *     migration 0074 is a genuine second line of defence. The route-clamp
 *     pattern is gone.
 *   - NO_LAZY_ACCOUNT_CREATION — the previous implementation called
 *     `resolveBillingAccountId`, which lazily CREATES a billing account on
 *     miss, so an agent bearer with no account silently received a fresh empty
 *     tenant instead of a denial. The plane resolves the account with a plain
 *     SELECT and returns a non-disclosing 404 on miss. No GET creates an
 *     account.
 *   - STATUS_FILTERED_IN_SQL — `status` used to be filtered in JS AFTER the SQL
 *     LIMIT, so a page could come back short or empty while more matching rows
 *     existed. It is now a SQL predicate (see `copy-trade-orders-read`).
 *   - ONE_TERMINAL_EVENT — emitted solely by `executeAccountRead`.
 * Notes: the response contract (`poly.copy-trade.orders.v1`) is a port-frozen
 *   `exact`/P1 entry and is UNCHANGED — same 22 fields, same ordering. Because
 *   that frozen input schema has no `billing_account_id`, this operation is
 *   necessarily `accountFrom: "principal"` and therefore cannot be aimed at a
 *   delegated account; `poly.account.recent-attempts.v1` is the delegable and
 *   strictly more informative successor.
 * Links: task.1791070959, story.5004, docs/spec/capability-plane.md
 * @public
 */

import { polyAccountReadCopyTradeOrdersOperation } from "@cogni/poly-node-contracts";
import { getSessionUser } from "@/app/_lib/auth/session";
import { accountReadGetHandler } from "@/app/_lib/capability-plane/account-read-route";
import { resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  ACCOUNT_READ_TERMINAL_EVENTS,
  copyTradeOrdersAccountReadHandler,
  copyTradeOrdersExtra,
} from "@/features/capability-plane";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    // Loki routeId preserved so existing dashboards and alerts keep working.
    routeId: "poly.copy_trade.orders",
    auth: { mode: "required", getSessionUser },
  },
  accountReadGetHandler({
    resolveDb: resolveAppDb,
    operation: polyAccountReadCopyTradeOrdersOperation,
    eventName:
      ACCOUNT_READ_TERMINAL_EVENTS[polyAccountReadCopyTradeOrdersOperation.id],
    handler: copyTradeOrdersAccountReadHandler,
    extra: copyTradeOrdersExtra,
  })
);

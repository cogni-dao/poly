// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/research/copy-trade-pnl/route`
 * Purpose: HTTP GET for the per-tenant copy-trade execution rollup that powers
 *   the trust-twin diff. Compares preview paper vs PROD live PnL on the same
 *   target wallet config.
 * Scope: Transport binding only. This module declares which capability it
 *   publishes and nothing else — authorization, the app-role tenant
 *   transaction, read-only isolation, output validation, and the single
 *   terminal event all live in the capability plane.
 * Invariants:
 *   - CAPABILITY_DEFINED_ONCE — shape, scope, method and path come from
 *     `polyAccountReadCopyTradePnlOperation`.
 *   - ROUTE_IS_TRANSPORT_ONLY — zero queries, zero authorization, zero logging
 *     here. Human sessions and machine bearers reach the same executor with the
 *     same principal contract.
 *   - CAPABILITY_GATED — every denial returns the same non-disclosing 404.
 *   - SQL_AGGREGATION_ONLY / PAGE_LOAD_DB_ONLY — unchanged; the aggregate is
 *     still one GROUP BY in the (frozen) feature service, now additionally
 *     running at REPEATABLE READ READ ONLY.
 * Side-effects: IO (DB reads via the capability plane).
 * Links: packages/poly-node-contracts/src/poly.capability-plane.v1.contract.ts
 * @public
 */

import { polyAccountReadCopyTradePnlOperation } from "@cogni/poly-node-contracts";
import { getSessionUser } from "@/app/_lib/auth/session";
import { accountReadGetHandler } from "@/app/_lib/capability-plane/account-read-route";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  ACCOUNT_READ_TERMINAL_EVENTS,
  copyTradePnlAccountReadHandler,
  copyTradePnlExtra,
} from "@/features/capability-plane";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.research-copy-trade-pnl",
    auth: { mode: "required", getSessionUser },
  },
  accountReadGetHandler({
    operation: polyAccountReadCopyTradePnlOperation,
    eventName:
      ACCOUNT_READ_TERMINAL_EVENTS[polyAccountReadCopyTradePnlOperation.id],
    handler: copyTradePnlAccountReadHandler,
    extra: copyTradePnlExtra,
  })
);

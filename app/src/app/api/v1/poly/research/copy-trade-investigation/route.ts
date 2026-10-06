// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Bounded saved-facts snapshot for one authorized account/condition pair.
 *
 * Transport binding only — owner sessions and delegated bearer principals share
 * the one capability-plane executor, which owns authorization, the app-role
 * tenant transaction, REPEATABLE READ READ ONLY isolation, output validation,
 * and the single terminal event.
 */

import { polyAccountReadCopyTradeInvestigationOperation } from "@cogni/poly-node-contracts";
import { getSessionUser } from "@/app/_lib/auth/session";
import { accountReadGetHandler } from "@/app/_lib/capability-plane/account-read-route";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  ACCOUNT_READ_TERMINAL_EVENTS,
  copyTradeInvestigationAccountReadHandler,
  copyTradeInvestigationExtra,
} from "@/features/capability-plane";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.research-copy-trade-investigation",
    auth: { mode: "required", getSessionUser },
  },
  accountReadGetHandler({
    operation: polyAccountReadCopyTradeInvestigationOperation,
    eventName:
      ACCOUNT_READ_TERMINAL_EVENTS[
        polyAccountReadCopyTradeInvestigationOperation.id
      ],
    handler: copyTradeInvestigationAccountReadHandler,
    extra: copyTradeInvestigationExtra,
  })
);

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Cursor-paginated saved fill/decision evidence for a frozen investigation
 * snapshot.
 *
 * Transport binding only. An unparseable cursor or `captured_at` is classified
 * as caller input by the capability plane and still returns 400; everything
 * else — authorization, isolation, output validation, the single terminal
 * event — lives in the executor.
 */

import { polyAccountReadCopyTradeInvestigationEvidenceOperation } from "@cogni/poly-node-contracts";
import { getSessionUser } from "@/app/_lib/auth/session";
import { accountReadGetHandler } from "@/app/_lib/capability-plane/account-read-route";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  ACCOUNT_READ_TERMINAL_EVENTS,
  classifyInvestigationEvidenceError,
  copyTradeInvestigationEvidenceAccountReadHandler,
  copyTradeInvestigationEvidenceExtra,
} from "@/features/capability-plane";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.research-copy-trade-investigation-evidence",
    auth: { mode: "required", getSessionUser },
  },
  accountReadGetHandler({
    operation: polyAccountReadCopyTradeInvestigationEvidenceOperation,
    eventName:
      ACCOUNT_READ_TERMINAL_EVENTS[
        polyAccountReadCopyTradeInvestigationEvidenceOperation.id
      ],
    handler: copyTradeInvestigationEvidenceAccountReadHandler,
    classifyError: classifyInvestigationEvidenceError,
    extra: copyTradeInvestigationEvidenceExtra,
  })
);

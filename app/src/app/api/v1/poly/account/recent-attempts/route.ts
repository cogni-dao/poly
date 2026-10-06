// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Frozen, cursor-paginated, account-wide tape of recent copy-trade mirror
 * ATTEMPTS — including every `skipped` decision and its reason, which the
 * fills-backed dashboard card cannot see at all.
 *
 * Transport binding only. An unparseable cursor or a future `captured_at` is
 * classified as caller input by the plane and returns 400; everything else —
 * authorization, isolation, output validation, the single terminal event —
 * lives in the executor.
 */

import { polyAccountReadRecentAttemptsOperation } from "@cogni/poly-node-contracts";
import { getSessionUser } from "@/app/_lib/auth/session";
import { accountReadGetHandler } from "@/app/_lib/capability-plane/account-read-route";
import { resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  ACCOUNT_READ_TERMINAL_EVENTS,
  classifyRecentAttemptsError,
  recentAttemptsAccountReadHandler,
  recentAttemptsExtra,
} from "@/features/capability-plane";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.account.recent_attempts",
    auth: { mode: "required", getSessionUser },
  },
  accountReadGetHandler({
    resolveDb: resolveAppDb,
    operation: polyAccountReadRecentAttemptsOperation,
    eventName:
      ACCOUNT_READ_TERMINAL_EVENTS[polyAccountReadRecentAttemptsOperation.id],
    handler: recentAttemptsAccountReadHandler,
    classifyError: classifyRecentAttemptsError,
    extra: recentAttemptsExtra,
  })
);

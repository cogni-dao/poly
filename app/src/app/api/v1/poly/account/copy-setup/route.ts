// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Current copy-trade setup for one authorized account: tracked targets, the
 * effective sizing policy per target, and the active wallet safety caps.
 *
 * Transport binding only — zero queries and zero authorization of its own.
 * Authorization, the app-role tenant transaction, read-only isolation, output
 * validation, and the single terminal event all live in the capability plane.
 */

import { polyAccountReadCopySetupOperation } from "@cogni/poly-node-contracts";
import { getSessionUser } from "@/app/_lib/auth/session";
import { accountReadGetHandler } from "@/app/_lib/capability-plane/account-read-route";
import { resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  ACCOUNT_READ_TERMINAL_EVENTS,
  copySetupAccountReadHandler,
  copySetupExtra,
} from "@/features/capability-plane";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.account.copy_setup",
    auth: { mode: "required", getSessionUser },
  },
  accountReadGetHandler({
    resolveDb: resolveAppDb,
    operation: polyAccountReadCopySetupOperation,
    eventName:
      ACCOUNT_READ_TERMINAL_EVENTS[polyAccountReadCopySetupOperation.id],
    handler: copySetupAccountReadHandler,
    extra: copySetupExtra,
  })
);

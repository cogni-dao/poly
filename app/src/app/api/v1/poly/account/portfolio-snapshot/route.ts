// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/account/portfolio-snapshot/route`
 * Purpose: Agent transport for `poly.account.portfolio-snapshot.v1` — the
 *   delegable, discoverable read of one account's coherent portfolio snapshot.
 *   This is the capability whose absence caused an agent to fabricate a wallet
 *   balance in production: there was no delegated read that returned one.
 * Scope: Transport binding only — one descriptor, one handler, nothing else.
 *   Zero queries, zero authorization, zero logging of its own.
 * Invariants:
 *   - ACCOUNT_ON_THE_WIRE — `billing_account_id` is required input and
 *     `authorize()` decides. An approved agent reads the OWNER's account;
 *     an agent with no grant gets the same non-disclosing 404 as one naming a
 *     nonexistent account, so it cannot probe which accounts exist.
 *   - SAME_FACTS_AS_THE_OWNER — binds the identical handler the owner-session
 *     dashboard route binds, so parity is structural rather than asserted.
 *   - NO_WRITE_AUTHORITY — `account:read` is a read scope. `actionsAllowed`
 *     and the connection mutation handles that appear nowhere in this payload
 *     are owner-UI affordances; nothing here implies an agent may act.
 * Side-effects: IO (DB reads via the capability plane).
 * Links: docs/spec/capability-plane.md, docs/spec/dashboard-agent-parity-inventory.md,
 *   story.5004, task.1791070962
 * @public
 */

import { polyAccountReadPortfolioSnapshotOperation } from "@cogni/poly-node-contracts";
import { getSessionUser } from "@/app/_lib/auth/session";
import { accountReadGetHandler } from "@/app/_lib/capability-plane/account-read-route";
import { resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { isPolyTraderWalletConfigured } from "@/bootstrap/poly-trader-wallet";
import {
  ACCOUNT_READ_TERMINAL_EVENTS,
  portfolioSnapshotAccountReadHandler,
  portfolioSnapshotExtra,
} from "@/features/capability-plane";
import { serverEnv } from "@/shared/env/server-env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.account.portfolio-snapshot",
    auth: { mode: "required", getSessionUser },
  },
  accountReadGetHandler({
    resolveDb: resolveAppDb,
    operation: polyAccountReadPortfolioSnapshotOperation,
    eventName:
      ACCOUNT_READ_TERMINAL_EVENTS[
        polyAccountReadPortfolioSnapshotOperation.id
      ],
    // Resolved per request, not at module load: the deployment flag and the
    // build sha are read when the handler runs.
    handler: (tx, input, accountId) =>
      portfolioSnapshotAccountReadHandler({
        adapterConfigured: isPolyTraderWalletConfigured(),
      })(tx, input, accountId),
    extra: (context) =>
      portfolioSnapshotExtra(context, serverEnv().APP_BUILD_SHA ?? "unknown"),
  })
);

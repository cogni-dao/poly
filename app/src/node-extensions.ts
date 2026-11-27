// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@/node-extensions`
 * Purpose: Poly's ONE node composition root for the shared identity plane (https://node-template.cognidao.org/knowledge/node-plugin-architecture): what Poly adds to
 *   the baseline of `@cogni/agent-grants`, declared through `@cogni/extension-kit` and read by `bootstrap/agent-authority.ts`.
 * Scope: Declarations only (data, no code at run time). One route-only capability: Poly's agent-reachable quant and copy-trade reads. They carry the
 *   shared `account:read` grant ("Read your account data", kind `account`): the account owner approves it on `/profile`, and the delegated SELECT policies
 *   (migration 0093) call the same `agent_has_scope()` the package uses.
 * Invariants:
 *   - DECLARE_NEVER_BUILD: Poly declares no scope of its own and no grant table. `account:read` is the baseline scope; its `requires` is imported from the
 *     released `core__account_credits_read` contract, never retyped (SCOPE_DECLARED_ONCE: a retyped copy would drift from the shared label).
 *   - NODE_OWNS_ITS_PREFIX: Poly's own ids start with `poly.` (capability ids) or `poly__` (tool ids). The capability id below follows the rule.
 *   - ROUTE_IDS_ARE_REAL: every listed route id is the `routeId` of a Poly account-read route file (a unit test reads the files).
 *   - A narrower grant, if one is ever needed, is a `poly.`-prefixed route-only scope declared here through `routeOnlyCapabilities`. It is NOT built.
 * Side-effects: none
 * Links: story.0090, task.0205, https://node-template.cognidao.org/knowledge/grant-account-outside-ai
 * @public
 */

import { defineNodeExtensions } from "@cogni/extension-kit";
import { accountCreditsReadContract } from "@cogni/shared-ai-tools";

/** The `routeId` of every Poly route that serves an account's data under `account:read` (the published account-read operations). */
export const POLY_ACCOUNT_READ_ROUTE_IDS = [
  "poly.research-copy-trade-pnl",
  "poly.research-copy-trade-investigation",
  "poly.research-copy-trade-investigation-evidence",
  "poly.account.copy_setup",
  "poly.account.recent_attempts",
  "poly.copy_trade.orders",
  "poly.account.portfolio-snapshot",
  "poly.account.target_positions",
] as const;

const ACCOUNT_READ_REQUIRES = accountCreditsReadContract.requires;
if (!ACCOUNT_READ_REQUIRES || ACCOUNT_READ_REQUIRES.scope !== "account:read") {
  // Fail loudly: a release that moved the baseline declaration must break the build, never degrade to an undeclared scope.
  throw new Error("node-extensions: core__account_credits_read no longer declares the account:read scope");
}

/** The one capability id Poly adds. */
export const POLY_ACCOUNT_READ_CAPABILITY = "poly.account_read" as const;

export const nodeExtensions = defineNodeExtensions({
  routes: {
    routeOnlyCapabilities: {
      [POLY_ACCOUNT_READ_CAPABILITY]: {
        requires: ACCOUNT_READ_REQUIRES,
        routes: POLY_ACCOUNT_READ_ROUTE_IDS,
      },
    },
  },
});

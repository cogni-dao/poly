// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/ai/permission-tools`
 * Purpose: Every tool contract this node can run, as one list. The permission catalog (`agent-permissions.ts`) derives the grantable
 *   scopes from it, so a scope a tool declares is a scope `/admin/ai-access` can turn On and Off. There is no scope table.
 * Scope: Composition only. Adds no tool and no scope: a contract that declares no `requires` contributes nothing.
 * Invariants: DECLARED_ONCE_SHOWN_EVERYWHERE. The list is the bound core bundle, the principal-scoped account tools and the shared
 *   schedule tools the cogni run adds (`graph-executor.factory.ts`).
 * Side-effects: none
 * Links: src/bootstrap/agent-permissions.ts, https://cognidao.org/knowledge/node-capability-grants-standard
 * @internal
 */

import { POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME } from "@cogni/poly-graphs";
import { scheduleListContract, scheduleManageContract } from "@cogni/shared-ai-tools";

import type { PermissionBoundTool } from "../agent-permissions";
import { POLY_CORE_TOOL_BUNDLE } from "./evaluation-baseline";
import { PRINCIPAL_TOOL_BUNDLE } from "./principal-tool-source";

/**
 * Poly's delegated account read (`account:read`, kind account): an owner lets an outside AI read the trading data on their account. The
 * graphs' local contract type cannot carry `requires`, so Poly declares it here, once, for its account-read tool. Poly's capability plane
 * decides each read with `authorize()` over the same `agent_roles` account rows.
 */
const POLY_ACCOUNT_READ: PermissionBoundTool = {
  contract: {
    name: POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME,
    requires: {
      scope: "account:read",
      kind: "account",
      subject: "member",
      label: "Read your trading data",
      description: "See your copy-trade orders, fills and portfolio.",
    },
  },
};

export const POLY_PERMISSION_TOOLS: readonly PermissionBoundTool[] = [
  ...POLY_CORE_TOOL_BUNDLE,
  ...PRINCIPAL_TOOL_BUNDLE,
  { contract: scheduleListContract },
  { contract: scheduleManageContract },
  POLY_ACCOUNT_READ,
];

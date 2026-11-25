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

import { scheduleListContract, scheduleManageContract } from "@cogni/shared-ai-tools";

import type { PermissionBoundTool } from "../agent-permissions";
import { POLY_CORE_TOOL_BUNDLE } from "./evaluation-baseline";
import { PRINCIPAL_TOOL_BUNDLE } from "./principal-tool-source";

export const POLY_PERMISSION_TOOLS: readonly PermissionBoundTool[] = [
  ...POLY_CORE_TOOL_BUNDLE,
  ...PRINCIPAL_TOOL_BUNDLE,
  { contract: scheduleListContract },
  { contract: scheduleManageContract },
];

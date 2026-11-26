// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/run-attribution`
 * Purpose: This node's one binding of `@cogni/work-items` `createRunAttribution`: the run scope it reads and the logger it writes to.
 * Scope: Composition only. The builders (`actingPrincipal`, `routeAttribution`, `runAttribution`, `attributionFields`) live in the package.
 * Side-effects: none at import
 * @internal
 */

import { createRunAttribution } from "@cogni/work-items";
import { getExecutionScope } from "@/adapters/server/ai/execution-scope";
import { makeLogger } from "@/shared/observability";

/** The attribution of a write made by a graph tool: the current run scope's principal, subject and run. */
export const runAttribution = createRunAttribution({
  scope: getExecutionScope,
  log: makeLogger({ component: "write-attribution" }),
});

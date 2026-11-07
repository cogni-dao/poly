// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-schema/metric-observations`
 * Purpose: Operational goal-metric evidence tables, defined once in the published @cogni-dao/metrics package.
 * Scope: Re-export only. Migrations and pool ownership stay node-local.
 * Invariants: Never redefine these tables here; the package owns their shape.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/work/items/story.0021
 * @public
 */
export {
  metricObservations,
  metricRefreshCursors,
} from "@cogni-dao/metrics/schema";

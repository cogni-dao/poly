// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema`
 * Purpose: Root barrel re-exporting all schema slices for consumers that need the full schema.
 * Scope: Re-exports only. Does not define any tables.
 * Invariants: Must re-export every slice so the resulting namespace matches src/shared/db/schema.ts.
 * Side-effects: none
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/packages-architecture.md, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/database-rls.md
 * @public
 */

export * from "./ai";
export * from "./ai-threads";
export * from "./agent-access-requests";
export * from "./agent-capability-grants";
export * from "./attribution";
export * from "./auth";
export * from "./billing";
export * from "./connections";
export * from "./copy-trade";
export * from "./position-gap";
export * from "./identity";
export * from "./poly-redeem-jobs";
export * from "./profile";
export * from "./refs";
export * from "./scheduling";
export * from "./trader-activity";
export * from "./wallet-connections";
export * from "./wallet-grants";
// Goal-metric evidence tables are defined once in @cogni-dao/metrics; migrations stay node-local.
export {
  metricObservations,
  metricRefreshCursors,
} from "@cogni-dao/metrics/schema";

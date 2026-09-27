// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/wallet`
 * Purpose: Factory for WalletCapability — serves the Top Wallets leaderboard
 *          from the `poly_top_wallet_stats` read model.
 * Scope: Creates WalletCapability over an injected DB handle. Does not call
 *        Polymarket — the upstream leaderboard + /trades fan-out lives in the
 *        top-wallet-stats job (bug.5017). Does not hold private keys or place
 *        trades.
 * Invariants:
 *   - PAGE_LOAD_DB_ONLY (bug.5017): `listTopTraders` is a single SELECT
 *     against `poly_top_wallet_stats`. No Polymarket client is importable
 *     from this module's graph.
 *   - COLD_START_EMPTY: before the first job tick populates the table, the
 *     capability returns an empty scoreboard (`traders: []`, `totalCount: 0`)
 *     — it never falls back to upstream on the render path.
 *   - READ_ONLY: No order placement path touched from this capability.
 *   - CAPABILITY_NOT_POLICY: Raw scoreboard only; ranking policy lives in
 *     tool consumers.
 * Side-effects: none (factory only; returned closures do DB reads)
 * Links: ../../features/wallet-analysis/server/top-wallet-stats-service.ts,
 *        ../jobs/top-wallet-stats.job.ts, work/items/bug.5017
 * @internal
 */

import type { WalletCapability } from "@cogni/poly-ai-tools";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { readTopTradersFromDb } from "@/features/wallet-analysis/server/top-wallet-stats-service";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

/** Default scoreboard size when the caller does not pass a limit. */
const DEFAULT_TOP_N = 10;

/**
 * Create a WalletCapability backed by the `poly_top_wallet_stats` read model.
 * The top-wallet-stats job (every 15 min) is the only Polymarket caller;
 * this capability performs a single bounded SELECT per request.
 */
export function createWalletCapability(deps: { db: Db }): WalletCapability {
  return {
    listTopTraders: async (params) =>
      readTopTradersFromDb(deps.db, {
        timePeriod: params.timePeriod,
        orderBy: params.orderBy ?? "PNL",
        limit: params.limit ?? DEFAULT_TOP_N,
      }),
  };
}

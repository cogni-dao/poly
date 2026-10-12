// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/redeem/drizzle-market-outcomes`
 * Purpose: Drizzle/Postgres implementation of `MarketOutcomesPort`. Backs
 *   `poly_market_outcomes` (existing table; previously unpopulated). Idempotent
 *   UPSERT keyed on `(condition_id, token_id)`.
 * Scope: Persistence only.
 * Invariants:
 *   - UPSERT_IS_IDEMPOTENT — re-receiving the same chain log produces the
 *     same row state.
 *   - TERMINAL_FACTS_ARE_MONOTONE — lowercase identity is canonical; once a
 *     winner/loser tuple exists, conflicting/unknown writes cannot rewrite it.
 * Side-effects: IO (database writes).
 * Links: docs/spec/poly-copy-trade-execution.md, bug.5008
 * @public
 */

import { sql } from "drizzle-orm";

import type { Database } from "@/adapters/server/db/client";
import type { MarketOutcomesPort, MarketOutcomeUpsertInput } from "@/ports";
import { polyMarketOutcomes } from "@/shared/db";

export class DrizzleMarketOutcomesAdapter implements MarketOutcomesPort {
  constructor(private readonly db: Database) {}

  async upsert(input: MarketOutcomeUpsertInput): Promise<void> {
    await this.db
      .insert(polyMarketOutcomes)
      .values({
        conditionId: input.conditionId.toLowerCase(),
        tokenId: input.tokenId,
        outcome: input.outcome,
        payout: input.payout,
        resolvedAt:
          input.resolvedAt ??
          (input.outcome === "winner" || input.outcome === "loser"
            ? new Date()
            : null),
        raw: input.raw,
      })
      .onConflictDoUpdate({
        target: [polyMarketOutcomes.conditionId, polyMarketOutcomes.tokenId],
        set: {
          outcome: sql`CASE
            WHEN ${polyMarketOutcomes.outcome} IN ('winner', 'loser')
              THEN ${polyMarketOutcomes.outcome}
            ELSE EXCLUDED.outcome
          END`,
          payout: sql`CASE
            WHEN ${polyMarketOutcomes.outcome} IN ('winner', 'loser')
              AND ${polyMarketOutcomes.outcome} <> EXCLUDED.outcome
              THEN ${polyMarketOutcomes.payout}
            ELSE COALESCE(${polyMarketOutcomes.payout}, EXCLUDED.payout)
          END`,
          resolvedAt: sql`CASE
            WHEN ${polyMarketOutcomes.outcome} IN ('winner', 'loser')
              AND ${polyMarketOutcomes.outcome} <> EXCLUDED.outcome
              THEN ${polyMarketOutcomes.resolvedAt}
            WHEN ${polyMarketOutcomes.outcome} IN ('winner', 'loser')
              THEN COALESCE(${polyMarketOutcomes.resolvedAt}, EXCLUDED.resolved_at, now())
            WHEN EXCLUDED.outcome IN ('winner', 'loser')
              THEN COALESCE(EXCLUDED.resolved_at, now())
            ELSE ${polyMarketOutcomes.resolvedAt}
          END`,
          raw: sql`CASE
            WHEN ${polyMarketOutcomes.outcome} IN ('winner', 'loser')
              THEN ${polyMarketOutcomes.raw}
            ELSE EXCLUDED.raw
          END`,
          updatedAt: sql`now()`,
        },
      });
  }
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real-Postgres proof that terminal outcome tuples never regress or split. */
import { polyMarketOutcomes } from "@cogni/poly-db-schema/trader-activity";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DrizzleMarketOutcomesAdapter } from "@/adapters/server/redeem/drizzle-market-outcomes.adapter";

const CONDITION = "0xabcdef5034";
const CONFLICT_TOKEN = "503401";
const ENRICH_TOKEN = "503402";
const FIRST_RESOLUTION = new Date("2026-10-10T10:00:00.000Z");
const LATER_RESOLUTION = new Date("2026-10-11T10:00:00.000Z");

describe("market outcome terminal monotonicity", () => {
  const db = getSeedDb();
  const adapter = new DrizzleMarketOutcomesAdapter(db as never);

  beforeAll(async () => {
    await db.insert(polyMarketOutcomes).values([
      {
        conditionId: CONDITION,
        tokenId: CONFLICT_TOKEN,
        outcome: "winner",
        payout: "1",
        resolvedAt: FIRST_RESOLUTION,
        raw: { observation: "first-terminal" },
      },
      {
        conditionId: CONDITION,
        tokenId: ENRICH_TOKEN,
        outcome: "winner",
        payout: null,
        resolvedAt: null,
        raw: { observation: "first-terminal-with-gaps" },
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(polyMarketOutcomes).where(eq(polyMarketOutcomes.conditionId, CONDITION));
  });

  it("preserves the whole existing tuple on a conflicting terminal write", async () => {
    await adapter.upsert({
      conditionId: "0xABCDEF5034",
      tokenId: CONFLICT_TOKEN,
      outcome: "loser",
      payout: "0",
      resolvedAt: LATER_RESOLUTION,
      raw: { observation: "conflicting-terminal" },
    });

    const rows = await db
      .select()
      .from(polyMarketOutcomes)
      .where(and(
        eq(polyMarketOutcomes.conditionId, CONDITION),
        eq(polyMarketOutcomes.tokenId, CONFLICT_TOKEN)
      ));
    expect(rows[0]).toMatchObject({
      conditionId: CONDITION,
      outcome: "winner",
      payout: "1.00000000",
      resolvedAt: FIRST_RESOLUTION,
      raw: { observation: "first-terminal" },
    });
  });

  it("same-terminal writes fill null facts without rewriting stable raw evidence", async () => {
    await adapter.upsert({
      conditionId: "0xABCDEF5034",
      tokenId: ENRICH_TOKEN,
      outcome: "winner",
      payout: "1",
      resolvedAt: LATER_RESOLUTION,
      raw: { observation: "later-terminal" },
    });

    const rows = await db
      .select()
      .from(polyMarketOutcomes)
      .where(and(
        eq(polyMarketOutcomes.conditionId, CONDITION),
        eq(polyMarketOutcomes.tokenId, ENRICH_TOKEN)
      ));
    expect(rows[0]).toMatchObject({
      conditionId: CONDITION,
      outcome: "winner",
      payout: "1.00000000",
      resolvedAt: LATER_RESOLUTION,
      raw: { observation: "first-terminal-with-gaps" },
    });
  });
});

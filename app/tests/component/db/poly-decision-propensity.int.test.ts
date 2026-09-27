// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/db/poly-decision-propensity.int.test`
 * Purpose: Prove migration 0064 against a REAL Postgres — the t1 exploration columns exist, round-trip, and their CHECK constraints actually reject malformed exploration metadata. A unit test cannot prove any of this; only the database can.
 * Scope: `poly_copy_trade_decisions.{exploration_arm,propensity}` + the three CHECKs. Does NOT test the planner or the pipeline.
 * Invariants proven:
 *   - MIGRATION_0064_APPLIED — selecting the columns succeeds against the migrated DB, so the column exists in deployed SQL and not only in TS.
 *   - PROPENSITY_PAIRED_WITH_ARM — arm-without-propensity and propensity-without-arm are BOTH rejected at the DB, so no estimator can ever read a half-written pair.
 *   - PROPENSITY_RANGE — 0 (divides by zero in IPS) and >1 (not a probability) are rejected.
 *   - DETERMINISTIC_ROWS_STILL_WRITE — a pre-t1 shaped row (both NULL) is still accepted, so the migration is backward compatible.
 * Side-effects: IO (testcontainers Postgres)
 * Notes: Uses typed drizzle inserts/selects throughout — no raw SQL — so the
 *        assertions do not depend on driver-specific result shapes.
 * Links: app/src/adapters/server/db/migrations/0064_eminent_living_tribunal.sql, packages/db-schema/src/copy-trade.ts
 * @public
 */

import { randomUUID } from "node:crypto";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  billingAccounts,
  polyCopyTradeDecisions,
  users,
} from "@/shared/db/schema";

const TARGET_ID = randomUUID();
let billingAccountId: string;
let userId: string;

/**
 * Insert one decision row. `arm` / `propensity` are passed through verbatim so
 * a deliberately malformed pair reaches the DB and the CHECK is what rejects it
 * (not a TS guard, which would make this test prove nothing).
 */
function insertDecision(over: {
  arm?: "greedy" | "explore" | null;
  propensity?: string | null;
  fillId?: string;
}) {
  return getSeedDb()
    .insert(polyCopyTradeDecisions)
    .values({
      billingAccountId,
      createdByUserId: userId,
      targetId: TARGET_ID,
      fillId: over.fillId ?? `data-api:${randomUUID()}:x:BUY:1`,
      outcome: "skipped",
      reason: "below_target_percentile",
      intent: {},
      receipt: null,
      decidedAt: new Date(),
      mode: "paper",
      explorationArm: over.arm ?? null,
      propensity: over.propensity ?? null,
    });
}

describe("poly_copy_trade_decisions exploration columns (migration 0064)", () => {
  beforeAll(async () => {
    const seedDb = getSeedDb();
    userId = randomUUID();
    billingAccountId = randomUUID();
    await seedDb
      .insert(users)
      .values({ id: userId, name: "t1 propensity test", walletAddress: null });
    await seedDb.insert(billingAccounts).values({
      id: billingAccountId,
      ownerUserId: userId,
      balanceCredits: 0n,
    });
  });

  it("MIGRATION_0064_APPLIED — the columns are selectable on the live schema", async () => {
    // If 0064 did not apply, Postgres raises `column ... does not exist` here.
    const rows = await getSeedDb()
      .select({
        arm: polyCopyTradeDecisions.explorationArm,
        propensity: polyCopyTradeDecisions.propensity,
      })
      .from(polyCopyTradeDecisions)
      .limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it.each([
    ["explore", "0.10000000", 0.1],
    ["greedy", "0.90000000", 0.9],
  ] as const)("round-trips the %s arm with its propensity", async (
    arm,
    stored,
    expected
  ) => {
    const fillId = `data-api:${randomUUID()}:${arm}:BUY:1`;
    await insertDecision({ arm, propensity: stored, fillId });
    const rows = await getSeedDb()
      .select({
        arm: polyCopyTradeDecisions.explorationArm,
        propensity: polyCopyTradeDecisions.propensity,
      })
      .from(polyCopyTradeDecisions)
      .where(eq(polyCopyTradeDecisions.fillId, fillId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.arm).toBe(arm);
    expect(Number(rows[0]?.propensity)).toBeCloseTo(expected, 8);
  });

  it("DETERMINISTIC_ROWS_STILL_WRITE — both NULL is accepted (backward compatible)", async () => {
    await expect(insertDecision({})).resolves.toBeDefined();
  });

  it("accepts propensity exactly 1 — a degenerate but valid greedy policy", async () => {
    await expect(
      insertDecision({ arm: "greedy", propensity: "1" })
    ).resolves.toBeDefined();
  });

  describe("the CHECKs actually reject bad exploration metadata", () => {
    it("PROPENSITY_PAIRED_WITH_ARM — arm with no propensity", async () => {
      await expect(insertDecision({ arm: "explore" })).rejects.toThrow();
    });

    it("PROPENSITY_PAIRED_WITH_ARM — propensity with no arm", async () => {
      await expect(insertDecision({ propensity: "0.5" })).rejects.toThrow();
    });

    it("PROPENSITY_RANGE — 0 would divide by zero in IPS", async () => {
      await expect(
        insertDecision({ arm: "explore", propensity: "0" })
      ).rejects.toThrow();
    });

    it("PROPENSITY_RANGE — >1 is not a probability", async () => {
      // numeric(9,8) holds values < 10, so 1.5 exercises the CHECK not overflow.
      await expect(
        insertDecision({ arm: "greedy", propensity: "1.5" })
      ).rejects.toThrow();
    });

    it("rejects an unrecognized arm label", async () => {
      await expect(
        insertDecision({
          arm: "exploit" as unknown as "greedy",
          propensity: "0.5",
        })
      ).rejects.toThrow();
    });
  });
});

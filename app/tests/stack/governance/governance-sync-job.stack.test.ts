// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/governance/governance-sync-job.stack`
 * Purpose: End-to-end test for governance schedule sync job.
 * Scope: Verifies job runs, creates grant, writes no ledger schedule, never touches the operator's flat or node-scoped ledger schedules, and is idempotent. Does not test concurrent lock behavior (requires parallel processes).
 * Invariants: SINGLE_WRITER (via advisory lock), GRANT_VIA_PORT (no raw SQL), IDEMPOTENT (safe to re-run)
 * Side-effects: IO
 * Links: src/bootstrap/jobs/syncGovernanceSchedules.job.ts
 * @public
 */

import { executionGrants } from "@cogni/db-schema";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import {
  getTestTemporalClient,
  getTestTemporalConfig,
} from "@tests/_fixtures/temporal/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TemporalScheduleControlAdapter } from "@/adapters/server/temporal/schedule-control.adapter";
import { runGovernanceSchedulesSyncJob } from "@/bootstrap/jobs/syncGovernanceSchedules.job";
import { getNodeId } from "@/shared/config";

describe("Governance Schedule Sync Job (Stack)", () => {
  const createdScheduleIds: string[] = [];
  let adapter: TemporalScheduleControlAdapter;

  beforeEach(async () => {
    // Initialize adapter
    adapter = new TemporalScheduleControlAdapter(getTestTemporalConfig());

    // Clean up any existing governance schedules from previous runs
    const client = await getTestTemporalClient();
    for await (const summary of client.schedule.list()) {
      if (summary.scheduleId.startsWith("governance:")) {
        try {
          await client.schedule.getHandle(summary.scheduleId).delete();
        } catch {
          // Schedule may have running execution or already deleted
        }
      }
    }

    // Clean up any existing grants
    const db = getSeedDb();
    await db
      .delete(executionGrants)
      .where(eq(executionGrants.userId, COGNI_SYSTEM_PRINCIPAL_USER_ID));
  });

  afterEach(async () => {
    // Clean up created schedules
    const client = await getTestTemporalClient();
    for (const scheduleId of createdScheduleIds) {
      try {
        await client.schedule.getHandle(scheduleId).delete();
      } catch {
        // Schedule may have been deleted already
      }
    }
    createdScheduleIds.length = 0;

    // Clean up grants
    const db = getSeedDb();
    await db
      .delete(executionGrants)
      .where(eq(executionGrants.userId, COGNI_SYSTEM_PRINCIPAL_USER_ID));
  });

  /** Governance schedule ids currently in Temporal. */
  async function listGovernanceIds(): Promise<string[]> {
    const client = await getTestTemporalClient();
    const ids: string[] = [];
    for await (const summary of client.schedule.list()) {
      if (summary.scheduleId.startsWith("governance:")) {
        ids.push(summary.scheduleId);
      }
    }
    return ids;
  }

  it("creates the governance grant and writes no ledger schedule (operator-owned)", async () => {
    await runGovernanceSchedulesSyncJob();

    const db = getSeedDb();
    const grants = await db
      .select()
      .from(executionGrants)
      .where(eq(executionGrants.userId, COGNI_SYSTEM_PRINCIPAL_USER_ID));

    expect(grants).toHaveLength(1);
    expect(grants[0]?.billingAccountId).toBe(COGNI_SYSTEM_BILLING_ACCOUNT_ID);
    expect(grants[0]?.scopes).toContain("graph:execute:sandbox:openclaw");
    expect(grants[0]?.revokedAt).toBeNull();

    // LEDGER_COLLECT_IS_OPERATOR_OWNED: the repo-spec synthesizes a LEDGER_INGEST
    // charter, but the node never writes it — neither flat nor node-scoped.
    const ids = await listGovernanceIds();
    createdScheduleIds.push(...ids);
    expect(ids).not.toContain("governance:ledger_ingest");
    expect(ids).not.toContain(`governance:${getNodeId()}:ledger_ingest`);
  });

  it("is idempotent: running twice produces same result", async () => {
    await runGovernanceSchedulesSyncJob();

    const db = getSeedDb();
    const grantsAfterFirst = await db
      .select()
      .from(executionGrants)
      .where(eq(executionGrants.userId, COGNI_SYSTEM_PRINCIPAL_USER_ID));
    const firstGrantId = grantsAfterFirst[0]?.id;
    expect(firstGrantId).toBeDefined();
    const idsAfterFirst = await listGovernanceIds();
    createdScheduleIds.push(...idsAfterFirst);

    await runGovernanceSchedulesSyncJob();

    const grantsAfterSecond = await db
      .select()
      .from(executionGrants)
      .where(eq(executionGrants.userId, COGNI_SYSTEM_PRINCIPAL_USER_ID));
    expect(grantsAfterSecond).toHaveLength(1);
    expect(grantsAfterSecond[0]?.id).toBe(firstGrantId);
    expect(await listGovernanceIds()).toEqual(idsAfterFirst);
  });

  it("never overwrites or pauses the operator's flat or node-scoped ledger schedules", async () => {
    // Operator-owned schedules in the shared namespace (flat + this node's dispatch).
    const client = await getTestTemporalClient();
    const operatorIds = [
      "governance:ledger_ingest",
      `governance:${getNodeId()}:ledger_ingest`,
    ];
    for (const scheduleId of operatorIds) {
      await client.schedule.create({
        scheduleId,
        spec: { cronExpressions: ["0 * * * *"], timezone: "UTC" },
        action: {
          type: "startWorkflow",
          workflowType: "NodeTaskWorkflow",
          workflowId: scheduleId,
          args: [{ scheduleId, input: { operator: "owned" } }],
          taskQueue: "scheduler-worker",
        },
      });
      createdScheduleIds.push(scheduleId);
    }

    await runGovernanceSchedulesSyncJob();

    for (const scheduleId of operatorIds) {
      const desc = await adapter.describeSchedule(scheduleId);
      expect(desc).toBeDefined();
      expect(desc?.isPaused).toBe(false);
      expect(JSON.stringify(desc?.input)).toContain("operator");
    }
  });
});

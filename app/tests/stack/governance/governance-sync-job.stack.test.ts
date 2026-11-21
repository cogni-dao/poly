// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/governance/governance-sync-job.stack`
 * Purpose: End-to-end test for governance schedule sync job.
 * Scope: Verifies job runs, creates grant, creates schedules in Temporal, and is idempotent. Does not test concurrent lock behavior (requires parallel processes).
 * Invariants: SINGLE_WRITER (via advisory lock), GRANT_VIA_PORT (no raw SQL), IDEMPOTENT (safe to re-run)
 * Side-effects: IO
 * Links: src/bootstrap/jobs/syncGovernanceSchedules.job.ts
 * @public
 */

import { createHash } from "node:crypto";
import { executionGrants, schedules } from "@cogni/db-schema";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { getExecutionRequestsByPrefix } from "@tests/_fixtures/scheduling/db-helpers";
import {
  getTestTemporalClient,
  getTestTemporalConfig,
  triggerSchedule,
} from "@tests/_fixtures/temporal/client";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemporalScheduleControlAdapter } from "@/adapters/server/temporal/schedule-control.adapter";
import { runGovernanceSchedulesSyncJob } from "@/bootstrap/jobs/syncGovernanceSchedules.job";

import { governanceScheduleId } from "@cogni/scheduling";
import * as config from "@/shared/config";

const HEARTBEAT_ID = governanceScheduleId(
  config.getNodeId(),
  "poly_theme_fixture_heartbeat"
);
const STALE_ID = governanceScheduleId(
  config.getNodeId(),
  "poly_theme_fixture_stale"
);

async function fixtureGrant() {
  const db = getSeedDb();
  const [row] = await db
    .select({ grantId: schedules.executionGrantId })
    .from(schedules)
    .where(
      and(
        eq(schedules.ownerUserId, COGNI_SYSTEM_PRINCIPAL_USER_ID),
        eq(schedules.temporalScheduleId, HEARTBEAT_ID)
      )
    );
  if (!row) throw new Error("Missing owned fixture schedule");
  return db
    .select()
    .from(executionGrants)
    .where(eq(executionGrants.id, row.grantId));
}

describe("Governance Schedule Sync Job (Stack)", () => {
  const createdScheduleIds: string[] = [];
  let adapter: TemporalScheduleControlAdapter;

  beforeEach(async () => {
    // Initialize adapter
    adapter = new TemporalScheduleControlAdapter(getTestTemporalConfig());

    const original = config.getGovernanceConfig();
    vi.spyOn(config, "getGovernanceConfig").mockReturnValue({
      ...original,
      schedules: [
        ...original.schedules,
        {
          charter: "poly_theme_fixture_heartbeat",
          cron: "0 * * * *",
          timezone: "UTC",
          entrypoint: "HEARTBEAT",
        },
      ],
    });
    createdScheduleIds.push(HEARTBEAT_ID, STALE_ID);
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

    const db = getSeedDb();
    await db
      .delete(schedules)
      .where(
        and(
          eq(schedules.ownerUserId, COGNI_SYSTEM_PRINCIPAL_USER_ID),
          inArray(schedules.temporalScheduleId, [HEARTBEAT_ID, STALE_ID])
        )
      );
    vi.restoreAllMocks();
  });

  it("creates governance grant and schedules in Temporal", async () => {
    // Run the job
    await runGovernanceSchedulesSyncJob();

    // Verify grant was created
    const grants = await fixtureGrant();

    expect(grants).toHaveLength(1);
    expect(grants[0]?.billingAccountId).toBe(COGNI_SYSTEM_BILLING_ACCOUNT_ID);
    expect(grants[0]?.scopes).toContain("graph:execute:sandbox:openclaw");
    expect(grants[0]?.revokedAt).toBeNull();

    // Verify schedule was created in Temporal (use getHandle directly —
    // schedule.list() has eventual consistency and may lag after create)
    const client = await getTestTemporalClient();
    const handle = client.schedule.getHandle(HEARTBEAT_ID);
    const rawDesc = await handle.describe();
    expect(rawDesc).toBeDefined();
    createdScheduleIds.push(HEARTBEAT_ID);

    // Verify schedule details using adapter
    const desc = await adapter.describeSchedule(HEARTBEAT_ID);
    expect(desc).toBeDefined();
    expect(desc?.isPaused).toBe(false);
    expect(desc?.nextRunAtIso).toBeDefined();

    // Verify raw Temporal schedule has correct policies (flat structure, not nested)
    expect(rawDesc.spec.timezone).toBe("UTC");
    expect(rawDesc.policies.overlap).toBe("SKIP");
    // Governance explicitly disables catch-up.
    expect(rawDesc.policies.pauseOnFailure).toBe(false);
    expect(rawDesc.policies.catchupWindow).toBe(0);
  });

  it("is idempotent: running twice produces same result", async () => {
    // Run job first time
    await runGovernanceSchedulesSyncJob();

    const db = getSeedDb();
    const grantsAfterFirst = await fixtureGrant();

    const firstGrantId = grantsAfterFirst[0]?.id;
    expect(firstGrantId).toBeDefined();

    // Run job second time
    await runGovernanceSchedulesSyncJob();

    // Grant should be the same (not duplicated)
    const grantsAfterSecond = await fixtureGrant();

    expect(grantsAfterSecond).toHaveLength(grantsAfterFirst.length);
    expect(grantsAfterSecond[0]?.id).toBe(firstGrantId);

    expect(await adapter.describeSchedule(HEARTBEAT_ID)).toBeDefined();
    const ownedRows = await db
      .select({ id: schedules.id })
      .from(schedules)
      .where(
        and(
          eq(schedules.ownerUserId, COGNI_SYSTEM_PRINCIPAL_USER_ID),
          eq(schedules.temporalScheduleId, HEARTBEAT_ID)
        )
      );
    expect(ownedRows).toHaveLength(1);
  });

  it("pauses schedules removed from config", async () => {
    // First, create a schedule that's NOT in the current config
    const client = await getTestTemporalClient();
    await client.schedule.create({
      scheduleId: STALE_ID,
      spec: {
        cronExpressions: ["0 * * * *"],
        timezone: "UTC",
      },
      action: {
        type: "startWorkflow",
        workflowType: "GraphRunWorkflow",
        workflowId: STALE_ID,
        args: [{ scheduleId: STALE_ID, input: { message: "OLD" } }],
        taskQueue: "scheduler-worker",
      },
    });
    createdScheduleIds.push(STALE_ID);

    // Seed this fixture's local row; namespace-only schedules confer no prune authority.
    await runGovernanceSchedulesSyncJob();
    const db = getSeedDb();
    const [heartbeat] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.temporalScheduleId, HEARTBEAT_ID));
    if (!heartbeat) throw new Error("Missing fixture heartbeat row");
    await db.insert(schedules).values({
      temporalScheduleId: STALE_ID,
      ownerUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
      executionGrantId: heartbeat.executionGrantId,
      graphId: heartbeat.graphId,
      input: {},
      cron: "0 * * * *",
      timezone: "UTC",
      enabled: true,
    });

    // Run sync job
    await runGovernanceSchedulesSyncJob();

    // Verify old schedule was paused using adapter
    const desc = await adapter.describeSchedule(STALE_ID);
    expect(desc).toBeDefined();
    expect(desc?.isPaused).toBe(true);
  });

  it("executes a governance schedule end-to-end", async () => {
    await runGovernanceSchedulesSyncJob();
    const temporalScheduleId = HEARTBEAT_ID;
    createdScheduleIds.push(temporalScheduleId);

    const before = await getExecutionRequestsByPrefix(`${temporalScheduleId}:`);
    await triggerSchedule(temporalScheduleId);

    const client = await getTestTemporalClient();
    const start = Date.now();
    let created = before;
    while (Date.now() - start < 8_000) {
      created = await getExecutionRequestsByPrefix(`${temporalScheduleId}:`);
      if (created.length > before.length) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (created.length <= before.length) {
      const desc = await client.schedule
        .getHandle(temporalScheduleId)
        .describe();
      const recentActionCount = desc.info.recentActions.length;
      const lastAction = desc.info.recentActions.at(-1);
      const lastScheduledAt =
        lastAction?.scheduledAt?.toISOString?.() ?? "unknown";
      throw new Error(
        `No execution_requests row observed for ${temporalScheduleId} after trigger. ` +
          `recentActions=${recentActionCount}, lastScheduledAt=${lastScheduledAt}. ` +
          "Likely worker backlog or stale scheduler-worker process."
      );
    }

    const latest = created.sort((a, b) => {
      return b.createdAt.getTime() - a.createdAt.getTime();
    })[0];
    expect(latest).toBeDefined();
    if (!latest) {
      throw new Error("Missing execution_request row for governance run");
    }

    expect(latest.idempotencyKey.startsWith(`${temporalScheduleId}:`)).toBe(
      true
    );
    // Regression guard: before stateKey wiring, governance runs would finalize
    // as internal errors almost immediately from gateway execution.
    if (latest.ok === false && latest.errorCode === "internal") {
      throw new Error(
        "Governance run finalized with internal error (possible stateKey regression)"
      );
    }

    const expectedRequestHash = createHash("sha256")
      .update(
        JSON.stringify({
          graphId: "sandbox:openclaw",
          input: { message: "HEARTBEAT", model: "kimi-k2.5" },
        }),
        "utf8"
      )
      .digest("hex");
    expect(latest.requestHash).toBe(expectedRequestHash);
  });
});

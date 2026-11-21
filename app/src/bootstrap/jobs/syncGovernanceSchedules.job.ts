// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/syncGovernanceSchedules.job`
 * Purpose: Job module that wires governance schedule sync to the application container.
 * Scope: Acquires advisory lock, resolves dependencies from container, and calls syncGovernanceSchedules. Does not contain business logic.
 * Invariants:
 *   - SINGLE_WRITER: native transactions hold a try-advisory lock through reconciliation or guarded eager dispatch
 *   - SESSION_OWNS_QUERIES: service callbacks use the transaction that owns the lock; native completion owns cleanup
 *   - GRANT_VIA_PORT: Uses ensureGrant on ExecutionGrantUserPort, no raw SQL
 *   - SYSTEM_PRINCIPAL: Grant created for COGNI_SYSTEM_PRINCIPAL_USER_ID
 * Side-effects: IO (database advisory lock, Temporal RPC, grant creation)
 * Links: packages/scheduler-core/src/services/syncGovernanceSchedules.ts, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/governance-scheduling.md
 * @public
 */

import { toUserId } from "@cogni/ids";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import { syncGovernanceSchedules } from "@cogni/scheduler-core";
import cronParser from "cron-parser";
import { and, eq, sql } from "drizzle-orm";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { getContainer } from "@/bootstrap/container";
import { getGovernanceConfig, getNodeId } from "@/shared/config";
import { schedules } from "@/shared/db/schema";
import { serverEnv } from "@/shared/env/server-env";

const GOVERNANCE_GRANT_SCOPES = ["graph:execute:sandbox:openclaw"] as const;

/** Temporal schedule ID for the ledger-ingest (epoch) schedule. */
const LEDGER_INGEST_SCHEDULE_ID = "governance:ledger_ingest";

function computeNextRun(cron: string, timezone: string): Date {
  const interval = cronParser.parseExpression(cron, {
    currentDate: new Date(),
    tz: timezone,
  });
  return interval.next().toDate();
}

export interface GovernanceScheduleSyncSummary {
  created: number;
  updated: number;
  resumed: number;
  skipped: number;
  paused: number;
}

/**
 * Run the governance schedules sync job.
 *
 * 1. Acquires a PostgreSQL advisory lock (single-writer)
 * 2. Resolves deps from the application container
 * 3. Calls syncGovernanceSchedules with repo-spec config
 */
export async function runGovernanceSchedulesSyncJob(): Promise<GovernanceScheduleSyncSummary> {
  const container = getContainer();
  const { log } = container;

  // Skip if governance schedules disabled (e.g., in preview environments)
  if (!serverEnv().GOVERNANCE_SCHEDULES_ENABLED) {
    log.info({}, "Governance schedules disabled, skipping sync");
    return { created: 0, updated: 0, resumed: 0, skipped: 0, paused: 0 };
  }

  log.info({}, "Starting governance schedule sync job");

  const serviceDb = getServiceDb();
  let ledgerScheduleRowId: string | undefined;
  const result = await serviceDb.transaction(async (lockedDb) => {
    const [lockRow] = await lockedDb.execute<{ acquired: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext('governance_sync')) AS acquired`
    );
    if (lockRow?.acquired !== true) {
      log.info({}, "Governance sync already running, skipping");
      return null;
    }

    // Native transaction ownership keeps every service callback on this session.
    const config = getGovernanceConfig();
    const systemUserId = toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID);

    const result = await syncGovernanceSchedules(config, {
      ensureGovernanceGrant: async () => {
        const grant = await container.executionGrantPort.ensureGrant({
          userId: systemUserId,
          billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
          scopes: GOVERNANCE_GRANT_SCOPES,
        });
        return grant.id;
      },
      upsertGovernanceScheduleRow: async (params) => {
        const nextRunAt = computeNextRun(params.cron, params.timezone);

        // Scope lookup to system tenant to avoid cross-tenant collisions
        const existingRows = await lockedDb
          .select({ id: schedules.id })
          .from(schedules)
          .where(
            and(
              eq(schedules.ownerUserId, params.ownerUserId),
              eq(schedules.temporalScheduleId, params.temporalScheduleId)
            )
          )
          .limit(1);
        const existing = existingRows[0];

        if (existing) {
          await lockedDb
            .update(schedules)
            .set({
              executionGrantId: params.executionGrantId,
              input: params.input,
              cron: params.cron,
              timezone: params.timezone,
              enabled: true,
              nextRunAt,
              updatedAt: new Date(),
            })
            .where(eq(schedules.id, existing.id));
          if (params.temporalScheduleId === LEDGER_INGEST_SCHEDULE_ID) {
            ledgerScheduleRowId = existing.id;
          }
          return existing.id;
        }

        const [row] = await lockedDb
          .insert(schedules)
          .values({
            temporalScheduleId: params.temporalScheduleId,
            ownerUserId: params.ownerUserId,
            executionGrantId: params.executionGrantId,
            graphId: params.graphId,
            input: params.input,
            cron: params.cron,
            timezone: params.timezone,
            enabled: true,
            nextRunAt,
          })
          .returning();
        if (!row) throw new Error("Insert returned no row");
        if (params.temporalScheduleId === LEDGER_INGEST_SCHEDULE_ID) {
          ledgerScheduleRowId = row.id;
        }
        return row.id;
      },
      systemUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
      nodeId: getNodeId(),
      scheduleControl: container.scheduleControl,
      listGovernanceScheduleIds: () =>
        container.scheduleControl.listScheduleIds("governance:"),
      disableSchedule: async (temporalScheduleId: string) => {
        // Direct DB update via the lock-owning transaction session (same pattern as upsertGovernanceScheduleRow).
        // Cannot use ScheduleUserPort.updateSchedule here because the adapter
        // passes DB UUID to scheduleControl.pauseSchedule() which expects a
        // Temporal schedule ID — causing a rollback. The Temporal pause is
        // already handled by the sync service's prune step.
        await lockedDb
          .update(schedules)
          .set({ enabled: false, nextRunAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(schedules.ownerUserId, COGNI_SYSTEM_PRINCIPAL_USER_ID),
              eq(schedules.temporalScheduleId, temporalScheduleId)
            )
          );
      },
      log,
    });

    return result;
  });

  if (!result) {
    return { created: 0, updated: 0, resumed: 0, skipped: 0, paused: 0 };
  }

  // Commit schedule rows before a workflow can read them. The optional trigger
  // reacquires the same nonblocking guard and revalidates after any interleaving.
  if (result.created.includes(LEDGER_INGEST_SCHEDULE_ID) && ledgerScheduleRowId) {
    const committedRowId = ledgerScheduleRowId;
    await serviceDb.transaction(async (triggerDb) => {
      const [lockRow] = await triggerDb.execute<{ acquired: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtext('governance_sync')) AS acquired`
      );
      if (lockRow?.acquired !== true) {
        log.info({}, "Eager epoch trigger skipped: governance sync already running");
        return;
      }
      const [row] = await triggerDb
        .select({ id: schedules.id })
        .from(schedules)
        .where(
          and(
            eq(schedules.id, committedRowId),
            eq(schedules.ownerUserId, COGNI_SYSTEM_PRINCIPAL_USER_ID),
            eq(schedules.temporalScheduleId, LEDGER_INGEST_SCHEDULE_ID),
            eq(schedules.enabled, true)
          )
        )
        .limit(1);
      if (!row) {
        log.info({}, "Eager epoch trigger skipped: schedule changed or disabled");
        return;
      }
      try {
        await container.scheduleControl.triggerSchedule(LEDGER_INGEST_SCHEDULE_ID);
        log.info(
          { scheduleId: LEDGER_INGEST_SCHEDULE_ID },
          "Eager-triggered first epoch collection"
        );
      } catch (err) {
        // An ambiguous acknowledgement can already have started execution.
        // Never replay the optional trigger; cron remains the backstop.
        log.warn(
          { scheduleId: LEDGER_INGEST_SCHEDULE_ID, err },
          "Eager epoch trigger failed — cron will open the first epoch"
        );
      }
    });
  }

  log.info(
    {
      created: result.created.length,
      updated: result.updated.length,
      resumed: result.resumed.length,
      skipped: result.skipped.length,
      paused: result.paused.length,
    },
    "Governance schedule sync complete"
  );

  return {
    created: result.created.length,
    updated: result.updated.length,
    resumed: result.resumed.length,
    skipped: result.skipped.length,
    paused: result.paused.length,
  };
}

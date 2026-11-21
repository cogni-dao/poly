// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/syncGovernanceSchedules.job`
 * Purpose: Job module that wires governance schedule sync to the application container.
 * Scope: Acquires advisory lock, resolves dependencies from container, and calls syncGovernanceSchedules. Does not contain business logic.
 * Invariants:
 *   - SINGLE_WRITER: native transactions hold a try-advisory lock through reconciliation
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
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { getContainer } from "@/bootstrap/container";
import { getGovernanceConfig, getNodeId } from "@/shared/config";
import { schedules } from "@/shared/db/schema";
import { serverEnv } from "@/shared/env/server-env";

const GOVERNANCE_GRANT_SCOPES = ["graph:execute:sandbox:openclaw"] as const;

/** Fail closed rather than reconcile a truncated local row set. */
const GOVERNANCE_PRUNE_MAX_ROWS = 1000;

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
    const nodeId = getNodeId();
    const prefix = `governance:${nodeId}:`;
    const temporalId = schedules.temporalScheduleId;
    // Literal, parameterized prefix matching: node IDs are never LIKE patterns.
    const eligibleScope = sql`(
      (left(${temporalId}, length(${prefix})) = ${prefix}
        AND length(${temporalId}) > length(${prefix})
        AND lower(substring(${temporalId} from length(${prefix}) + 1)) <> 'ledger_ingest')
      OR (split_part(${temporalId}, ':', 1) = 'governance'
        AND array_length(string_to_array(${temporalId}, ':'), 1) = 2)
    )`;
    const eligibleRows = and(
      eq(schedules.ownerUserId, COGNI_SYSTEM_PRINCIPAL_USER_ID),
      eq(schedules.enabled, true),
      isNotNull(temporalId),
      eligibleScope
    );
    const pruneRows = await lockedDb
      .select({ id: schedules.id, temporalScheduleId: temporalId })
      .from(schedules)
      .where(eligibleRows)
      .orderBy(asc(schedules.id))
      .limit(GOVERNANCE_PRUNE_MAX_ROWS + 1);
    if (pruneRows.length > GOVERNANCE_PRUNE_MAX_ROWS) {
      throw new Error(
        `Governance prune capacity exceeded (${GOVERNANCE_PRUNE_MAX_ROWS})`
      );
    }
    const pruneIds = new Map(
      pruneRows.map((row) => [row.temporalScheduleId, row.id])
    );

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
        return row.id;
      },
      systemUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
      nodeId,
      scheduleControl: container.scheduleControl,
      listGovernanceScheduleIds: async () =>
        pruneRows
          .map((row) => row.temporalScheduleId)
          .filter((id): id is string => id !== null),
      disableSchedule: async (temporalScheduleId: string) => {
        const rowId = pruneIds.get(temporalScheduleId);
        if (!rowId) throw new Error("Governance disable outside preflight set");
        await lockedDb
          .update(schedules)
          .set({ enabled: false, nextRunAt: null, updatedAt: new Date() })
          .where(
            and(
              eligibleRows,
              eq(schedules.id, rowId),
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

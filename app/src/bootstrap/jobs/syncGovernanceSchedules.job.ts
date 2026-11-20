// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/syncGovernanceSchedules.job`
 * Purpose: Job module that wires governance schedule sync to the application container.
 * Scope: Acquires advisory lock, resolves dependencies from container, and calls syncGovernanceSchedules. Does not contain business logic.
 * Invariants:
 *   - SINGLE_WRITER: a transaction-scoped advisory lock prevents concurrent sync runs
 *   - BOUNDED_LOCK: a 60s deadline rolls the transaction back; the server reaps an idle holder after 120s
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
import { and, eq } from "drizzle-orm";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { getContainer } from "@/bootstrap/container";
import { getGovernanceConfig, getNodeId } from "@/shared/config";
import { schedules } from "@/shared/db/schema";
import { serverEnv } from "@/shared/env/server-env";

/**
 * Governance grant (sandbox:openclaw scope). Charters this node writes run on it; the
 * operator owns LEDGER_INGEST, which is never scheduled here.
 */
const GOVERNANCE_GRANT_SCOPES = ["graph:execute:sandbox:openclaw"] as const;

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

/** Hard deadline for one sync run. Past it the transaction rolls back and the lock is released. */
export const GOVERNANCE_SYNC_TIMEOUT_MS = 60_000;

/**
 * Server-side backstop for the lock holder. The lock lives in a transaction that sits idle
 * while the sync runs on other pool connections. If the holder hangs or its pod dies, the
 * server ends that session after this long and the lock frees (bug.0026 candidate-a: a
 * session-scoped lock with no timeout stayed held for hours). Must exceed the deadline.
 */
const LOCK_HOLDER_IDLE_TIMEOUT_MS = 120_000;

/** Reject after `ms`; the timer never outlives the race. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Governance sync timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Best-effort: who holds the sync lock. `pg_locks` is readable by any role; the
 * `pg_stat_activity` columns are NULL unless the role may see that session. Never throws.
 */
async function logLockHolder(
  serviceDb: ReturnType<typeof getServiceDb>,
  log: ReturnType<typeof getContainer>["log"],
): Promise<void> {
  try {
    const holders = await serviceDb.$client`
      SELECT l.pid, a.application_name, a.state, a.backend_start, a.state_change
      FROM pg_locks l
      LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory'
        AND l.granted
        AND l.objsubid = 1
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext('governance_sync')::bigint
      LIMIT 5`;
    log.warn(
      { holders: holders.map((h) => ({ ...h })) },
      "Governance sync lock holder",
    );
  } catch (err) {
    log.warn({ err }, "Governance sync lock holder unavailable");
  }
}

/**
 * Run the governance schedules sync job.
 *
 * 1. Takes a transaction-scoped advisory lock (single-writer). The lock ends with the
 *    transaction, on the deadline, or when the server reaps an idle holder.
 * 2. Resolves deps from the application container
 * 3. Calls syncGovernanceSchedules with repo-spec config, bounded by a hard deadline
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
  const outcome = await serviceDb.$client.begin(async (tx) => {
    await tx.unsafe(
      `SET LOCAL idle_in_transaction_session_timeout = ${LOCK_HOLDER_IDLE_TIMEOUT_MS}`,
    );
    const [lockRow] =
      await tx`SELECT pg_try_advisory_xact_lock(hashtext('governance_sync')) AS acquired`;
    if (!(lockRow as { acquired: boolean } | undefined)?.acquired) {
      return "locked" as const;
    }
    return withDeadline(
      runSync(container, serviceDb),
      GOVERNANCE_SYNC_TIMEOUT_MS,
    );
  });

  if (outcome === "locked") {
    await logLockHolder(serviceDb, log);
    log.info({}, "Governance sync already running, skipping");
    return { created: 0, updated: 0, resumed: 0, skipped: 0, paused: 0 };
  }
  return outcome;
}

async function runSync(
  container: ReturnType<typeof getContainer>,
  serviceDb: ReturnType<typeof getServiceDb>,
): Promise<GovernanceScheduleSyncSummary> {
  const { log } = container;
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
      const existingRows = await serviceDb
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
        await serviceDb
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

      const [row] = await serviceDb
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
    nodeId: getNodeId(),
    scheduleControl: container.scheduleControl,
    // Prune only this node database's ENABLED system-owned governance rows. The
    // Temporal namespace is shared; a prefix scan could include sibling nodes.
    // Disabled rows are already retired, so they are not re-listed every boot.
    listGovernanceScheduleIds: async () => {
      const rows = await serviceDb
        .select({ temporalScheduleId: schedules.temporalScheduleId })
        .from(schedules)
        .where(
          and(
            eq(schedules.ownerUserId, COGNI_SYSTEM_PRINCIPAL_USER_ID),
            eq(schedules.enabled, true)
          )
        );
      return rows
        .map((row) => row.temporalScheduleId)
        .filter(
          (id): id is string => id !== null && id.startsWith("governance:")
        );
    },
    disableSchedule: async (temporalScheduleId: string) => {
      // Direct DB update via serviceDb (same pattern as upsertGovernanceScheduleRow).
      // Cannot use ScheduleUserPort.updateSchedule here because the adapter
      // passes DB UUID to scheduleControl.pauseSchedule() which expects a
      // Temporal schedule ID — causing a rollback. The Temporal pause is
      // already handled by the sync service's prune step.
      await serviceDb
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

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core/services/syncGovernanceSchedules`
 * Purpose: Sync governance schedules from config to Temporal. Pure orchestration — depends only on ports and types.
 * Scope: Creates/updates/resumes node-scoped Temporal schedules for each non-ledger charter in governance config; pauses this node's schedules removed from config. Never schedules LEDGER_INGEST (the operator owns epoch-collect dispatch into the node). Does not manage tenant-facing schedule CRUD or workflow execution.
 * Invariants:
 *   - OVERLAP_SKIP_DEFAULT: All governance schedules use overlap=SKIP (enforced by ScheduleControlPort)
 *   - CATCHUP_WINDOW_ZERO: No backfill (enforced by ScheduleControlPort)
 *   - PRUNE_IS_PAUSE: Removed schedules are paused, never deleted (reversible)
 *   - SYSTEM_OPS_ONLY: This function runs at deploy time, never exposed as an API endpoint
 *   - PURE_ORCHESTRATION: No adapters, no Temporal client — only ports/types/callbacks
 *   - SYSTEM_TENANT_IS_TENANT: Governance schedules are first-class DB rows owned by system principal
 *   - UPDATE_ON_DRIFT: Existing schedules are updated in-place when config changes (model, cron, timezone, input)
 *   - NODE_SCOPED_SCHEDULE_ID (bug.0026): every schedule id this sync writes is
 *     `governance:{nodeId}:{charter}`. All nodes of an environment share ONE Temporal namespace, so a
 *     flat `governance:{charter}` id is a single schedule that the last writer owns.
 *   - LEDGER_COLLECT_IS_OPERATOR_OWNED (bug.0026): a node never writes a LEDGER_INGEST schedule. The
 *     operator creates `governance:{nodeId}:ledger_ingest` and dispatches `/api/internal/attribution/collect`
 *     into the node. The charter is skipped here, never given a DB row, and never pruned.
 *   - LEGACY_FLAT_IDS (bug.0026): a node never touches a flat `governance:{charter}` schedule in Temporal;
 *     it cannot know whose it is (the operator owns `governance:ledger_ingest`). It only disables its own
 *     database row for a flat id left by an older build.
 * Side-effects: IO (Temporal RPC via ScheduleControlPort, grant creation via ensureGovernanceGrant)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/scheduler.md, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/governance-council.md, .cogni/repo-spec.yaml
 * @public
 */

import { isDeepStrictEqual } from "node:util";

import type { JsonValue } from "type-fest";

import {
  type CreateScheduleParams,
  isScheduleControlConflictError,
  isScheduleControlNotFoundError,
  type ScheduleControlPort,
  type ScheduleDescription,
} from "../ports/schedule-control.port";

/** Graph ID for OpenClaw sandbox execution */
const GOVERNANCE_GRAPH_ID = "sandbox:openclaw";

/** Default model for governance agent runs */
// TODO(task.0068): Use default_flash from LiteLLM config metadata instead of hardcoded model
const GOVERNANCE_MODEL = "kimi-k2.5";

/** Charter the operator owns (epoch collection dispatched into the node). Lowercase. */
const LEDGER_INGEST_CHARTER_LC = "ledger_ingest";

/** Minimal governance schedule shape (no @/ imports — pure type) */
export interface GovernanceScheduleEntry {
  charter: string;
  cron: string;
  timezone: string;
  entrypoint: string;
}

/** Ledger config for LEDGER_INGEST schedules */
export interface LedgerScheduleConfig {
  /** Stable opaque scope UUID */
  scopeId: string;
  /** Human-friendly scope slug */
  scopeKey: string;
  /** Epoch length in days */
  epochLengthDays: number;
  /** Map of source name → source config */
  activitySources: Record<
    string,
    {
      attributionPipeline: string;
      sourceRefs: string[];
    }
  >;
  /** Pool budget: base_issuance_credits as string (bigint serialized). */
  baseIssuanceCredits?: string;
  /** EVM approver addresses for epoch close. */
  approvers?: string[];
}

/** Minimal governance config shape (no @/ imports — pure type) */
export interface GovernanceScheduleConfig {
  schedules: GovernanceScheduleEntry[];
  /** Ledger config — required when LEDGER_INGEST charter is present */
  ledger?: LedgerScheduleConfig;
}

/** Logger interface matching pino shape */
interface SyncLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Parameters for upserting a governance schedule DB row */
export interface UpsertGovernanceScheduleRowParams {
  /** Temporal schedule ID (e.g., "governance:{nodeId}:community") */
  temporalScheduleId: string;
  /** System tenant user ID */
  ownerUserId: string;
  /** Execution grant ID for authorization */
  executionGrantId: string;
  /** Graph ID (e.g., "sandbox:openclaw") */
  graphId: string;
  /** Graph input payload */
  input: JsonValue;
  /** Cron expression */
  cron: string;
  /** IANA timezone */
  timezone: string;
}

/** Injectable dependencies for governance schedule sync */
export interface GovernanceScheduleSyncDeps {
  /** Idempotent: ensures governance grant exists, returns grantId */
  ensureGovernanceGrant(): Promise<string>;
  /** Upsert governance schedule row in DB, returns dbScheduleId (UUID) */
  upsertGovernanceScheduleRow(
    params: UpsertGovernanceScheduleRowParams
  ): Promise<string>;
  /** System tenant user ID (owner of governance schedules) */
  systemUserId: string;
  /** Node ID from repo-spec (routes execution to correct node) */
  nodeId: string;
  /** Temporal schedule lifecycle control */
  scheduleControl: ScheduleControlPort;
  /** Returns this node database's system-owned governance schedule IDs (never a namespace-wide scan) */
  listGovernanceScheduleIds(): Promise<string[]>;
  /** Disable a governance schedule (DB + Temporal) by its Temporal schedule ID */
  disableSchedule(temporalScheduleId: string): Promise<void>;
  /** Structured logger */
  log: SyncLogger;
}

/** Result of a governance schedule sync operation */
export interface GovernanceScheduleSyncResult {
  created: string[];
  updated: string[];
  resumed: string[];
  skipped: string[];
  paused: string[];
}

/**
 * Derives the Temporal schedule ID from an owning node + charter name.
 * Format: `governance:{nodeId}:{charter_lowercase}`.
 *
 * NODE_SCOPED_SCHEDULE_ID (bug.0026): all nodes of an environment share ONE Temporal
 * namespace. A flat `governance:{charter}` id is therefore ONE schedule that every
 * writer overwrites (last-writer-wins); it froze the operator's epochs. Node-scoped
 * ids match the form the operator uses for its per-node dispatch schedules.
 */
export function governanceScheduleId(nodeId: string, charter: string): string {
  return `governance:${nodeId}:${charter.toLowerCase()}`;
}

/**
 * True for a schedule id this node's sync OWNS and may pause: it starts with
 * `governance:{nodeId}:` and is not the ledger charter.
 *
 * CROSS_TENANT_PRUNE (bug.5009 / bug.0026): a node never pauses a flat id, a sibling's
 * id, or the operator's `governance:{nodeId}:ledger_ingest` dispatch schedule
 * (LEDGER_COLLECT_IS_OPERATOR_OWNED). A paused schedule skips its cron, so pausing
 * one stops that node's epochs.
 */
export function isOwnGovernanceScheduleId(
  nodeId: string,
  scheduleId: string
): boolean {
  const prefix = `governance:${nodeId}:`;
  if (!scheduleId.startsWith(prefix)) return false;
  const charter = scheduleId.slice(prefix.length);
  return charter.length > 0 && charter !== LEDGER_INGEST_CHARTER_LC;
}

/**
 * True for a legacy flat id (`governance:{charter}`, two segments) written by older
 * builds. LEGACY_FLAT_IDS: the node cannot know whose flat Temporal schedule this is
 * (the operator owns `governance:ledger_ingest` and `governance:work_prioritizer`),
 * so it never pauses one; it only disables its own database row. Node ids are UUIDs
 * (no colons), so segment count distinguishes flat from node-scoped ids.
 */
export function isLegacyFlatGovernanceScheduleId(scheduleId: string): boolean {
  return (
    scheduleId.startsWith("governance:") && scheduleId.split(":").length === 2
  );
}

/**
 * Checks whether the desired schedule config differs from the current Temporal state.
 * NOTE: cron comparison is skipped when desc.cron is null (Temporal compiles crons
 * to calendars, so the original string isn't available). Input + timezone cover
 * the critical drift cases (model, entrypoint, timezone changes).
 */
function scheduleConfigChanged(
  desc: ScheduleDescription,
  _cron: string,
  timezone: string,
  input: JsonValue
): boolean {
  return (
    (desc.timezone !== null && desc.timezone !== timezone) ||
    !isDeepStrictEqual(desc.input, input)
  );
}

/**
 * Syncs governance schedules from repo-spec config to Temporal.
 *
 * For each schedule in config:
 * - If missing in Temporal: create
 * - If exists with changed config: update in-place
 * - If exists but paused (same config): resume
 * - If exists but paused (changed config): update + resume
 * - If exists, running, same config: skip (no-op)
 *
 * For governance schedules in Temporal but not in config:
 * - Pause (don't delete — reversible)
 *
 * @param config - Governance config from repo-spec
 * @param deps - Injectable dependencies
 * @returns Summary of actions taken
 */
export async function syncGovernanceSchedules(
  config: GovernanceScheduleConfig,
  deps: GovernanceScheduleSyncDeps
): Promise<GovernanceScheduleSyncResult> {
  const { scheduleControl, log } = deps;

  // 1. Ensure governance grant exists for cogni_system
  const grantId = await deps.ensureGovernanceGrant();
  log.info({ grantId }, "Governance grant ready");

  // 2. Create, update, or resume schedules from config
  const result: GovernanceScheduleSyncResult = {
    created: [],
    updated: [],
    resumed: [],
    skipped: [],
    paused: [],
  };

  const configScheduleIds = new Set<string>();

  for (const schedule of config.schedules) {
    const scheduleId = governanceScheduleId(deps.nodeId, schedule.charter);

    // LEDGER_COLLECT_IS_OPERATOR_OWNED: the operator owns epoch collection and creates
    // `governance:{nodeId}:ledger_ingest` itself. Writing it here would overwrite that
    // schedule. Never created, never given a DB row, never pruned (see
    // isOwnGovernanceScheduleId).
    const isLedgerIngest =
      schedule.charter.toLowerCase() === LEDGER_INGEST_CHARTER_LC;
    if (isLedgerIngest) {
      log.info(
        { scheduleId },
        "Skipping governance schedule: epoch collection is operator-owned"
      );
      result.skipped.push(scheduleId);
      continue;
    }

    configScheduleIds.add(scheduleId);

    let desiredInput: JsonValue;
    let graphId: string;

    desiredInput = {
      message: schedule.entrypoint,
      model: GOVERNANCE_MODEL,
    };
    graphId = GOVERNANCE_GRAPH_ID;

    // Upsert DB row first — governance schedules are first-class DB rows
    const dbScheduleId = await deps.upsertGovernanceScheduleRow({
      temporalScheduleId: scheduleId,
      ownerUserId: deps.systemUserId,
      executionGrantId: grantId,
      graphId,
      input: desiredInput,
      cron: schedule.cron,
      timezone: schedule.timezone,
    });

    const desiredParams: CreateScheduleParams = {
      scheduleId,
      nodeId: deps.nodeId,
      dbScheduleId,
      ownerUserId: deps.systemUserId,
      cron: schedule.cron,
      timezone: schedule.timezone,
      graphId,
      executionGrantId: grantId,
      input: desiredInput,
      overlapPolicy: "skip",
      catchupWindowMs: 0,
    };

    try {
      await scheduleControl.createSchedule(desiredParams);
      result.created.push(scheduleId);
      log.info(
        { scheduleId, cron: schedule.cron },
        "Created governance schedule"
      );
    } catch (error) {
      if (isScheduleControlConflictError(error)) {
        // Schedule already exists — check for config or link drift
        const desc = await scheduleControl.describeSchedule(scheduleId);
        if (!desc) {
          // Race condition: schedule disappeared between create and describe
          result.skipped.push(scheduleId);
          continue;
        }

        const configChanged = scheduleConfigChanged(
          desc,
          schedule.cron,
          schedule.timezone,
          desiredInput
        );
        const linkDrift = desc.dbScheduleId !== dbScheduleId;

        if (configChanged || linkDrift) {
          await scheduleControl.updateSchedule(scheduleId, desiredParams);
          if (desc.isPaused) {
            await scheduleControl.resumeSchedule(scheduleId);
          }
          result.updated.push(scheduleId);
          log.info(
            { scheduleId, configChanged, linkDrift },
            "Updated governance schedule (drift detected)"
          );
        } else if (desc.isPaused) {
          await scheduleControl.resumeSchedule(scheduleId);
          result.resumed.push(scheduleId);
          log.info({ scheduleId }, "Resumed governance schedule");
        } else {
          result.skipped.push(scheduleId);
          log.info({ scheduleId }, "Governance schedule up to date, skipping");
        }
      } else {
        throw error;
      }
    }
  }

  // 3. Prune: pause governance schedules not in current config — but ONLY the ones THIS
  // node owns (`governance:{ownNodeId}:{charter}`, never the ledger charter). The shared
  // Temporal namespace also holds the operator's flat and node-scoped schedules and
  // sibling nodes' schedules. See {@link isOwnGovernanceScheduleId}.
  const allGovernanceIds = await deps.listGovernanceScheduleIds();
  for (const existingId of allGovernanceIds) {
    if (isLegacyFlatGovernanceScheduleId(existingId)) {
      // LEGACY_FLAT_IDS: retire this node's DB row only. Temporal is left alone.
      await deps.disableSchedule(existingId);
      log.warn(
        { scheduleId: existingId },
        "Disabled legacy flat governance schedule row (Temporal schedule untouched)"
      );
      continue;
    }
    if (
      isOwnGovernanceScheduleId(deps.nodeId, existingId) &&
      !configScheduleIds.has(existingId)
    ) {
      try {
        await scheduleControl.pauseSchedule(existingId);
        await deps.disableSchedule(existingId);
        result.paused.push(existingId);
        log.warn(
          { scheduleId: existingId },
          "Paused governance schedule (removed from repo-spec)"
        );
      } catch (error) {
        if (isScheduleControlNotFoundError(error)) {
          // Schedule was deleted externally — nothing to pause
          log.warn(
            { scheduleId: existingId },
            "Governance schedule not found in Temporal (deleted externally)"
          );
        } else {
          throw error;
        }
      }
    }
  }

  return result;
}

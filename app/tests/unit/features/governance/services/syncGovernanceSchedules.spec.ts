// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/services/syncGovernanceSchedules`
 * Purpose: Unit tests for governance schedule sync logic.
 * Scope: Tests sync function with mocked ScheduleControlPort; verifies create/update/resume/skip/prune behavior. Does not test Temporal integration or DB operations.
 * Invariants: Prune pauses (never deletes); conflict = update or skip or resume; idempotent on repeat.
 * Side-effects: none (all deps mocked)
 * Links: src/features/governance/services/syncGovernanceSchedules.ts
 * @public
 */

import {
  ScheduleControlConflictError,
  ScheduleControlNotFoundError,
  type ScheduleDescription,
} from "@cogni/scheduler-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GovernanceScheduleSyncDeps,
  governanceScheduleId,
  isLegacyFlatGovernanceScheduleId,
  isOwnGovernanceScheduleId,
  syncGovernanceSchedules,
} from "@/features/governance/services/syncGovernanceSchedules";
import type { GovernanceConfig } from "@/shared/config";

const GRANT_ID = "test-grant-id-001";
const NODE_ID = "4b06359a-a859-4399-888e-a8c7a6696f7e";
const OTHER_NODE_ID = "11111111-2222-4333-8444-555555555555";
/** Node-scoped schedule id (NODE_SCOPED_SCHEDULE_ID, bug.0026). */
const sid = (charter: string) => governanceScheduleId(NODE_ID, charter);
const SYSTEM_USER_ID = "00000000-0000-4000-a000-000000000001";
const MOCK_DB_SCHEDULE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Counter-based mock to return unique dbScheduleIds per call */
let upsertCallCount = 0;

function makeMockDeps(
  overrides?: Partial<GovernanceScheduleSyncDeps>
): GovernanceScheduleSyncDeps {
  upsertCallCount = 0;
  return {
    ensureGovernanceGrant: vi.fn().mockResolvedValue(GRANT_ID),
    upsertGovernanceScheduleRow: vi.fn().mockImplementation(() => {
      upsertCallCount++;
      return Promise.resolve(`${MOCK_DB_SCHEDULE_ID}-${upsertCallCount}`);
    }),
    systemUserId: SYSTEM_USER_ID,
    nodeId: NODE_ID,
    scheduleControl: {
      createSchedule: vi.fn().mockResolvedValue(undefined),
      updateSchedule: vi.fn().mockResolvedValue(undefined),
      pauseSchedule: vi.fn().mockResolvedValue(undefined),
      resumeSchedule: vi.fn().mockResolvedValue(undefined),
      deleteSchedule: vi.fn().mockResolvedValue(undefined),
      describeSchedule: vi.fn().mockResolvedValue(null),
      listScheduleIds: vi.fn().mockResolvedValue([]),
    },
    listGovernanceScheduleIds: vi.fn().mockResolvedValue([]),
    disableSchedule: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

function makeConfig(
  charters: Array<{
    charter: string;
    cron: string;
    entrypoint: string;
    timezone?: string;
  }>
): GovernanceConfig {
  return {
    schedules: charters.map((c) => ({
      charter: c.charter,
      cron: c.cron,
      timezone: c.timezone ?? "UTC",
      entrypoint: c.entrypoint,
    })),
  };
}

/** Helper: build a ScheduleDescription matching the desired config (no drift) */
function makeMatchingDesc(
  scheduleId: string,
  cron: string,
  entrypoint: string,
  opts?: { isPaused?: boolean; timezone?: string; dbScheduleId?: string | null }
): ScheduleDescription {
  return {
    scheduleId,
    nextRunAtIso: "2026-02-15T06:00:00Z",
    lastRunAtIso: null,
    isPaused: opts?.isPaused ?? false,
    cron,
    timezone: opts?.timezone ?? "UTC",
    input: { message: entrypoint, model: "kimi-k2.5" },
    dbScheduleId:
      "dbScheduleId" in (opts ?? {})
        ? (opts?.dbScheduleId ?? null)
        : `${MOCK_DB_SCHEDULE_ID}-1`,
  };
}

/** Helper: build a ScheduleDescription with stale config (drift) */
function makeDriftedDesc(
  scheduleId: string,
  cron: string,
  entrypoint: string,
  opts?: { isPaused?: boolean; dbScheduleId?: string | null }
): ScheduleDescription {
  return {
    scheduleId,
    nextRunAtIso: "2026-02-15T06:00:00Z",
    lastRunAtIso: null,
    isPaused: opts?.isPaused ?? false,
    cron,
    timezone: "UTC",
    // Stale: missing model field (the bug we're fixing)
    input: { message: entrypoint },
    dbScheduleId:
      "dbScheduleId" in (opts ?? {})
        ? (opts?.dbScheduleId ?? null)
        : `${MOCK_DB_SCHEDULE_ID}-1`,
  };
}

describe("syncGovernanceSchedules", () => {
  let deps: GovernanceScheduleSyncDeps;

  beforeEach(() => {
    deps = makeMockDeps();
  });

  it("creates schedules for each charter in config", async () => {
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      { charter: "GOVERN", cron: "0 * * * *", entrypoint: "GOVERN" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.created).toEqual([
      sid("community"),
      sid("govern"),
    ]);
    // Upsert called for each schedule before Temporal creation
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledTimes(2);
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledWith(
      expect.objectContaining({
        temporalScheduleId: sid("community"),
        ownerUserId: SYSTEM_USER_ID,
        graphId: "sandbox:openclaw",
      })
    );
    expect(deps.scheduleControl.createSchedule).toHaveBeenCalledTimes(2);
    expect(deps.scheduleControl.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: sid("community"),
        dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1`,
        cron: "0 */6 * * *",
        timezone: "UTC",
        graphId: "sandbox:openclaw",
        executionGrantId: GRANT_ID,
        input: { message: "COMMUNITY", model: "kimi-k2.5" },
        overlapPolicy: "skip",
        catchupWindowMs: 0,
      })
    );
  });

  it("ensures governance grant before creating schedules", async () => {
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    await syncGovernanceSchedules(config, deps);

    expect(deps.ensureGovernanceGrant).toHaveBeenCalledOnce();
  });

  it("skips when schedule exists, is running, and config matches", async () => {
    const matchingDesc = makeMatchingDesc(
      sid("community"),
      "0 */6 * * *",
      "COMMUNITY"
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError(sid("community"))
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(matchingDesc);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.skipped).toEqual([sid("community")]);
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(deps.scheduleControl.updateSchedule).not.toHaveBeenCalled();
    expect(deps.scheduleControl.resumeSchedule).not.toHaveBeenCalled();
  });

  it("updates schedule when config has changed (model drift)", async () => {
    const driftedDesc = makeDriftedDesc(
      sid("community"),
      "0 */6 * * *",
      "COMMUNITY"
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError(sid("community"))
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(driftedDesc);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.updated).toEqual([sid("community")]);
    expect(result.skipped).toEqual([]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      sid("community"),
      expect.objectContaining({
        input: { message: "COMMUNITY", model: "kimi-k2.5" },
      })
    );
    // Running schedule — should not be resumed
    expect(deps.scheduleControl.resumeSchedule).not.toHaveBeenCalled();
  });

  it("updates schedule when dbScheduleId link drift detected", async () => {
    // Temporal schedule has dbScheduleId: null (legacy), DB row returns a UUID
    const descWithNullLink = makeMatchingDesc(
      sid("community"),
      "0 */6 * * *",
      "COMMUNITY",
      { dbScheduleId: null }
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError(sid("community"))
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(descWithNullLink);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.updated).toEqual([sid("community")]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      sid("community"),
      expect.objectContaining({
        dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1`,
      })
    );
  });

  it("updates and resumes a paused schedule with changed config", async () => {
    const driftedPaused = makeDriftedDesc(
      sid("community"),
      "0 */6 * * *",
      "COMMUNITY",
      { isPaused: true }
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError(sid("community"))
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(driftedPaused);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.updated).toEqual([sid("community")]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledOnce();
    expect(deps.scheduleControl.resumeSchedule).toHaveBeenCalledWith(
      sid("community")
    );
  });

  it("resumes paused schedule when config matches", async () => {
    const pausedDesc = makeMatchingDesc(
      sid("community"),
      "0 */6 * * *",
      "COMMUNITY",
      { isPaused: true }
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError(sid("community"))
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(pausedDesc);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.resumed).toEqual([sid("community")]);
    expect(deps.scheduleControl.resumeSchedule).toHaveBeenCalledWith(
      sid("community")
    );
    expect(deps.scheduleControl.updateSchedule).not.toHaveBeenCalled();
  });

  it("pauses stale governance schedules not in config", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue([sid("community"), sid("old-charter")]),
    });

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.paused).toEqual([sid("old-charter")]);
    expect(deps.scheduleControl.pauseSchedule).toHaveBeenCalledWith(
      sid("old-charter")
    );
  });

  // CROSS_TENANT_PRUNE (bug.5009 / bug.0026): the shared Temporal namespace also holds the
  // operator's flat schedules, its node-scoped `governance:{nodeId}:ledger_ingest` dispatch
  // schedule and sibling nodes' schedules. This node's prune MUST pause none of them.
  const OPERATOR_FLAT_IDS = [
    "governance:ledger_ingest",
    "governance:work_prioritizer",
  ];
  const OWN_DISPATCH_ID = `governance:${NODE_ID}:ledger_ingest`;
  const SIBLING_ID = `governance:${OTHER_NODE_ID}:community`;
  const SIBLING_DISPATCH_ID = `governance:${OTHER_NODE_ID}:ledger_ingest`;

  it("never pauses the operator's flat, own dispatch, or a sibling's schedules", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue([
          sid("community"),
          ...OPERATOR_FLAT_IDS,
          OWN_DISPATCH_ID,
          SIBLING_ID,
          SIBLING_DISPATCH_ID,
        ]),
    });

    const result = await syncGovernanceSchedules(
      makeConfig([
        { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      ]),
      deps
    );

    expect(result.paused).toEqual([]);
    expect(deps.scheduleControl.pauseSchedule).not.toHaveBeenCalled();
  });

  it("disables only the DB row of a legacy flat id and leaves Temporal alone", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi.fn().mockResolvedValue(OPERATOR_FLAT_IDS),
    });

    const result = await syncGovernanceSchedules(makeConfig([]), deps);

    expect(deps.disableSchedule).toHaveBeenCalledTimes(2);
    expect(deps.disableSchedule).toHaveBeenCalledWith("governance:ledger_ingest");
    expect(deps.disableSchedule).toHaveBeenCalledWith(
      "governance:work_prioritizer"
    );
    expect(deps.scheduleControl.pauseSchedule).not.toHaveBeenCalled();
    expect(result.paused).toEqual([]);
  });

  it("still prunes its own stale node-scoped id while ignoring everything else", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue([
          sid("community"),
          sid("old-charter"),
          ...OPERATOR_FLAT_IDS,
          OWN_DISPATCH_ID,
          SIBLING_ID,
        ]),
    });

    const result = await syncGovernanceSchedules(
      makeConfig([
        { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      ]),
      deps
    );

    expect(result.paused).toEqual([sid("old-charter")]);
    expect(deps.scheduleControl.pauseSchedule).toHaveBeenCalledTimes(1);
    expect(deps.scheduleControl.pauseSchedule).toHaveBeenCalledWith(
      sid("old-charter")
    );
  });

  it("handles externally deleted schedules during prune gracefully", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue([sid("deleted-charter")]),
    });
    deps.scheduleControl.pauseSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlNotFoundError(sid("deleted-charter"))
      );

    const config = makeConfig([]);

    const result = await syncGovernanceSchedules(config, deps);

    // Should not throw, and should not list as paused
    expect(result.paused).toEqual([]);
  });

  it("is idempotent: no-op on repeat call with same config", async () => {
    // Use a stable dbScheduleId for both calls
    const stableDbId = "stable-db-id-for-idempotency";
    deps.upsertGovernanceScheduleRow = vi.fn().mockResolvedValue(stableDbId);

    // First call: all schedules created
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result1 = await syncGovernanceSchedules(config, deps);
    expect(result1.created).toEqual([sid("community")]);

    // Second call: schedule exists now with matching config + same dbScheduleId
    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError(sid("community"))
      );
    deps.scheduleControl.describeSchedule = vi.fn().mockResolvedValue(
      makeMatchingDesc(sid("community"), "0 */6 * * *", "COMMUNITY", {
        dbScheduleId: stableDbId,
      })
    );

    const result2 = await syncGovernanceSchedules(config, deps);
    expect(result2.skipped).toEqual([sid("community")]);
    expect(result2.created).toEqual([]);
    expect(result2.updated).toEqual([]);
  });

  it("LEDGER_COLLECT_IS_OPERATOR_OWNED: never writes a ledger schedule, adds no row", async () => {
    const result = await syncGovernanceSchedules(
      {
        schedules: [
          {
            charter: "COMMUNITY",
            cron: "0 */6 * * *",
            timezone: "UTC",
            entrypoint: "COMMUNITY",
          },
          {
            charter: "LEDGER_INGEST",
            cron: "0 0 * * *",
            timezone: "UTC",
            entrypoint: "LEDGER_INGEST",
          },
        ],
        ledger: {
          scopeId: "scope-uuid-001",
          scopeKey: "default",
          epochLengthDays: 7,
          activitySources: {},
        },
      },
      deps
    );

    expect(result.created).toEqual([sid("community")]);
    expect(result.skipped).toEqual([sid("ledger_ingest")]);
    expect(deps.scheduleControl.createSchedule).toHaveBeenCalledTimes(1);
    expect(deps.scheduleControl.describeSchedule).not.toHaveBeenCalled();
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledTimes(1);
    expect(deps.log.info).toHaveBeenCalledWith(
      { scheduleId: sid("ledger_ingest") },
      "Skipping governance schedule: epoch collection is operator-owned"
    );
    expect(result.paused).toEqual([]);
  });

  it("returns empty result for config with no schedules", async () => {
    const config = makeConfig([]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.resumed).toEqual([]);
    expect(result.paused).toEqual([]);
  });
});

describe("governance schedule ids", () => {
  it("scopes by node and lowercases the charter", () => {
    expect(governanceScheduleId(NODE_ID, "COMMUNITY")).toBe(
      `governance:${NODE_ID}:community`
    );
    expect(governanceScheduleId(NODE_ID, "GOVERN")).toBe(
      `governance:${NODE_ID}:govern`
    );
  });

  it("isOwnGovernanceScheduleId matches only this node, never ledger_ingest", () => {
    expect(isOwnGovernanceScheduleId(NODE_ID, sid("community"))).toBe(true);
    expect(isOwnGovernanceScheduleId(NODE_ID, sid("ledger_ingest"))).toBe(false);
    expect(isOwnGovernanceScheduleId(NODE_ID, "governance:community")).toBe(false);
    expect(
      isOwnGovernanceScheduleId(NODE_ID, `governance:${OTHER_NODE_ID}:community`)
    ).toBe(false);
  });

  it("isLegacyFlatGovernanceScheduleId matches only two-segment ids", () => {
    expect(isLegacyFlatGovernanceScheduleId("governance:ledger_ingest")).toBe(true);
    expect(isLegacyFlatGovernanceScheduleId(sid("community"))).toBe(false);
    expect(isLegacyFlatGovernanceScheduleId("other:thing")).toBe(false);
  });
});

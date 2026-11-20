// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/governance-sync-job-deadline`
 * Purpose: A hung governance sync must not hold its advisory lock forever (bug.0026, candidate-a).
 * Scope: Drives the real job with a sync that never settles. Does not test Postgres or Temporal.
 * Invariants: BOUNDED_LOCK: the lock lives in a transaction; the 60s deadline rejects the job, which rolls the transaction back; the server also reaps an idle holder.
 * Side-effects: none (all collaborators mocked)
 * Links: src/bootstrap/jobs/syncGovernanceSchedules.job.ts
 * @public
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const unsafe = vi.fn().mockResolvedValue([]);
const lockQueries: string[] = [];
const tx = Object.assign(
  (strings: TemplateStringsArray) => {
    lockQueries.push(strings.join(""));
    return Promise.resolve([{ acquired: true }]);
  },
  { unsafe },
);
// Mirrors postgres.js: a throwing callback rolls the transaction back (lock released).
const rollbacks: unknown[] = [];
const begin = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
  try {
    return await fn(tx);
  } catch (err) {
    rollbacks.push(err);
    throw err;
  }
});

vi.mock("@/adapters/server/db/drizzle.service-client", () => ({
  getServiceDb: () => ({ $client: { begin } }),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: { info: vi.fn(), warn: vi.fn() },
    executionGrantPort: {},
    scheduleControl: {},
  }),
}));
vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => ({ GOVERNANCE_SCHEDULES_ENABLED: true }),
}));
vi.mock("@/shared/config", () => ({
  getGovernanceConfig: () => ({ schedules: [] }),
  getNodeId: () => "b927a9dd-6132-4fc9-a51e-e3cee2568e3c",
}));
vi.mock("@cogni/scheduler-core", () => ({
  syncGovernanceSchedules: () => new Promise(() => {}),
}));

describe("governance sync job deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lockQueries.length = 0;
    rollbacks.length = 0;
    begin.mockClear();
    unsafe.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("rejects a hung sync at the deadline and rolls the lock transaction back", async () => {
    const { runGovernanceSchedulesSyncJob, GOVERNANCE_SYNC_TIMEOUT_MS } =
      await import("@/bootstrap/jobs/syncGovernanceSchedules.job");

    const outcome = runGovernanceSchedulesSyncJob().then(
      () => "resolved",
      (err: Error) => err.message,
    );
    await vi.advanceTimersByTimeAsync(GOVERNANCE_SYNC_TIMEOUT_MS);

    expect(await outcome).toBe(
      `Governance sync timed out after ${GOVERNANCE_SYNC_TIMEOUT_MS}ms`,
    );
    // The lock is transaction-scoped, and the holder is reaped by the server if it hangs.
    expect(lockQueries.join(" ")).toContain("pg_try_advisory_xact_lock");
    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining("idle_in_transaction_session_timeout"),
    );
    expect(rollbacks).toHaveLength(1);
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Proves in-process Dolt operations wait FIFO instead of failing on overlap. */

import { toWorkItemId } from "@cogni/work-items";
import { describe, expect, it, vi } from "vitest";

import {
  DoltgresWorkItemAdapter,
  WorkItemsBusyError,
} from "../../src/adapters/doltgres/adapter.js";
import { makeFakeDoltgresSql } from "./fake-doltgres-sql.js";

const row = {
  id: "task.0001",
  type: "task",
  title: "queued",
  status: "needs_implement",
  node: "shared",
  actor: "either",
  assignees: [],
  external_refs: [],
  labels: [],
  spec_refs: [],
  revision: 1,
  deploy_verified: false,
  created_by_principal_id: "principal-1",
  claimed_by_run: "run-1",
  claim_owner_principal_id: "principal-1",
  claimed_at: "2026-10-03T00:00:00.000Z",
  claim_expires_at: "2026-10-03T00:05:00.000Z",
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
};

function makeBlockedHeartbeatAdapter(queueWaitMs?: number) {
  const queries: string[] = [];
  let releaseHeartbeat: (rows: ReadonlyArray<Record<string, unknown>>) => void =
    () => undefined;
  const heartbeatGate = new Promise<ReadonlyArray<Record<string, unknown>>>(
    (resolve) => {
      releaseHeartbeat = resolve;
    }
  );
  const sql = makeFakeDoltgresSql((query) => {
    if (query.startsWith("UPDATE work_items SET claim_expires_at = NOW()")) {
      return heartbeatGate;
    }
    if (query.includes("FROM work_items")) {
      return [{ ...row, claim_active: true }];
    }
    return [];
  }, queries);
  return {
    adapter: new DoltgresWorkItemAdapter(
      sql,
      queueWaitMs === undefined ? {} : { queueWaitMs }
    ),
    queries,
    releaseHeartbeat: () => releaseHeartbeat([{ ...row, claim_active: true }]),
  };
}

async function waitForHeartbeatDml(queries: string[]): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      queries.some((query) =>
        query.startsWith("UPDATE work_items SET claim_expires_at = NOW()")
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("heartbeat did not reach its DML gate");
}

function makeBlockedStaleHeartbeatAdapter() {
  const queries: string[] = [];
  let releasePreflight: (rows: ReadonlyArray<Record<string, unknown>>) => void =
    () => undefined;
  const preflightGate = new Promise<ReadonlyArray<Record<string, unknown>>>(
    (resolve) => {
      releasePreflight = resolve;
    }
  );
  let blockFirstExactRead = true;
  const sql = makeFakeDoltgresSql((query) => {
    if (
      blockFirstExactRead &&
      query.includes("FROM work_items") &&
      query.includes("WHERE id = 'task.0001'")
    ) {
      blockFirstExactRead = false;
      return preflightGate;
    }
    if (query.includes("FROM work_items")) {
      return [{ ...row, claim_active: true }];
    }
    return [];
  }, queries);
  return {
    adapter: new DoltgresWorkItemAdapter(sql, { queueWaitMs: 1_000 }),
    queries,
    releasePreflight: () => releasePreflight([{ ...row, claim_active: true }]),
  };
}

async function waitForExactRead(queries: string[]): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      queries.some(
        (query) =>
          query.includes("FROM work_items") &&
          query.includes("WHERE id = 'task.0001'")
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("heartbeat did not reach its stale-lease preflight");
}

describe("DoltgresWorkItemAdapter operation queue", () => {
  it("queues a concurrent read behind heartbeat and serves both", async () => {
    const { adapter, queries, releaseHeartbeat } =
      makeBlockedHeartbeatAdapter(100);
    const heartbeat = adapter.heartbeat({
      id: toWorkItemId(row.id),
      runId: "run-1",
      command: "/implement:heartbeat",
      principalId: "principal-1",
    });
    await waitForHeartbeatDml(queries);

    const list = adapter.list();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      queries.some(
        (query) =>
          query.includes("FROM work_items") && query.includes("ORDER BY")
      )
    ).toBe(false);

    releaseHeartbeat();
    await expect(heartbeat).resolves.toMatchObject({ id: "task.0001" });
    await expect(list).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "task.0001" })],
    });
  });

  it("serves 20/20 reads queued behind a cheap stale-heartbeat preflight", async () => {
    const { adapter, queries, releasePreflight } =
      makeBlockedStaleHeartbeatAdapter();
    const staleHeartbeat = adapter.heartbeat({
      id: toWorkItemId(row.id),
      runId: "stale-run",
      principalId: "principal-1",
    });
    await waitForExactRead(queries);

    const reads = Array.from({ length: 20 }, () => adapter.list());
    releasePreflight();

    await expect(staleHeartbeat).rejects.toMatchObject({
      name: "WorkItemLeaseConflictError",
    });
    const results = await Promise.all(reads);
    expect(results).toHaveLength(20);
    expect(results.every((result) => result.items.length === 1)).toBe(true);
    expect(queries.some((query) => query.includes("dolt_checkout('-b'"))).toBe(
      false
    );
    expect(
      queries.some((query) =>
        query.startsWith("UPDATE work_items SET claim_expires_at = NOW()")
      )
    ).toBe(false);
  });

  it("keeps the default queue wait bounded at 30 seconds", async () => {
    const { adapter, queries, releaseHeartbeat } =
      makeBlockedHeartbeatAdapter();
    const heartbeat = adapter.heartbeat({
      id: toWorkItemId(row.id),
      runId: "run-1",
      principalId: "principal-1",
    });
    await waitForHeartbeatDml(queries);

    vi.useFakeTimers();
    try {
      const queryCountBeforeQueuedRead = queries.length;
      let readOutcome: "pending" | "resolved" | "rejected" = "pending";
      const queuedRead = adapter.get(toWorkItemId(row.id));
      void queuedRead.then(
        () => {
          readOutcome = "resolved";
        },
        () => {
          readOutcome = "rejected";
        }
      );

      await vi.advanceTimersByTimeAsync(29_999);
      expect(readOutcome).toBe("pending");
      expect(queries).toHaveLength(queryCountBeforeQueuedRead);

      await vi.advanceTimersByTimeAsync(1);
      await expect(queuedRead).rejects.toMatchObject({
        name: "WorkItemsBusyError",
        message: "Work-item store queue wait timed out; retry shortly",
      });
    } finally {
      releaseHeartbeat();
      await heartbeat;
      vi.useRealTimers();
    }
  });

  it("returns bounded busy and skips an abandoned queue ticket", async () => {
    const { adapter, queries, releaseHeartbeat } =
      makeBlockedHeartbeatAdapter(5);
    const heartbeat = adapter.heartbeat({
      id: toWorkItemId(row.id),
      runId: "run-1",
      principalId: "principal-1",
    });
    await waitForHeartbeatDml(queries);

    const expiredWaiter = adapter.get(toWorkItemId(row.id));
    await expect(expiredWaiter).rejects.toBeInstanceOf(WorkItemsBusyError);
    const laterRead = adapter.get(toWorkItemId(row.id));
    releaseHeartbeat();
    await heartbeat;
    await expect(laterRead).resolves.toMatchObject({
      id: "task.0001",
    });
  });
});

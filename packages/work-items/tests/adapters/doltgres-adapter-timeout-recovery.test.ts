// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Proves a timed-out DOLT_MERGE acknowledgement is resolved on a recreated
 * connection without replaying the durable write or requiring a process restart.
 */

import { toWorkItemId } from "@cogni/work-items";
import type { ReservedSql, Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  DoltgresWorkItemAdapter,
  type WorkItemLogger,
  WorkItemsBusyError,
} from "../../src/adapters/doltgres/adapter.js";

type Row = Record<string, unknown>;
type Rows = ReadonlyArray<Row>;

const baseRow: Row = {
  id: "task.0001",
  type: "task",
  title: "survives timeout",
  status: "needs_implement",
  node: "shared",
  actor: "either",
  assignees: [],
  external_refs: [],
  labels: [],
  spec_refs: [],
  revision: 0,
  deploy_verified: false,
  created_by_principal_id: "principal-1",
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
};

interface TimeoutHarnessState {
  row?: Row;
  pendingRow?: Row;
  branchBefore?: Row;
  branchAfter?: Row;
  branch?: string;
  branchCommit?: string;
  durable: boolean;
  deadUnlockAttempts: number;
  inserts: number;
  commits: number;
  mainCommits: Set<string>;
  poolBuilds: number;
  queries: string[];
  commitMessage?: string;
  commitDate?: string;
  branchBase?: string;
}

function makeTimeoutHarness({
  failFreshReachability = false,
  timeoutAfterDml = false,
  timeoutFreshHousekeeping = false,
  laterMainUpdateAfterLostAck = false,
}: {
  readonly failFreshReachability?: boolean;
  readonly timeoutAfterDml?: boolean;
  readonly timeoutFreshHousekeeping?: boolean;
  readonly laterMainUpdateAfterLostAck?: boolean;
} = {}) {
  const state: TimeoutHarnessState = {
    durable: false,
    deadUnlockAttempts: 0,
    inserts: 0,
    commits: 0,
    mainCommits: new Set(["main"]),
    poolBuilds: 0,
    queries: [],
  };
  const events: string[] = [];
  const logger: WorkItemLogger = {
    info: (fields) => events.push(String(fields.event)),
    warn: (fields) => events.push(String(fields.event)),
    error: (fields) => events.push(String(fields.event)),
  };

  const buildPool = (): Sql => {
    state.poolBuilds += 1;
    const poolNumber = state.poolBuilds;
    if (poolNumber === 2 && laterMainUpdateAfterLostAck && state.row) {
      state.row = {
        ...state.row,
        title: "later serialized update",
        revision: Number(state.row.revision ?? 0) + 1,
        updated_at: "2026-10-03T00:02:00.000Z",
      };
    }
    let ended = false;
    let rejectTimedOutMerge: ((error: Error) => void) | undefined;
    let rejectTimedOutQuery: ((error: Error) => void) | undefined;
    let freshReachabilityProven = false;

    const unsafe = async (query: string): Promise<Rows> => {
      state.queries.push(`pool-${poolNumber}:${query}`);
      if (ended && query.startsWith("SELECT pg_advisory_unlock")) {
        state.deadUnlockAttempts += 1;
        return await new Promise<Rows>(() => undefined);
      }
      if (ended) {
        const error = new Error("connection ended") as Error & {
          code: string;
        };
        error.code = "CONNECTION_ENDED";
        throw error;
      }
      if (query === "SELECT 1 AS work_items_ready") {
        return [{ work_items_ready: 1 }];
      }
      if (query.startsWith("SELECT pg_try_advisory_lock")) {
        return [{ pg_try_advisory_lock: true }];
      }
      if (query.startsWith("SELECT pg_advisory_unlock")) {
        return [{ pg_advisory_unlock: true }];
      }
      if (query === "SELECT dolt_checkout('main')") {
        return [{ dolt_checkout: [0, ""] }];
      }
      if (query === "SELECT dolt_hashof('main') AS dolt_hashof") {
        return [{ dolt_hashof: "main" }];
      }
      if (query.includes("dolt_checkout('-b'")) {
        state.branch = /'(work-item-op\/[^']+)'/.exec(query)?.[1];
        state.branchCommit = undefined;
        state.branchBase = "main";
        state.branchBefore = state.row;
        state.branchAfter = undefined;
        return [{ dolt_checkout: [0, ""] }];
      }
      if (query === "SELECT table_name FROM dolt.status") {
        return [];
      }
      if (query === "SELECT name, hash FROM dolt.branches") {
        return state.branch
          ? [{ name: state.branch, hash: state.branchCommit ?? "main" }]
          : [];
      }
      if (query.includes("FROM dolt.merge_status")) return [];
      if (query === "SELECT dolt_add('work_items')") {
        if (poolNumber === 1 && timeoutAfterDml) {
          return await new Promise<Rows>((_resolve, reject) => {
            rejectTimedOutQuery = reject;
          });
        }
        return [{ dolt_add: [0, ""] }];
      }
      if (query.startsWith("SELECT dolt_commit")) {
        state.commits += 1;
        state.branchCommit = `test-commit-${state.commits}`;
        state.commitMessage =
          /SELECT dolt_commit\('-m', '(.*)'\)/.exec(query)?.[1]?.replace(/''/g, "'");
        state.commitDate =
          state.inserts === 1
            ? "2026-10-03T00:01:00.000Z"
            : "2026-10-03T00:03:00.000Z";
        return [{ dolt_commit: state.branchCommit }];
      }
      if (query.includes("FROM dolt.commits")) {
        return state.branchCommit
          ? [
              {
                commit_hash: state.branchCommit,
                message: state.commitMessage,
                date: state.commitDate,
              },
            ]
          : [];
      }
      if (query.includes("FROM dolt.commit_ancestors")) {
        return state.branchCommit
          ? [
              {
                commit_hash: state.branchCommit,
                parent_hash: state.branchBase,
                parent_index: 0,
              },
            ]
          : [];
      }
      if (query.startsWith("SELECT * FROM dolt_diff_summary")) {
        return [
          {
            from_table_name: "public.work_items",
            to_table_name: "public.work_items",
            schema_change: false,
            data_change: false,
          },
        ];
      }
      if (query.startsWith("SELECT * FROM dolt_diff(")) {
        const before = state.branchBefore;
        const after = state.branchAfter;
        return [
          {
            ...Object.fromEntries(
              Object.entries(before ?? {}).map(([key, value]) => [
                `from_${key}`,
                value,
              ])
            ),
            ...Object.fromEntries(
              Object.entries(after ?? {}).map(([key, value]) => [
                `to_${key}`,
                value,
              ])
            ),
            diff_type: before ? "modified" : "added",
          },
        ];
      }
      if (query.startsWith("SELECT dolt_merge_base")) {
        if (poolNumber === 2 && failFreshReachability) {
          const error = new Error("reachability connection ended") as Error & {
            code: string;
          };
          error.code = "CONNECTION_ENDED";
          throw error;
        }
        if (poolNumber === 2) freshReachabilityProven = true;
        const commit = /dolt_merge_base\('main', '([^']+)'\)/.exec(query)?.[1];
        return [
          {
            dolt_merge_base:
              commit && state.mainCommits.has(commit) ? commit : "main",
          },
        ];
      }
      if (query.includes("FROM dolt_merge(")) {
        state.durable = true;
        if (state.branchCommit) state.mainCommits.add(state.branchCommit);
        state.row = state.branchAfter;
        if (poolNumber === 1) {
          return await new Promise<Rows>((_resolve, reject) => {
            rejectTimedOutMerge = reject;
          });
        }
        return [
          {
            hash: "test-merge",
            fast_forward: 0,
            conflicts: 0,
            message: "ok",
          },
        ];
      }
      if (query.startsWith("SELECT dolt_branch")) {
        if (
          poolNumber === 2 &&
          timeoutFreshHousekeeping &&
          freshReachabilityProven
        ) {
          return await new Promise<Rows>((_resolve, reject) => {
            rejectTimedOutQuery = reject;
          });
        }
        if (
          state.branchCommit === undefined ||
          !state.mainCommits.has(state.branchCommit)
        ) {
          state.pendingRow = undefined;
          state.branchAfter = undefined;
        }
        state.branch = undefined;
        state.branchCommit = undefined;
        state.branchBefore = undefined;
        state.branchAfter = undefined;
        return [{ dolt_branch: [0, ""] }];
      }
      if (query.startsWith("SELECT id FROM work_items")) {
        return state.row ? [{ id: state.row.id }] : [];
      }
      if (query.startsWith("INSERT INTO work_items")) {
        state.inserts += 1;
        state.branchBefore = undefined;
        const values =
          /VALUES \('([^']+)', '([^']+)', '([^']+)'/.exec(query);
        state.pendingRow = {
          ...baseRow,
          id: values?.[1] ?? baseRow.id,
          type: values?.[2] ?? baseRow.type,
          title: values?.[3] ?? baseRow.title,
        };
        state.branchAfter = state.pendingRow;
        return [state.pendingRow];
      }
      if (query.startsWith("UPDATE work_items")) {
        state.pendingRow = {
          ...(state.row ?? baseRow),
          title: "still writable",
          revision: 1,
          updated_at: "2026-10-03T00:02:00.000Z",
        };
        state.branchAfter = state.pendingRow;
        return [state.pendingRow];
      }
      if (
        query.startsWith("SELECT * FROM work_items WHERE id") &&
        state.row
      ) {
        return [state.row];
      }
      if (query.includes("FROM work_items")) {
        return state.row ? [{ ...state.row, claim_active: false }] : [];
      }
      return [];
    };

    const reserved = {
      unsafe,
      release: () => undefined,
    } as unknown as ReservedSql;
    return {
      unsafe,
      reserve: async () => reserved,
      end: async () => {
        ended = true;
        const error = new Error("merge acknowledgement timed out") as Error & {
          code: string;
        };
        error.code = "CONNECTION_DESTROYED";
        rejectTimedOutMerge?.(error);
        rejectTimedOutQuery?.(error);
      },
    } as unknown as Sql;
  };

  const adapter = new DoltgresWorkItemAdapter(buildPool(), {
    logger,
    queryTimeoutMs: 5,
    reserveTimeoutMs: 100,
    recreateClient: buildPool,
  });
  return { adapter, events, state };
}

async function within<T>(promise: Promise<T>, milliseconds = 100): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("test operation timed out")), milliseconds);
    }),
  ]);
}

describe("DoltgresWorkItemAdapter merge timeout recovery", () => {
  it("proves the durable merge on a fresh connection and keeps serving", async () => {
    const { adapter, events, state } = makeTimeoutHarness();

    const created = await adapter.create(
      { type: "task", title: "survives timeout" },
      "principal-1"
    );
    expect(created.id).toBe("task.0001");
    expect(state.inserts).toBe(1);
    expect(state.poolBuilds).toBe(2);
    expect(
      state.queries.some((query) =>
        query.startsWith("pool-2:SELECT dolt_merge_base")
      )
    ).toBe(true);
    expect(events).toContain("adapter.work_items.stage_complete");

    await expect(adapter.get(toWorkItemId("task.0001"))).resolves.toMatchObject(
      { title: "survives timeout" }
    );
    await expect(
      adapter.patch(
        {
          id: toWorkItemId("task.0001"),
          set: { title: "still writable" },
        },
        "principal-1"
      )
    ).resolves.toMatchObject({ title: "still writable" });
    expect(state.inserts).toBe(1);
  });

  it("uses historical proof after merge ACK loss even when a later commit changed the row", async () => {
    const { adapter, state } = makeTimeoutHarness({
      laterMainUpdateAfterLostAck: true,
    });

    await expect(
      adapter.create(
        { type: "task", title: "survives timeout" },
        "principal-1"
      )
    ).resolves.toMatchObject({
      id: "task.0001",
      title: "survives timeout",
    });

    expect(state.inserts).toBe(1);
    await expect(adapter.get(toWorkItemId("task.0001"))).resolves.toMatchObject({
      title: "later serialized update",
      revision: 1,
    });
  });

  it("releases the queue after a post-DML timeout destroys the locked connection", async () => {
    const { adapter, state } = makeTimeoutHarness({ timeoutAfterDml: true });

    await expect(
      within(
        adapter.create(
          { type: "task", title: "times out after DML" },
          "principal-1"
        )
      )
    ).rejects.toBeInstanceOf(WorkItemsBusyError);

    expect(state.inserts).toBe(1);
    expect(state.poolBuilds).toBe(2);
    expect(state.deadUnlockAttempts).toBe(0);
    await expect(within(adapter.get(toWorkItemId("task.0001")))).resolves.toBe(
      null
    );
    await expect(within(adapter.list())).resolves.toMatchObject({ items: [] });
    await expect(
      within(
        adapter.create(
          { type: "task", title: "successor create" },
          "principal-1"
        )
      )
    ).resolves.toMatchObject({ id: "task.0001" });
    expect(state.inserts).toBe(2);
    expect(state.deadUnlockAttempts).toBe(0);
  });

  it("preserves a reachable ref when fresh cleanup times out, then heals it", async () => {
    const { adapter, state } = makeTimeoutHarness({
      timeoutFreshHousekeeping: true,
    });

    await expect(
      within(
        adapter.create(
          { type: "task", title: "nested recovery" },
          "principal-1"
        )
      )
    ).resolves.toMatchObject({ id: "task.0001" });

    expect(state.inserts).toBe(1);
    expect(state.poolBuilds).toBe(3);
    expect(state.deadUnlockAttempts).toBe(0);
    await expect(
      within(adapter.get(toWorkItemId("task.0001")))
    ).resolves.toMatchObject({ id: "task.0001" });
    await expect(within(adapter.list())).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "task.0001" })],
    });
    await expect(
      within(
        adapter.create(
          { type: "bug", title: "successor create" },
          "principal-1"
        )
      )
    ).resolves.toMatchObject({ id: "bug.0001" });
    expect(state.inserts).toBe(2);
    expect(state.deadUnlockAttempts).toBe(0);
  });

  it("preserves evidence on a fresh proof failure and retries on the next request", async () => {
    const { adapter, events, state } = makeTimeoutHarness({
      failFreshReachability: true,
    });

    await expect(
      adapter.create(
        { type: "task", title: "ambiguous durable merge" },
        "principal-1"
      )
    ).rejects.toBeInstanceOf(WorkItemsBusyError);

    expect(state.durable).toBe(true);
    expect(state.inserts).toBe(1);
    expect(state.poolBuilds).toBe(3);
    expect(state.branch).toMatch(/^work-item-op\//);
    expect(events).toContain("adapter.work_items.reconcile");

    await expect(adapter.get(toWorkItemId("task.0001"))).resolves.toMatchObject({
      id: "task.0001",
    });
    expect(state.inserts).toBe(1);
    expect(state.branch).toBeUndefined();
    expect(
      state.queries.some((query) =>
        query.startsWith("pool-3:SELECT dolt_branch")
      )
    ).toBe(true);
  });
});

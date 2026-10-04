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
  branch?: string;
  durable: boolean;
  inserts: number;
  poolBuilds: number;
  queries: string[];
}

function makeTimeoutHarness({
  failFreshReachability = false,
}: {
  readonly failFreshReachability?: boolean;
} = {}) {
  const state: TimeoutHarnessState = {
    durable: false,
    inserts: 0,
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
    let ended = false;
    let rejectTimedOutMerge: ((error: Error) => void) | undefined;

    const unsafe = async (query: string): Promise<Rows> => {
      state.queries.push(`pool-${poolNumber}:${query}`);
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
      if (query.includes("dolt_checkout('-b'")) {
        state.branch = /'(work-item-op\/[^']+)'/.exec(query)?.[1];
        return [{ dolt_checkout: [0, ""] }];
      }
      if (query === "SELECT table_name FROM dolt.status") return [];
      if (query === "SELECT name, hash FROM dolt.branches") {
        return state.branch
          ? [{ name: state.branch, hash: "test-commit" }]
          : [];
      }
      if (query.includes("FROM dolt.merge_status")) return [];
      if (query === "SELECT dolt_add('work_items')") {
        return [{ dolt_add: [0, ""] }];
      }
      if (query.startsWith("SELECT dolt_commit")) {
        return [{ dolt_commit: "test-commit" }];
      }
      if (query.startsWith("SELECT dolt_merge_base")) {
        if (poolNumber === 2 && failFreshReachability) {
          const error = new Error("reachability connection ended") as Error & {
            code: string;
          };
          error.code = "CONNECTION_ENDED";
          throw error;
        }
        return [{ dolt_merge_base: state.durable ? "test-commit" : "main" }];
      }
      if (query.startsWith("SELECT dolt_merge(")) {
        state.durable = true;
        if (poolNumber === 1) {
          return await new Promise<Rows>((_resolve, reject) => {
            rejectTimedOutMerge = reject;
          });
        }
        return [{ dolt_merge: ["test-merge", 0, 0, "ok"] }];
      }
      if (query.startsWith("SELECT dolt_branch")) {
        state.branch = undefined;
        return [{ dolt_branch: [0, ""] }];
      }
      if (query.startsWith("SELECT id FROM work_items")) {
        return state.row ? [{ id: state.row.id }] : [];
      }
      if (query.startsWith("INSERT INTO work_items")) {
        state.inserts += 1;
        state.row = { ...baseRow };
        return [state.row];
      }
      if (query.startsWith("UPDATE work_items")) {
        state.row = {
          ...(state.row ?? baseRow),
          title: "still writable",
          revision: 1,
        };
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

  it("stays fail-closed and preserves evidence when fresh proof also fails", async () => {
    const { adapter, events, state } = makeTimeoutHarness({
      failFreshReachability: true,
    });

    await expect(
      adapter.create(
        { type: "task", title: "ambiguous durable merge" },
        "principal-1"
      )
    ).rejects.toMatchObject({ name: "DoltMergeOutcomeUnknownError" });

    expect(state.durable).toBe(true);
    expect(state.inserts).toBe(1);
    expect(state.poolBuilds).toBe(3);
    expect(state.branch).toMatch(/^work-item-op\//);
    expect(events).toContain("adapter.work_items.merge_outcome_unknown");

    const queriesBeforeBlockedRequests = state.queries.length;
    await expect(adapter.get(toWorkItemId("task.0001"))).rejects.toBeInstanceOf(
      WorkItemsBusyError
    );
    await expect(
      adapter.create({ type: "task", title: "must not replay" }, "principal-1")
    ).rejects.toBeInstanceOf(WorkItemsBusyError);

    expect(state.queries).toHaveLength(queriesBeforeBlockedRequests);
    expect(state.inserts).toBe(1);
    expect(state.branch).toMatch(/^work-item-op\//);
    expect(
      state.queries.some((query) =>
        query.startsWith("pool-3:SELECT dolt_branch")
      )
    ).toBe(false);
  });
});

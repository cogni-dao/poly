// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Proves restart reconciliation preserves unproven operation branches. */

import { toWorkItemId } from "@cogni/work-items";
import type { ReservedSql, Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  DoltgresWorkItemAdapter,
  WorkItemsBusyError,
} from "../../src/adapters/doltgres/adapter.js";

type Rows = ReadonlyArray<Record<string, unknown>>;

interface ReconciliationState {
  branch?: string;
  readonly branchCommit?: string;
  readonly mergeBase: string;
  readonly listError?: Error;
  readonly proofError?: Error;
  readonly queries: string[];
  merged: boolean;
}

const recoveredRow = {
  id: "task.0001",
  type: "task",
  title: "restart evidence",
  status: "needs_implement",
  node: "shared",
  revision: 0,
  created_by_principal_id: "principal-1",
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
  claimed_by_run: null,
  claimed_at: null,
  claim_owner_principal_id: null,
  claim_expires_at: null,
};

function makeReconciliationHarness({
  branchCommit = "operation-commit",
  mergeBase,
  listError,
  omitBranchCommit = false,
  proofError,
}: {
  readonly branchCommit?: string;
  readonly mergeBase: string;
  readonly listError?: Error;
  readonly omitBranchCommit?: boolean;
  readonly proofError?: Error;
}) {
  const state: ReconciliationState = {
    branch: "work-item-op/restart-evidence",
    branchCommit: omitBranchCommit ? undefined : branchCommit,
    mergeBase,
    listError,
    proofError,
    queries: [],
    merged: false,
  };

  const unsafe = async (query: string): Promise<Rows> => {
    state.queries.push(query);
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
    if (query.includes("FROM dolt.merge_status")) return [];
    if (query === "SELECT table_name FROM dolt.status") return [];
    if (query === "SELECT dolt_hashof('main') AS dolt_hashof") {
      return [{ dolt_hashof: "current-main" }];
    }
    if (query === "SELECT name, hash FROM dolt.branches") {
      if (state.listError) throw state.listError;
      return state.branch
        ? [{ name: state.branch, hash: state.branchCommit }]
        : [];
    }
    if (query.startsWith("SELECT dolt_merge_base")) {
      if (state.proofError) throw state.proofError;
      return [
        {
          dolt_merge_base: state.merged
            ? state.branchCommit
            : state.mergeBase,
        },
      ];
    }
    if (query.includes("FROM dolt.commits")) {
      return [
        {
          commit_hash: state.branchCommit,
          message: "work-items: create work item by actor:principal-1",
          date: "2026-10-03T00:01:00.000Z",
        },
      ];
    }
    if (query.includes("FROM dolt.commit_ancestors")) {
      return [
        {
          commit_hash: state.branchCommit,
          parent_hash: "main-parent",
          parent_index: 0,
        },
      ];
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
      return [
        {
          ...Object.fromEntries(
            Object.entries(recoveredRow).map(([key, value]) => [
              `to_${key}`,
              value,
            ])
          ),
          diff_type: "added",
        },
      ];
    }
    if (query.includes("FROM dolt_merge(")) {
      state.merged = true;
      return [
        { hash: "merge-commit", fast_forward: 0, conflicts: 0, message: "ok" },
      ];
    }
    if (query.startsWith("SELECT dolt_branch('-D'")) {
      state.branch = undefined;
      return [{ dolt_branch: [0, ""] }];
    }
    if (query.startsWith("SELECT * FROM work_items WHERE id = 'task.0001'")) {
      return state.merged ? [recoveredRow] : [];
    }
    if (query.includes("FROM work_items")) return [];
    return [];
  };

  const reserved = {
    unsafe,
    release: () => undefined,
  } as unknown as ReservedSql;
  const sql = {
    unsafe,
    reserve: async () => reserved,
    end: async () => undefined,
  } as unknown as Sql;

  return { adapter: new DoltgresWorkItemAdapter(sql), state };
}

describe("DoltgresWorkItemAdapter restart reconciliation", () => {
  it("deletes a restart-time empty branch only when its tip equals current main", async () => {
    const { adapter, state } = makeReconciliationHarness({
      branchCommit: "current-main",
      mergeBase: "current-main",
    });

    await expect(
      adapter.get(toWorkItemId("task.missing"))
    ).resolves.toBeNull();

    expect(state.branch).toBeUndefined();
    expect(
      state.queries.some((query) => query.includes("FROM dolt.commits"))
    ).toBe(false);
  });

  it("deletes a stale operation branch only after its tip is proven on main", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
    });

    await expect(
      adapter.get(toWorkItemId("task.missing"))
    ).resolves.toBeNull();

    expect(state.branch).toBeUndefined();
    expect(state.queries).toContain(
      "SELECT dolt_merge_base('main', 'operation-commit') AS dolt_merge_base"
    );
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(true);
  });

  it("merges and verifies a valid operation branch whose tip is not yet on main", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "main-commit",
    });

    await expect(
      adapter.get(toWorkItemId("task.missing"))
    ).resolves.toBeNull();

    expect(state.branch).toBeUndefined();
    expect(
      state.queries.some((query) => query.includes("FROM dolt_merge("))
    ).toBe(true);
    expect(
      state.queries.some((query) => query.includes("FROM work_items"))
    ).toBe(true);
  });

  it("preserves evidence and fails busy when the reachability proof errors", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      proofError: new Error("proof query failed"),
    });

    await expect(
      adapter.get(toWorkItemId("task.missing"))
    ).rejects.toBeInstanceOf(WorkItemsBusyError);

    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
    expect(
      state.queries.some((query) => query.includes("FROM work_items"))
    ).toBe(false);
  });

  it("preserves evidence and fails busy when the branch lookup errors", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      listError: new Error("branch lookup failed"),
    });

    await expect(
      adapter.get(toWorkItemId("task.missing"))
    ).rejects.toBeInstanceOf(WorkItemsBusyError);

    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
    expect(
      state.queries.some((query) => query.includes("FROM work_items"))
    ).toBe(false);
  });

  it("preserves evidence and fails busy when the branch tip is missing", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      omitBranchCommit: true,
    });

    await expect(
      adapter.get(toWorkItemId("task.missing"))
    ).rejects.toBeInstanceOf(WorkItemsBusyError);

    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_merge_base"))
    ).toBe(false);
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
    expect(
      state.queries.some((query) => query.includes("FROM work_items"))
    ).toBe(false);
  });
});

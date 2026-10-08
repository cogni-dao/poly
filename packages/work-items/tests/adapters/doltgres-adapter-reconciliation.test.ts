// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Proves restart reconciliation preserves unproven operation branches, and that
 * an unprovable branch fails writes closed without taking reads down (bug.5358).
 */

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
  readonly deleteError?: Error;
  readonly deleteLeavesRef?: boolean;
  extraBranch?: string;
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
  withProvableSibling = false,
  deleteError,
  deleteLeavesRef = false,
}: {
  readonly branchCommit?: string;
  readonly mergeBase: string;
  readonly listError?: Error;
  readonly omitBranchCommit?: boolean;
  readonly proofError?: Error;
  /** A second branch, sorted after the first, whose tip is already main. */
  readonly withProvableSibling?: boolean;
  /** `dolt_branch('-D', ...)` throws — e.g. the query deadline fired. */
  readonly deleteError?: Error;
  /** With `deleteError`, the ref survives: the delete genuinely did not land. */
  readonly deleteLeavesRef?: boolean;
}) {
  const state: ReconciliationState = {
    branch: "work-item-op/restart-evidence",
    extraBranch: withProvableSibling ? "work-item-op/zz-sibling" : undefined,
    deleteError,
    deleteLeavesRef,
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
      const rows: Array<Record<string, unknown>> = [];
      if (state.branch)
        rows.push({ name: state.branch, hash: state.branchCommit });
      // Tip already equals current main, so the sweep can delete it outright.
      if (state.extraBranch)
        rows.push({ name: state.extraBranch, hash: "current-main" });
      return rows;
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
      const deleted = /'(work-item-op\/[^']+)'/.exec(query)?.[1];
      if (state.deleteError) {
        // Doltgres applied the delete durably unless the fixture says the ref
        // survived; either way the acknowledgement is lost.
        if (!state.deleteLeavesRef) {
          if (deleted === state.extraBranch) state.extraBranch = undefined;
          else state.branch = undefined;
        }
        throw state.deleteError;
      }
      if (deleted === state.extraBranch) state.extraBranch = undefined;
      else state.branch = undefined;
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

  const logs: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const record =
    (level: string) => (fields: Record<string, unknown>, _message: string) =>
      void logs.push({ level, fields });
  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
  return {
    adapter: new DoltgresWorkItemAdapter(sql, { logger }),
    state,
    logs,
  };
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

  it("deletes a redundant restart branch once its old-main tip is proven reachable", async () => {
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

  it("preserves evidence and fails a write busy when the reachability proof errors", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      proofError: new Error("proof query failed"),
    });

    await expect(
      adapter.patch(
        { id: toWorkItemId("task.missing"), set: { title: "blocked" } },
        "principal-1"
      )
    ).rejects.toBeInstanceOf(WorkItemsBusyError);

    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
    expect(
      state.queries.some((query) => query.includes("FROM work_items"))
    ).toBe(false);
  });

  it("serves a read when a branch cannot be proven, keeping the evidence", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      proofError: new Error("proof query failed"),
    });

    await expect(
      adapter.get(toWorkItemId("task.missing"))
    ).resolves.toBeNull();

    // Evidence is preserved, but it is no longer on the read path (bug.5358).
    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
    expect(
      state.queries.some((query) => query.includes("FROM work_items"))
    ).toBe(true);
  });

  it("serves a read when the branch tip is missing, keeping the evidence", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      omitBranchCommit: true,
    });

    await expect(
      adapter.get(toWorkItemId("task.missing"))
    ).resolves.toBeNull();

    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
    expect(
      state.queries.some((query) => query.includes("FROM work_items"))
    ).toBe(true);
  });

  it("re-proves main is safe before serving a read past unprovable evidence", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      proofError: new Error("proof query failed"),
    });

    await expect(
      adapter.get(toWorkItemId("task.missing"))
    ).resolves.toBeNull();

    // One checkout makes main safe up front; a second re-proves it after the
    // tolerated failure, so the read never runs on a half-reconciled session.
    expect(
      state.queries.filter((query) => query === "SELECT dolt_checkout('main')")
        .length
    ).toBeGreaterThanOrEqual(2);
  });

  it("records a served read as handled degradation, never as an error", async () => {
    // `omitBranchCommit` fails the branch proof without failing a query, which
    // is the production signature: poly's wedged reads log no stage_error, only
    // the reconciliation verdict.
    const { adapter, logs } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      omitBranchCommit: true,
    });

    await expect(
      adapter.get(toWorkItemId("task.missing"))
    ).resolves.toBeNull();

    // The request SUCCEEDED. Any error level would make every healthy read on a
    // node carrying residual evidence look like an outage.
    expect(logs.filter((entry) => entry.level === "error")).toEqual([]);
    const preserved = logs.filter(
      (entry) => entry.fields.classification === "preserved_unsafe"
    );
    expect(preserved).toHaveLength(1);
    expect(preserved[0]?.level).toBe("warn");
    // Vocabulary is unchanged, so existing `preserved_unsafe` queries still
    // match; `served` is what distinguishes the tolerated read.
    expect(preserved[0]?.fields.served).toBe(true);
    expect(preserved[0]?.fields.branch).toBe("work-item-op/restart-evidence");
  });

  it("records an unprovable branch as an error when a write fails closed", async () => {
    const { adapter, logs } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      omitBranchCommit: true,
    });

    await expect(
      adapter.patch(
        { id: toWorkItemId("task.missing"), set: { title: "blocked" } },
        "principal-1"
      )
    ).rejects.toBeInstanceOf(WorkItemsBusyError);

    const preserved = logs.filter(
      (entry) => entry.fields.classification === "preserved_unsafe"
    );
    expect(preserved).toHaveLength(1);
    expect(preserved[0]?.level).toBe("error");
    expect(preserved[0]?.fields.served).toBeUndefined();
  });

  it("still reconciles a provable sibling after tolerating an unprovable branch", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      proofError: new Error("proof query failed"),
      withProvableSibling: true,
    });

    await expect(
      adapter.get(toWorkItemId("task.missing"))
    ).resolves.toBeNull();

    // The unprovable branch is kept as evidence; the sweep does not stop there,
    // so a sibling that only needed its merge finished is still resolved.
    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(state.extraBranch).toBeUndefined();
  });

  it("treats a lost delete acknowledgement as cleaned when the ref is gone", async () => {
    const { adapter, state, logs } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      deleteError: new Error(
        "Work-item store timed out during branch.delete; retry shortly"
      ),
    });

    await expect(
      adapter.get(toWorkItemId("task.missing"))
    ).resolves.toBeNull();

    // Doltgres applied the delete and lost the ack to the query deadline — the
    // bug.5358 shape one layer down. Reporting that as pending would send an
    // operator chasing a ref that is already gone.
    expect(state.branch).toBeUndefined();
    const verdicts = logs.filter((e) =>
      String(e.fields.classification ?? "").startsWith("reachable_redundant")
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.fields.classification).toBe(
      "reachable_redundant_cleaned"
    );
    expect(logs.some((e) => e.fields.deleteAckLost === true)).toBe(true);
    // The injected failure IS a real query error, so a `stage_error` is correct
    // here. This test asserts the reconciliation VERDICT, not query-level
    // logging; the served-read tests cover the verdict's level.
  });

  it("keeps a delete pending when the ref really survived", async () => {
    const { adapter, state, logs } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      deleteError: new Error(
        "Work-item store timed out during branch.delete; retry shortly"
      ),
      deleteLeavesRef: true,
    });

    await expect(
      adapter.get(toWorkItemId("task.missing"))
    ).resolves.toBeNull();

    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(
      logs.some(
        (e) =>
          e.fields.classification === "reachable_redundant_cleanup_pending"
      )
    ).toBe(true);
    expect(logs.some((e) => e.fields.deleteAckLost === true)).toBe(false);
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

  it("preserves evidence and fails a write busy when the branch tip is missing", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      omitBranchCommit: true,
    });

    await expect(
      adapter.patch(
        { id: toWorkItemId("task.missing"), set: { title: "blocked" } },
        "principal-1"
      )
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

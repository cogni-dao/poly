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
}

function makeReconciliationHarness({
  mergeBase,
  listError,
  omitBranchCommit = false,
  proofError,
}: {
  readonly mergeBase: string;
  readonly listError?: Error;
  readonly omitBranchCommit?: boolean;
  readonly proofError?: Error;
}) {
  const state: ReconciliationState = {
    branch: "work-item-op/restart-evidence",
    branchCommit: omitBranchCommit ? undefined : "operation-commit",
    mergeBase,
    listError,
    proofError,
    queries: [],
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
    if (query === "SELECT name, hash FROM dolt.branches") {
      if (state.listError) throw state.listError;
      return state.branch
        ? [{ name: state.branch, hash: state.branchCommit }]
        : [];
    }
    if (query.startsWith("SELECT dolt_merge_base")) {
      if (state.proofError) throw state.proofError;
      return [{ dolt_merge_base: state.mergeBase }];
    }
    if (query.startsWith("SELECT dolt_branch('-D'")) {
      state.branch = undefined;
      return [{ dolt_branch: [0, ""] }];
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

  it("preserves an operation branch whose tip is not reachable from main", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "main-commit",
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

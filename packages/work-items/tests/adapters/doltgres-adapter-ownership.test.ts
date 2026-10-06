// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { toWorkItemId } from "@cogni/work-items";
import { describe, expect, it } from "vitest";

import { DoltgresWorkItemAdapter } from "../../src/adapters/doltgres/adapter.js";
import { makeFakeDoltgresSql } from "./fake-doltgres-sql.js";

const row = {
  id: "task.0001",
  type: "task",
  title: "owned",
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
  claim_expires_at: "2099-10-02T00:05:00.000Z",
  created_at: "2026-10-02T00:00:00.000Z",
  updated_at: "2026-10-02T00:00:00.000Z",
};

function adapterWithQueries() {
  const queries: string[] = [];
  const sql = makeFakeDoltgresSql((query) => {
    if (query.startsWith("SELECT id FROM work_items")) return [];
    if (query.startsWith("INSERT INTO work_items")) return [row];
    if (query.startsWith("UPDATE work_items")) {
      return [
        {
          ...row,
          title: /title = '([^']*)'/.exec(query)?.[1] ?? row.title,
          claim_active: query.includes("claim_expires_at"),
        },
      ];
    }
    if (query.startsWith("DELETE FROM work_items")) return [{ id: row.id }];
    if (query.includes("FROM work_items")) return [row];
    return [];
  }, queries);
  return { adapter: new DoltgresWorkItemAdapter(sql), queries };
}

function adapterWithCoarseCommitDate() {
  const queries: string[] = [];
  const sql = makeFakeDoltgresSql((query) => {
    if (query.startsWith("UPDATE work_items")) {
      return [{ ...row, claim_active: true }];
    }
    if (query.includes("FROM work_items")) return [row];
    return [];
  }, queries, {
    commitDate: "2026-10-02T00:01:00.000Z",
    claimClaimedAt: "2026-10-02T00:01:00.900Z",
    claimExpiresAt: "2026-10-02T00:06:00.000Z",
  });
  return { adapter: new DoltgresWorkItemAdapter(sql), queries };
}

describe("DoltgresWorkItemAdapter ownership and leases", () => {
  it("stamps the immutable session principal on create", async () => {
    const { adapter, queries } = adapterWithQueries();
    await adapter.create(
      { type: "task", title: "owned", status: "needs_implement" },
      "principal-1"
    );

    const insert = queries.find((query) =>
      query.startsWith("INSERT INTO work_items")
    );
    expect(insert).toContain("created_by_principal_id");
    expect(insert).toContain("'principal-1'");
  });

  it("owner-scopes patch and increments revision", async () => {
    const { adapter, queries } = adapterWithQueries();
    await adapter.patch(
      { id: toWorkItemId(row.id), set: { title: "renamed" } },
      "principal-1"
    );

    const update = queries.find((query) =>
      query.startsWith("UPDATE work_items SET title")
    );
    expect(update).toContain("revision = revision + 1");
    expect(update).toContain("created_by_principal_id = 'principal-1'");
  });

  it("binds claims and heartbeats to principal plus run", async () => {
    const { adapter, queries } = adapterWithQueries();
    await adapter.claim({
      id: toWorkItemId(row.id),
      runId: "run-1",
      command: "implement",
      principalId: "principal-1",
    });
    await adapter.heartbeat({
      id: toWorkItemId(row.id),
      runId: "run-1",
      principalId: "principal-1",
    });

    const claim = queries.find((query) =>
      query.includes("SET claimed_by_run = 'run-1'")
    );
    const heartbeat = queries.find((query) =>
      query.includes("SET claim_expires_at = NOW()")
    );
    expect(claim).toContain("claim_owner_principal_id = 'principal-1'");
    expect(heartbeat).toContain(
      "claim_owner_principal_id = 'principal-1' AND claimed_by_run = 'run-1'"
    );
  });

  it("accepts a claim in the same second as a coarse Dolt commit date", async () => {
    const { adapter } = adapterWithCoarseCommitDate();

    await expect(
      adapter.claim({
        id: toWorkItemId(row.id),
        runId: "run-1",
        command: "implement",
        principalId: "principal-1",
      })
    ).resolves.toMatchObject({ claimedByRun: "run-1" });
  });

  it("rejects a stale heartbeat before creating an operation branch", async () => {
    const { adapter, queries } = adapterWithQueries();

    await expect(
      adapter.heartbeat({
        id: toWorkItemId(row.id),
        runId: "stale-run",
        principalId: "principal-1",
      })
    ).rejects.toMatchObject({ name: "WorkItemLeaseConflictError" });

    expect(queries.some((query) => query.includes("dolt_checkout('-b'"))).toBe(
      false
    );
    expect(
      queries.some((query) =>
        query.startsWith("UPDATE work_items SET claim_expires_at")
      )
    ).toBe(false);
  });

  it("rejects an unauthorized patch before branch creation and DML", async () => {
    const { adapter, queries } = adapterWithQueries();

    await expect(
      adapter.patch(
        { id: toWorkItemId(row.id), set: { title: "not yours" } },
        "principal-2"
      )
    ).rejects.toMatchObject({ name: "WorkItemAuthorizationError" });

    expect(queries.some((query) => query.includes("dolt_checkout('-b'"))).toBe(
      false
    );
    expect(
      queries.some((query) => query.startsWith("UPDATE work_items SET title"))
    ).toBe(false);
  });

  it("rejects a conflicting claim before branch creation and DML", async () => {
    const { adapter, queries } = adapterWithQueries();

    await expect(
      adapter.claim({
        id: toWorkItemId(row.id),
        runId: "stale-run",
        command: "/implement",
        principalId: "principal-1",
      })
    ).rejects.toMatchObject({ name: "WorkItemLeaseConflictError" });

    expect(queries.some((query) => query.includes("dolt_checkout('-b'"))).toBe(
      false
    );
    expect(
      queries.some((query) =>
        query.startsWith("UPDATE work_items SET claimed_by_run")
      )
    ).toBe(false);
  });

  it("rejects a stale release before branch creation and DML", async () => {
    const { adapter, queries } = adapterWithQueries();

    await expect(
      adapter.release({
        id: toWorkItemId(row.id),
        runId: "stale-run",
        principalId: "principal-1",
      })
    ).rejects.toMatchObject({ name: "WorkItemLeaseConflictError" });

    expect(queries.some((query) => query.includes("dolt_checkout('-b'"))).toBe(
      false
    );
    expect(
      queries.some((query) =>
        query.startsWith("UPDATE work_items SET claimed_by_run = NULL")
      )
    ).toBe(false);
  });
});

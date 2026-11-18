// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/work-items-cites-wiring`
 * Purpose: Prove the REAL `DoltgresPolyWorkItemAdapter` over the REAL published content adapter enforces cites (task.0086).
 * Scope: Builds the adapter with the options `container.ts` passes (`recreateClient`, `legacyClient`, `entryResolver`); only the SQL pool and the resolver are fakes. No database, no containers.
 * Invariants:
 *   - CITES_REACH_THE_ENFORCER: a patch carrying cites calls the resolver (rule "cite") with those refs; an unresolved id rejects before any UPDATE or commit.
 *   - NO_RESOLVER_NO_CITES: with no resolver wired, a patch with cites rejects with CitesUnsupportedError before any statement.
 *   - ONE_PACKAGE_COPY: the content adapter is the published 0.9.0 (it has `requireCites`), not an older copy.
 * Side-effects: none
 * Links: src/adapters/server/db/doltgres/work-items-adapter.ts, src/bootstrap/container.ts
 * @internal
 */

import { EntryUnresolvedError } from "@cogni/work-items";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { DoltgresPolyWorkItemAdapter } from "@/adapters/server/db/doltgres/work-items-adapter";
import { makeFakeDoltgresSql } from "../../_fakes/fake-doltgres-sql";

const ROW = {
  id: "task.5004",
  type: "task",
  title: "t",
  status: "needs_implement",
  node: "poly",
  actor: "either",
  assignees: [],
  external_refs: [],
  labels: [],
  spec_refs: [],
  revision: 0,
  deploy_verified: false,
  created_by_principal_id: "test",
  created_at: "2026-05-01",
  updated_at: "2026-05-01",
};

function build(entryResolver?: { resolve: (...args: unknown[]) => unknown }) {
  const queries: string[] = [];
  const respond = (q: string) => {
    if (q.startsWith("UPDATE work_items")) return [{ ...ROW, title: "changed" }];
    if (q.includes("FROM work_items")) return [{ ...ROW }];
    return [];
  };
  const pool = () => makeFakeDoltgresSql(respond, queries) as Sql;
  // The options container.ts passes to the Poly wrapper.
  const adapter = new DoltgresPolyWorkItemAdapter(pool(), undefined, {
    recreateClient: pool,
    legacyClient: pool(),
    ...(entryResolver ? { entryResolver: entryResolver as never } : {}),
  });
  return { adapter, queries };
}

const input = {
  id: "task.5004",
  reason: "test change",
  cites: [{ id: "no-such-atom-0086" }],
  set: { title: "changed" },
} as never;

describe("DoltgresPolyWorkItemAdapter cites enforcement (task.0086)", () => {
  it("calls the resolver with the cites and writes nothing when one is unresolved", async () => {
    const resolve = vi.fn().mockRejectedValue(new EntryUnresolvedError(["no-such-atom-0086"]));
    const { adapter, queries } = build({ resolve });

    await expect(adapter.patch(input, "agent-1")).rejects.toMatchObject({
      name: "EntryUnresolvedError",
      ids: ["no-such-atom-0086"],
    });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toEqual([{ id: "no-such-atom-0086" }]);
    expect(resolve.mock.calls[0]?.[1]).toBe("cite");
    expect(queries.some((q) => q.startsWith("UPDATE work_items"))).toBe(false);
    expect(queries.some((q) => q.startsWith("SELECT dolt_commit"))).toBe(false);
  });

  it("rejects cites with CitesUnsupportedError before any statement when no resolver is wired", async () => {
    const { adapter, queries } = build();

    await expect(adapter.patch(input, "agent-1")).rejects.toMatchObject({
      name: "CitesUnsupportedError",
    });
    expect(queries).toEqual([]);
  });

  it("pins resolved cites into the commit message", async () => {
    const hash = "0123456789abcdefghijklmnopqrstuv";
    const resolve = vi
      .fn()
      .mockResolvedValue([{ id: "no-such-atom-0086", commit: hash, plane: "main" }]);
    const { adapter, queries } = build({ resolve });

    await adapter.patch(input, "agent-1").catch(() => undefined);

    expect(resolve).toHaveBeenCalledTimes(1);
    const commit = queries.find((q) => q.startsWith("SELECT dolt_commit"));
    expect(commit).toContain("Cites: ");
    expect(commit).toContain("no-such-atom-0086");
    expect(commit).toContain("test change");
  });
});

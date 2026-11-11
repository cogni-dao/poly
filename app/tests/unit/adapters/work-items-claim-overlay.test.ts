// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/work-items-claim-overlay`
 * Purpose: Prove Poly's legacy claim overlay is bounded to the page it decorates (task.0056).
 * Scope: `DoltgresPolyWorkItemAdapter` with both immutable adapters stubbed; no database.
 * Invariants:
 *   - BOUNDED_CLAIM_OVERLAY: `list` re-reads only the page's ids (limit = page length); summary and board reads never touch the legacy adapter.
 * Side-effects: none
 * Links: src/adapters/server/db/doltgres/work-items-adapter.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const content = {
  get: vi.fn(),
  patch: vi.fn(),
  list: vi.fn(),
  listSummaries: vi.fn(),
  listBoardColumns: vi.fn(),
};
const legacy = { get: vi.fn(), list: vi.fn(), patch: vi.fn() };

vi.mock("@cogni/work-items/adapters/doltgres", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DoltgresWorkItemAdapter: vi.fn(function ContentAdapter() {
    return content;
  }),
}));
vi.mock("@cogni/legacy-work-items/adapters/doltgres", () => ({
  DoltgresWorkItemAdapter: vi.fn(function LegacyAdapter() {
    return legacy;
  }),
}));

import { DoltgresWorkItemAdapter } from "@cogni/work-items/adapters/doltgres";
import { DoltgresPolyWorkItemAdapter } from "@/adapters/server/db/doltgres/work-items-adapter";

const item = (id: string) => ({ id, title: id, type: "task", status: "needs_implement" });

describe("DoltgresPolyWorkItemAdapter claim overlay (task.0056)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-reads exactly the page's ids, never a fixed 500-row window", async () => {
    content.list.mockResolvedValue({
      items: [item("task.5001"), item("task.5002")],
      pageInfo: { endCursor: null, hasMore: false },
    });
    legacy.list.mockResolvedValue({
      items: [{ ...item("task.5001"), claimedByRun: "run-1" }],
    });
    const adapter = new DoltgresPolyWorkItemAdapter({} as never);

    const page = await adapter.list({ limit: 2 });

    expect(legacy.list).toHaveBeenCalledTimes(1);
    expect(legacy.list).toHaveBeenCalledWith({
      ids: ["task.5001", "task.5002"],
      limit: 2,
    });
    expect(page.items[0]).toMatchObject({ id: "task.5001", claimedByRun: "run-1" });
    expect(page.items[1]).not.toHaveProperty("claimedByRun");
  });

  it("skips the overlay for an empty page", async () => {
    content.list.mockResolvedValue({
      items: [],
      pageInfo: { endCursor: null, hasMore: false },
    });
    await new DoltgresPolyWorkItemAdapter({} as never).list({ limit: 25 });
    expect(legacy.list).not.toHaveBeenCalled();
  });

  it("forwards summary and board reads with their bounds and never reads claims", async () => {
    const adapter = new DoltgresPolyWorkItemAdapter({} as never);
    const signal = new AbortController().signal;
    content.listSummaries.mockResolvedValue({ items: [], pageInfo: { endCursor: null, hasMore: false } });
    content.listBoardColumns.mockResolvedValue({ columns: [], queryCount: 1 });

    await adapter.listSummaries({ limit: 25 }, { signal, maxScanRows: 500 });
    await adapter.listBoardColumns({ limit: 20 }, ["needs_design"], 20, { signal });

    expect(content.listSummaries).toHaveBeenCalledWith(
      { limit: 25 },
      { signal, maxScanRows: 500 }
    );
    expect(content.listBoardColumns).toHaveBeenCalledWith(
      { limit: 20 },
      ["needs_design"],
      20,
      { signal }
    );
    expect(legacy.list).not.toHaveBeenCalled();
  });

  it("passes entryResolver to the content adapter and never to the legacy lease adapter (task.0086)", () => {
    const entryResolver = { resolve: vi.fn() } as never;
    new DoltgresPolyWorkItemAdapter({} as never, undefined, { entryResolver });

    expect(DoltgresWorkItemAdapter).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ entryResolver, writerLockProtocol: "bridge" })
    );
  });

  it("routes every patch through the content adapter so reason and cites are enforced once (task.0086)", async () => {
    content.patch.mockResolvedValue(item("task.5001"));
    legacy.get.mockResolvedValue(null);
    const adapter = new DoltgresPolyWorkItemAdapter({} as never);
    const input = {
      id: "task.5001",
      reason: "test change",
      cites: [{ id: "change-history-design" }],
      set: { title: "t" },
    } as never;

    await adapter.patch(input, "agent-1");

    expect(content.patch).toHaveBeenCalledWith(input, "agent-1");
    expect(legacy.patch).not.toHaveBeenCalled();
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/work-item-capability`
 * Purpose: The AI work-item capability queries the live (Doltgres) backlog when wired, and refuses AI patches
 *   to priority <= 1.
 * Scope: Factory with fake ports. No Doltgres.
 * Invariants: QUERY_READS_THE_LIVE_BACKLOG, WRITES_NOT_WIDENED, P0P1_IS_NODE_ADMIN.
 * Side-effects: none
 * Links: src/bootstrap/capabilities/work-item.ts, story.5101
 * @internal
 */

import type { WorkItemCommandPort, WorkItemQueryPort } from "@cogni/work-items";
import { describe, expect, it, vi } from "vitest";

import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";

const empty = { items: [], pageInfo: { endCursor: null, hasMore: false } };

describe("createWorkItemCapability", () => {
  it("query reads the backlogReader (live backlog), not the markdown port", async () => {
    const markdown = { list: vi.fn().mockResolvedValue(empty), get: vi.fn() };
    const backlog = { list: vi.fn().mockResolvedValue(empty) };
    const cap = createWorkItemCapability({
      workItemQuery: markdown as unknown as WorkItemQueryPort,
      workItemCommand: {} as WorkItemCommandPort,
      backlogReader: backlog as unknown as Pick<WorkItemQueryPort, "list">,
    });
    await cap.query({ statuses: ["needs_implement"] });
    expect(backlog.list).toHaveBeenCalledTimes(1);
    expect(markdown.list).not.toHaveBeenCalled();
  });

  it("an AI patch to priority <= 1 is refused before any write", async () => {
    const command = { patch: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: { list: vi.fn(), get: vi.fn() } as unknown as WorkItemQueryPort,
      workItemCommand: command as unknown as WorkItemCommandPort,
    });
    await expect(cap.patch({ id: "task.5001", set: { priority: 0 } })).rejects.toThrow(
      "authz_denied"
    );
    expect(command.patch).not.toHaveBeenCalled();
  });
});

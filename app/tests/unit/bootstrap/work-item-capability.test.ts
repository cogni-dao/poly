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
    expect(backlog.list).toHaveBeenCalledWith({
      statuses: ["needs_implement"],
    });
    expect(markdown.list).not.toHaveBeenCalled();
  });

  it("query falls back to the query port when no backlogReader is wired", async () => {
    const markdown = { list: vi.fn().mockResolvedValue(empty), get: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: markdown as unknown as WorkItemQueryPort,
      workItemCommand: {} as WorkItemCommandPort,
    });
    await cap.query({ statuses: ["needs_implement"] });
    expect(markdown.list).toHaveBeenCalledWith({
      statuses: ["needs_implement"],
    });
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

  it("WRITES_NOT_WIDENED: transitionStatus/patch stay on workItemQuery + workItemCommand, never the backlogReader", async () => {
    const item = { id: "task.5001", status: "needs_implement", revision: 3 };
    const markdown = { list: vi.fn(), get: vi.fn().mockResolvedValue(item) };
    const command = {
      transitionStatus: vi.fn().mockResolvedValue({ ...item, status: "done", revision: 4 }),
      patch: vi.fn().mockResolvedValue({
        ...item,
        type: "task",
        title: "t",
        labels: [],
        assignees: [],
      }),
    };
    const backlog = { list: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: markdown as unknown as WorkItemQueryPort,
      workItemCommand: command as unknown as WorkItemCommandPort,
      backlogReader: backlog as unknown as Pick<WorkItemQueryPort, "list">,
    });
    await cap.transitionStatus({ id: "task.5001", toStatus: "done" });
    await cap.patch({ id: "task.5001", set: { priority: 3 } });
    expect(markdown.get).toHaveBeenCalledTimes(2);
    expect(command.transitionStatus).toHaveBeenCalledTimes(1);
    expect(command.patch).toHaveBeenCalledTimes(1);
    expect(backlog.list).not.toHaveBeenCalled();
  });
});

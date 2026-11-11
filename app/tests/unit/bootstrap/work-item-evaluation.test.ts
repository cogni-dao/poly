// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it, vi } from "vitest";
import { rankScore, toWorkItemId, type WorkItem, type WorkItemCommandPort, type WorkItemQueryPort } from "@cogni/work-items";
import { WorkItemRevisionConflictError } from "@cogni/work-items/adapters/doltgres";
import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";

const scores = { goal: { v: 3 }, time: { v: 2 }, unblocks: { v: 3 }, ease: { v: 3 }, confidence: { v: 3 }, agent: { v: 3 } };
const item: WorkItem = { id: toWorkItemId("task.9500"), type: "task", title: "Baseline", status: "needs_implement", node: "poly", actor: "either", assignees: [], externalRefs: [], labels: [], specRefs: [], revision: 3, deployVerified: false, createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z", scores };
function fixture() {
  let actor = "actor-a";
  const patch = vi.fn().mockResolvedValue(item);
  const list = vi.fn().mockResolvedValue({ items: [item], nextCursor: "next", pageInfo: { endCursor: "next", hasMore: true } });
  const capability = createWorkItemCapability({
    workItemQuery: { list, get: vi.fn().mockResolvedValue(item) } as unknown as WorkItemQueryPort,
    workItemCommand: {} as WorkItemCommandPort,
    backlogWriter: { store: { patch }, principalId: () => actor },
  });
  return { capability, patch, list, setActor: (value: string) => { actor = value; } };
}
describe("shared evaluation capability", () => {
  it("forwards scores/CAS and resolves authenticated principal for every call", async () => {
    const f = fixture();
    const first = await f.capability.patch({ id: item.id, expectedRevision: 2, reason: "test change", set: { scores } });
    expect(f.patch).toHaveBeenLastCalledWith({ id: item.id, expectedRevision: 2, reason: "test change", set: { scores } }, "actor-a");
    expect(first).toMatchObject({ scores, revision: 3, rankScore: rankScore(scores) });
    f.setActor("actor-b");
    await f.capability.patch({ id: item.id, expectedRevision: 3, reason: "test change", set: { scores: null } });
    expect(f.patch).toHaveBeenLastCalledWith({ id: item.id, expectedRevision: 3, reason: "test change", set: { scores: null } }, "actor-b");
  });
  it("forwards the required reason and the cites to the live store (task.0086)", async () => {
    const f = fixture();
    const cites = [{ id: "change-history-design" }];
    await f.capability.patch({ id: item.id, reason: "scope follows the design", cites, set: { rank: 2 } });
    expect(f.patch).toHaveBeenLastCalledWith(
      { id: item.id, reason: "scope follows the design", cites, set: { rank: 2 } },
      "actor-a",
    );
    await f.capability.patch({ id: item.id, reason: "no cites here", set: { rank: 3 } });
    expect(f.patch).toHaveBeenLastCalledWith(
      { id: item.id, reason: "no cites here", set: { rank: 3 } },
      "actor-a",
    );
  });
  it("preserves conflicts and paginated score-bearing readback", async () => {
    const f = fixture();
    f.patch.mockRejectedValue(new WorkItemRevisionConflictError(item.id, 2, 3));
    await expect(f.capability.patch({ id: item.id, expectedRevision: 2, reason: "test change", set: { scores } })).rejects.toMatchObject({ name: "WorkItemPatchConflictError", expectedRevision: 2, currentRevision: 3 });
    expect(await f.capability.queryPage?.({ ids: [item.id], cursor: "prior", limit: 5 })).toMatchObject({ items: [{ scores, revision: 3 }], nextCursor: "next" });
    expect(f.list).toHaveBeenCalledWith({ ids: [item.id], cursor: "prior", limit: 5 });
  });
});

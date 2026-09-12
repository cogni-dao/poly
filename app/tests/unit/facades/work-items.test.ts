// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/facades/work-items`
 * Purpose: Unit test for work items facade — verifies DTO mapping and port delegation.
 * Scope: Mocks container and WorkItemQueryPort. Tests listWorkItems and getWorkItem.
 * Invariants: PORT_VIA_CONTAINER, CONTRACTS_ARE_TRUTH
 * Side-effects: none
 * Links: src/app/_facades/work/items.server.ts
 * @internal
 */

import {
  WorkItemDtoSchema,
  workItemsCreateOperation,
  workItemsListOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import type {
  WorkItem,
  WorkItemCommandPort,
  WorkItemQueryPort,
} from "@cogni/work-items";
import { toWorkItemId } from "@cogni/work-items";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the container
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(),
}));

import {
  claimWorkItem,
  createWorkItem,
  getWorkItem,
  heartbeatWorkItem,
  listWorkItems,
  patchWorkItem,
  releaseWorkItem,
  UnsupportedWorkItemPatchFieldsError,
  WorkItemNotFoundError,
} from "@/app/_facades/work/items.server";
import { getContainer } from "@/bootstrap/container";

const mockGetContainer = vi.mocked(getContainer);

const SAMPLE_WORK_ITEM: WorkItem = {
  id: toWorkItemId("task.0001"),
  type: "task",
  title: "Sample task",
  status: "needs_implement",
  priority: 1,
  rank: 5,
  estimate: 3,
  summary: "A test summary",
  outcome: "Expected outcome",
  projectId: toWorkItemId("proj.test"),
  parentId: undefined,
  node: "poly",
  assignees: [{ kind: "user", userId: "u1" }],
  externalRefs: [{ system: "github", kind: "pr" }],
  labels: ["test", "api"],
  specRefs: ["architecture-spec"],
  branch: "feat/task-0001",
  pr: undefined,
  reviewer: undefined,
  revision: 2,
  blockedBy: undefined,
  deployVerified: false,
  claimedByRun: undefined,
  claimedAt: undefined,
  lastCommand: undefined,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
};

function createMockPort(): WorkItemQueryPort {
  return {
    list: vi.fn(),
    get: vi.fn(),
    listRelations: vi.fn(),
  };
}

function createMockCommandPort(): WorkItemCommandPort {
  return {
    create: vi.fn(),
    patch: vi.fn(),
    transitionStatus: vi.fn(),
    setAssignees: vi.fn(),
    upsertRelation: vi.fn(),
    removeRelation: vi.fn(),
    upsertExternalRef: vi.fn(),
    claim: vi.fn(),
    release: vi.fn(),
  };
}

describe("app/_facades/work/items.server", () => {
  let mockPort: ReturnType<typeof createMockPort>;
  let mockCommand: ReturnType<typeof createMockCommandPort>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockPort = createMockPort();
    mockCommand = createMockCommandPort();
    mockGetContainer.mockReturnValue({
      workItemQuery: mockPort,
      workItemCommand: mockCommand,
    } as never);
  });

  describe("listWorkItems", () => {
    it("returns items mapped to contract-compliant DTOs", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [SAMPLE_WORK_ITEM],
        nextCursor: undefined,
      });

      const result = await listWorkItems({});

      expect(result.items).toHaveLength(1);
      // Verify contract compliance
      expect(() => workItemsListOperation.output.parse(result)).not.toThrow();
    });

    it("maps WorkItem fields to DTO fields correctly", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [SAMPLE_WORK_ITEM],
        nextCursor: undefined,
      });

      const result = await listWorkItems({});
      const dto = result.items[0];

      expect(dto).toBeDefined();
      expect(dto?.id).toBe("task.0001");
      expect(dto?.type).toBe("task");
      expect(dto?.title).toBe("Sample task");
      expect(dto?.status).toBe("needs_implement");
      expect(dto?.priority).toBe(1);
      expect(dto?.rank).toBe(5);
      expect(dto?.estimate).toBe(3);
      expect(dto?.projectId).toBe("proj.test");
      expect(dto?.node).toBe("poly");
      expect(dto?.assignees).toEqual([{ kind: "user", userId: "u1" }]);
      expect(dto?.labels).toEqual(["test", "api"]);
      expect(dto?.revision).toBe(2);
      expect(dto?.deployVerified).toBe(false);
      expect(dto?.createdAt).toBe("2026-01-01");
      expect(dto?.updatedAt).toBe("2026-01-02");
    });

    it("DTO passes schema validation", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [SAMPLE_WORK_ITEM],
        nextCursor: undefined,
      });

      const result = await listWorkItems({});
      const dto = result.items[0];
      expect(dto).toBeDefined();
      expect(() => WorkItemDtoSchema.parse(dto)).not.toThrow();
    });

    it("passes filter params to port", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [],
        nextCursor: undefined,
      });

      await listWorkItems({
        types: ["task", "bug"],
        statuses: ["needs_implement"],
        text: "search",
        projectId: "proj.test",
        limit: 50,
      });

      expect(mockPort.list).toHaveBeenCalledWith({
        types: ["task", "bug"],
        statuses: ["needs_implement"],
        text: "search",
        projectId: toWorkItemId("proj.test"),
        limit: 50,
      });
    });

    it("omits undefined filter params from port query", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [],
        nextCursor: undefined,
      });

      await listWorkItems({});

      expect(mockPort.list).toHaveBeenCalledWith({});
    });

    it("returns empty items for empty result", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [],
        nextCursor: undefined,
      });

      const result = await listWorkItems({});
      expect(result.items).toEqual([]);
    });

    it("passes through nextCursor", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [],
        nextCursor: "cursor-xyz",
      });

      const result = await listWorkItems({});
      expect(result.nextCursor).toBe("cursor-xyz");
    });
  });

  describe("getWorkItem", () => {
    it("returns DTO for existing item", async () => {
      vi.mocked(mockPort.get).mockResolvedValue(SAMPLE_WORK_ITEM);

      const result = await getWorkItem("task.0001");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("task.0001");
      expect(result?.title).toBe("Sample task");
      expect(() => WorkItemDtoSchema.parse(result)).not.toThrow();
    });

    it("returns null for non-existent item", async () => {
      vi.mocked(mockPort.get).mockResolvedValue(null);

      const result = await getWorkItem("task.9999");

      expect(result).toBeNull();
    });

    it("calls port with branded WorkItemId", async () => {
      vi.mocked(mockPort.get).mockResolvedValue(null);

      await getWorkItem("task.0001");

      expect(mockPort.get).toHaveBeenCalledWith(toWorkItemId("task.0001"));
    });
  });

  describe("createWorkItem", () => {
    it("creates through WorkItemCommandPort and returns a contract DTO", async () => {
      vi.mocked(mockCommand.create).mockResolvedValue(SAMPLE_WORK_ITEM);

      const result = await createWorkItem({
        type: "task",
        title: "Sample task",
        summary: "A test summary",
        projectId: "proj.test",
        labels: ["test", "api"],
        priority: 1,
      });

      expect(mockCommand.create).toHaveBeenCalledWith({
        type: "task",
        title: "Sample task",
        summary: "A test summary",
        projectId: toWorkItemId("proj.test"),
        labels: ["test", "api"],
        priority: 1,
      });
      expect(result.id).toBe("task.0001");
      expect(() => workItemsCreateOperation.output.parse(result)).not.toThrow();
    });
  });

  describe("patchWorkItem", () => {
    it("verifies the item exists, patches through WorkItemCommandPort, and returns a contract DTO", async () => {
      const patchedItem: WorkItem = {
        ...SAMPLE_WORK_ITEM,
        title: "Updated task",
        revision: 3,
      };
      vi.mocked(mockPort.get).mockResolvedValue(SAMPLE_WORK_ITEM);
      vi.mocked(mockCommand.patch).mockResolvedValue(patchedItem);

      const result = await patchWorkItem({
        id: "task.0001",
        set: {
          title: "Updated task",
          labels: ["updated"],
        },
      });

      expect(mockPort.get).toHaveBeenCalledWith(toWorkItemId("task.0001"));
      expect(mockCommand.patch).toHaveBeenCalledWith({
        id: toWorkItemId("task.0001"),
        set: {
          title: "Updated task",
          labels: ["updated"],
        },
      });
      expect(result.title).toBe("Updated task");
      expect(result.revision).toBe(3);
      expect(() => workItemsPatchOperation.output.parse(result)).not.toThrow();
    });

    it("throws WorkItemNotFoundError when the item does not exist", async () => {
      vi.mocked(mockPort.get).mockResolvedValue(null);

      await expect(
        patchWorkItem({ id: "task.9999", set: { title: "Missing" } })
      ).rejects.toBeInstanceOf(WorkItemNotFoundError);
      expect(mockCommand.patch).not.toHaveBeenCalled();
    });

    it("rejects patch fields not supported by the current command port", async () => {
      await expect(
        patchWorkItem({
          id: "task.0001",
          set: { deployVerified: true },
        })
      ).rejects.toBeInstanceOf(UnsupportedWorkItemPatchFieldsError);
      expect(mockPort.get).not.toHaveBeenCalled();
      expect(mockCommand.patch).not.toHaveBeenCalled();
    });
  });

  describe("coordination commands", () => {
    it("claims through WorkItemCommandPort and returns a contract DTO", async () => {
      const claimedItem: WorkItem = {
        ...SAMPLE_WORK_ITEM,
        claimedByRun: "run-123",
        claimedAt: "2026-01-03T00:00:00.000Z",
        lastCommand: "/implement",
      };
      vi.mocked(mockPort.get).mockResolvedValue(SAMPLE_WORK_ITEM);
      vi.mocked(mockCommand.claim).mockResolvedValue(claimedItem);

      const result = await claimWorkItem({
        id: "task.0001",
        runId: "run-123",
        command: "/implement",
      });

      expect(mockPort.get).toHaveBeenCalledWith(toWorkItemId("task.0001"));
      expect(mockCommand.claim).toHaveBeenCalledWith({
        id: toWorkItemId("task.0001"),
        runId: "run-123",
        command: "/implement",
      });
      expect(result.claimedByRun).toBe("run-123");
      expect(result.lastCommand).toBe("/implement");
      expect(() => WorkItemDtoSchema.parse(result)).not.toThrow();
    });

    it("releases through WorkItemCommandPort and returns a contract DTO", async () => {
      const currentItem: WorkItem = {
        ...SAMPLE_WORK_ITEM,
        claimedByRun: "run-123",
        claimedAt: "2026-01-03T00:00:00.000Z",
        lastCommand: "/implement",
      };
      vi.mocked(mockPort.get).mockResolvedValue(currentItem);
      vi.mocked(mockCommand.release).mockResolvedValue(SAMPLE_WORK_ITEM);

      const result = await releaseWorkItem({
        id: "task.0001",
        runId: "run-123",
      });

      expect(mockPort.get).toHaveBeenCalledWith(toWorkItemId("task.0001"));
      expect(mockCommand.release).toHaveBeenCalledWith({
        id: toWorkItemId("task.0001"),
        runId: "run-123",
      });
      expect(result.claimedByRun).toBeUndefined();
      expect(() => WorkItemDtoSchema.parse(result)).not.toThrow();
    });

    it("heartbeats by refreshing claim with the current last command", async () => {
      const currentItem: WorkItem = {
        ...SAMPLE_WORK_ITEM,
        claimedByRun: "run-123",
        claimedAt: "2026-01-03T00:00:00.000Z",
        lastCommand: "/implement",
      };
      const heartbeatItem: WorkItem = {
        ...currentItem,
        claimedAt: "2026-01-03T00:01:00.000Z",
      };
      vi.mocked(mockPort.get).mockResolvedValue(currentItem);
      vi.mocked(mockCommand.claim).mockResolvedValue(heartbeatItem);

      const result = await heartbeatWorkItem({
        id: "task.0001",
        runId: "run-123",
      });

      expect(mockPort.get).toHaveBeenCalledWith(toWorkItemId("task.0001"));
      expect(mockCommand.claim).toHaveBeenCalledWith({
        id: toWorkItemId("task.0001"),
        runId: "run-123",
        command: "/implement",
      });
      expect(result.claimedAt).toBe("2026-01-03T00:01:00.000Z");
      expect(() => WorkItemDtoSchema.parse(result)).not.toThrow();
    });

    it("heartbeats with the literal fallback command when no previous command exists", async () => {
      const heartbeatItem: WorkItem = {
        ...SAMPLE_WORK_ITEM,
        claimedByRun: "run-123",
        claimedAt: "2026-01-03T00:01:00.000Z",
        lastCommand: "heartbeat",
      };
      vi.mocked(mockPort.get).mockResolvedValue(SAMPLE_WORK_ITEM);
      vi.mocked(mockCommand.claim).mockResolvedValue(heartbeatItem);

      await heartbeatWorkItem({
        id: "task.0001",
        runId: "run-123",
      });

      expect(mockCommand.claim).toHaveBeenCalledWith({
        id: toWorkItemId("task.0001"),
        runId: "run-123",
        command: "heartbeat",
      });
    });
  });
});

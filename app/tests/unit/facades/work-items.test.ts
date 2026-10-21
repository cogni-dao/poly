// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/facades/work-items`
 * Purpose: Unit test for work items facade — verifies DTO mapping and port delegation.
 * Scope: Mocks the Doltgres port and verifies read/write delegation.
 * Invariants: PORT_VIA_CONTAINER, CONTRACTS_ARE_TRUTH
 * Side-effects: none
 * Links: src/app/_facades/work/items.server.ts
 * @internal
 */

import {
  WorkItemDtoSchema,
  workItemsListOperation,
} from "@cogni/node-contracts";
import type { WorkItem } from "@cogni/work-items";
import { toWorkItemId } from "@cogni/work-items";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the container
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(),
}));

import {
  claimWorkItem,
  heartbeatWorkItem,
  releaseWorkItem,
  createWorkItem,
  getWorkItem,
  listWorkItems,
  patchWorkItem,
  WorkItemsBackendNotReadyError,
} from "@/app/_facades/work/items.server";
import {
  KnowledgeBusyError,
  KnowledgeWriteConflictError,
  KnowledgeWriteOutcomeUnknownError,
  KnowledgeWriteScopeRequiredError,
} from "@cogni/knowledge-store";
import { WorkItemWriteOutcomeUnknownError } from "@cogni/work-items";
import type { SessionUser } from "@cogni/node-shared";
import {
  handleCreate,
  handleAppendCommit,
  handleMerge,
  handleClose,
} from "@/app/api/v1/knowledge/contributions/_handlers";
import { handleCreate as handleDomain } from "@/app/api/v1/knowledge/domains/_handlers";
import { handleHypothesize } from "@/app/api/v1/edo/_handlers";
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

function createMockPort() {
  return {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    claim: vi.fn(),
    heartbeat: vi.fn(),
    release: vi.fn(),
  };
}

describe("app/_facades/work/items.server", () => {
  let mockPort: ReturnType<typeof createMockPort>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockPort = createMockPort();
    mockGetContainer.mockReturnValue({
      doltgresWorkItems: mockPort,
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

  describe("writes", () => {
    it("maps bounded adapter contention to backend-not-ready", async () => {
      const busy = new Error("Work-item store is busy; retry shortly");
      busy.name = "WorkItemsBusyError";
      mockPort.create.mockRejectedValue(busy);

      await expect(
        createWorkItem(
          { type: "task", title: "Sample task", node: "poly" },
          { id: "agent-1" }
        )
      ).rejects.toBeInstanceOf(WorkItemsBackendNotReadyError);
    });

    it("creates in Doltgres with immutable principal attribution", async () => {
      mockPort.create.mockResolvedValue(SAMPLE_WORK_ITEM);

      const result = await createWorkItem(
        { type: "task", title: "Sample task", node: "poly" },
        { id: "agent-1" }
      );

      expect(result.id).toBe("task.0001");
      expect(mockPort.create).toHaveBeenCalledWith(
        { type: "task", title: "Sample task", node: "poly" },
        "agent-1"
      );
    });

    it("passes extended patch fields to Doltgres", async () => {
      mockPort.patch.mockResolvedValue({
        ...SAMPLE_WORK_ITEM,
        deployVerified: true,
      });

      await patchWorkItem(
        { id: "task.0001", set: { deployVerified: true, blockedBy: null } },
        { id: "agent-1" }
      );

      expect(mockPort.patch).toHaveBeenCalledWith(
        {
          id: toWorkItemId("task.0001"),
          set: { deployVerified: true, blockedBy: null },
        },
        "agent-1"
      );
    });
  });
});

const POLY_USER: SessionUser = {
  id: "00000000-0000-4000-8000-000000000527",
  walletAddress: null,
  displayName: "Poly conformance",
  avatarColor: null,
};
function mutationRequest(body: unknown) {
  return new Request("http://poly.test/api/v1/conformance", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer fixture",
    },
    body: JSON.stringify(body),
  });
}

describe("Poly owned mutation composition", () => {
  it("forwards the exact PG lease owner/token without a content lookup", async () => {
    const heartbeat = vi.fn().mockResolvedValue({ active: true });
    const release = vi.fn().mockResolvedValue({ active: false });
    const claim = vi
      .fn()
      .mockResolvedValue({ leaseToken: "returned-pg-token" });
    const get = vi.fn(() => {
      throw new Error("heartbeat must not look up content");
    });
    mockGetContainer.mockReturnValue({
      doltgresWorkItems: { heartbeat, release, claim, get },
    } as never);
    const owner = {
      id: "task.5278",
      principalId: POLY_USER.id,
      runId: "poly-run",
      leaseToken: "actual-pg-token",
    };
    await heartbeatWorkItem({ ...owner, command: "implement" });
    await releaseWorkItem(owner);
    await claimWorkItem({
      id: owner.id,
      principalId: owner.principalId,
      runId: owner.runId,
      command: "implement",
    });
    expect(heartbeat).toHaveBeenCalledExactlyOnceWith({
      ...owner,
      command: "implement",
    });
    expect(release).toHaveBeenCalledExactlyOnceWith(owner);
    expect(claim).toHaveBeenCalledExactlyOnceWith({
      id: owner.id,
      principalId: owner.principalId,
      runId: owner.runId,
      command: "implement",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("preserves the work-item unknown receipt instead of turning it into retryable capacity", async () => {
    const unknown = new WorkItemWriteOutcomeUnknownError(
      "poly-op",
      "ops/poly-op",
      undefined,
      "task.5278"
    );
    const patch = vi.fn().mockRejectedValue(unknown);
    mockGetContainer.mockReturnValue({ doltgresWorkItems: { patch } } as never);
    const caught = await patchWorkItem(
      { id: "task.5278", set: { title: "one intent" } },
      POLY_USER
    ).catch((error) => error);
    expect(caught).toBeInstanceOf(WorkItemWriteOutcomeUnknownError);
    expect(caught.receipt).toEqual(unknown.receipt);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  const operations = [
    {
      name: "create",
      method: "create",
      invoke: () =>
        handleCreate(mutationRequest({ message: "one intent" }), POLY_USER),
    },
    {
      name: "append",
      method: "appendCommit",
      invoke: () =>
        handleAppendCommit(
          mutationRequest({
            message: "one intent",
            edits: [{ op: "delete", targetRowId: "entry", reason: "reviewed" }],
          }),
          "contrib-poly",
          POLY_USER
        ),
    },
    {
      name: "merge",
      method: "merge",
      invoke: () => handleMerge(mutationRequest({}), "contrib-poly", POLY_USER),
    },
    {
      name: "close",
      method: "close",
      invoke: () =>
        handleClose(
          mutationRequest({ reason: "reviewed" }),
          "contrib-poly",
          POLY_USER
        ),
    },
    {
      name: "EDO",
      method: "createEdoHypothesisContribution",
      invoke: () =>
        handleHypothesize(
          mutationRequest({
            id: "poly-hypothesis",
            domain: "poly",
            title: "Ppolyiction",
            content: "Evidence",
            evaluateAt: "2030-01-01T00:00:00.000Z",
            sourceType: "agent",
          }),
          POLY_USER
        ),
    },
    {
      name: "domain",
      method: "registerDomain",
      invoke: () =>
        handleDomain(mutationRequest({ id: "poly", name: "Poly" }), POLY_USER),
    },
  ];
  const failures = [
    {
      name: "unknown",
      error: () =>
        new KnowledgeWriteOutcomeUnknownError("poly-op", "ops/poly-op"),
      status: 409,
      body: {
        errorCode: "knowledge_write_outcome_unknown",
        retryable: false,
        operationId: "poly-op",
        branch: "ops/poly-op",
        commitHash: null,
      },
    },
    {
      name: "conflict",
      error: () => new KnowledgeWriteConflictError("poly-entry"),
      status: 409,
      body: {
        errorCode: "knowledge_write_conflict",
        retryable: false,
        entryId: "poly-entry",
      },
    },
    {
      name: "scope",
      error: () => new KnowledgeWriteScopeRequipolyError(),
      status: 500,
      body: { errorCode: "knowledge_write_scope_requipoly", retryable: false },
    },
    {
      name: "preadmission busy",
      error: () => new KnowledgeBusyError(),
      status: 503,
      body: { retryable: true },
    },
  ];
  for (const operation of operations) {
    for (const failure of failures) {
      it(`${operation.name}: ${failure.name} retains status, lookup and retry policy`, async () => {
        const mutation = vi.fn().mockRejectedValue(failure.error());
        mockGetContainer.mockReturnValue({
          knowledgeContributionService: { [operation.method]: mutation },
          knowledgeStorePort: { [operation.method]: mutation },
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as never);
        const response = await operation.invoke();
        expect(response.status).toBe(failure.status);
        expect(await response.json()).toMatchObject(failure.body);
        expect(response.headers.get("Retry-After")).toBe(
          failure.status === 503 ? "2" : null
        );
        expect(mutation).toHaveBeenCalledTimes(1);
      });
    }
  }
});

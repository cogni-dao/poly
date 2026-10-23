// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Actual mutation handlers and facade, with only authentication/logging and the port stubbed. */

import { WorkItemWriteOutcomeUnknownError } from "@cogni/work-items";
import { WorkItemWriteOutcomeUnknownError as AdapterWriteOutcomeUnknownError } from "@cogni/work-items/adapters/doltgres";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  create: vi.fn(),
  sessionUser: { id: "agent:cas" } as { id: string } | null,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    doltgresWorkItems: { patch: mocks.patch, create: mocks.create },
  }),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_options: unknown, handler: (...args: unknown[]) => unknown) =>
    (request: NextRequest, context: unknown) =>
      handler(
        { log: { info: vi.fn() } },
        request,
        mocks.sessionUser,
        context
      ),
}));
// Exercise THIS node's source contract without installing/building declarations.
vi.mock("@cogni/node-contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cogni/node-contracts")>()),
  ...(await import(
    "../../../../packages/node-contracts/src/work.items.patch.v1.contract"
  )),
}));

import { PATCH } from "@/app/api/v1/work/items/[id]/route";
import { POST } from "@/app/api/v1/work/items/route";
import { patchWorkItem } from "@/app/_facades/work/items.server";

const item = {
  id: "task.0001",
  type: "task",
  title: "Updated",
  status: "needs_implement",
  actor: "either",
  assignees: [],
  externalRefs: [],
  labels: [],
  specRefs: [],
  revision: 3,
  deployVerified: false,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
};
function patch(body: unknown) {
  return PATCH(
    new NextRequest("https://poly.cognidao.org/api/v1/work/items/task.0001", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: item.id }) }
  );
}
function create() {
  return POST(
    new NextRequest("https://poly.cognidao.org/api/v1/work/items", {
      method: "POST",
      body: JSON.stringify({ type: "task", title: "Created" }),
      headers: { "content-type": "application/json" },
    })
  );
}
describe("work-item HTTP revision CAS", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.sessionUser = { id: "agent:cas" };
    mocks.patch.mockResolvedValue(item);
    mocks.create.mockResolvedValue(item);
  });
  it.each([
    0, 2,
  ])("forwards expectedRevision=%s through the real contract and facade", async (revision) => {
    const response = await patch({
      set: { title: "Updated" },
      expectedRevision: revision,
    });
    expect(response.status).toBe(200);
    expect(mocks.patch).toHaveBeenCalledExactlyOnceWith(
      {
        id: item.id,
        set: { title: "Updated" },
        expectedRevision: revision,
      },
      "agent:cas"
    );
    expect((await response.json()).revision).toBe(3);
  });
  it("preserves omission for legacy clients", async () => {
    expect((await patch({ set: { title: "Updated" } })).status).toBe(200);
    expect(mocks.patch).toHaveBeenCalledExactlyOnceWith(
      { id: item.id, set: { title: "Updated" } },
      "agent:cas"
    );
  });
  it.each([
    -1,
    1.5,
    "2",
    null,
  ])("rejects invalid expectedRevision %s before mutation", async (revision) => {
    expect(
      (await patch({ set: { title: "Updated" }, expectedRevision: revision }))
        .status
    ).toBe(400);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("returns a typed 409 with currentRevision and never retries a stale patch", async () => {
    mocks.patch.mockRejectedValue(
      Object.assign(new Error("revision changed"), {
        name: "WorkItemRevisionConflictError",
        currentRevision: 3,
      })
    );
    const response = await patch({
      set: { title: "Stale" },
      expectedRevision: 2,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "revision_conflict",
      currentRevision: 3,
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });
  it.each([
    -1,
    1.5,
    "3",
    null,
  ])("does not classify malformed conflict revision %s", async (currentRevision) => {
    const error = Object.assign(new Error("untrusted shape"), {
      name: "WorkItemRevisionConflictError",
      currentRevision,
    });
    mocks.patch.mockRejectedValue(error);
    await expect(
      patch({ set: { title: "Updated" }, expectedRevision: 2 })
    ).rejects.toBe(error);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });
  it("keeps pre-admission busy at 503 without retry", async () => {
    mocks.patch.mockRejectedValue(
      Object.assign(new Error("busy"), { name: "WorkItemsBusyError" })
    );
    expect(
      (await patch({ set: { title: "Updated" }, expectedRevision: 2 })).status
    ).toBe(503);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });
  it("preserves unknown-outcome receipts without replay", async () => {
    const error = new WorkItemWriteOutcomeUnknownError(
      "operation",
      "branch",
      "commit",
      item.id
    );
    mocks.patch.mockRejectedValue(error);
    const response = await patch({
      set: { title: "Updated" },
      expectedRevision: 2,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: error.code,
      retryable: false,
      lookup: error.receipt.lookup,
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });
  it("preserves the root error instance through the facade", async () => {
    const error = new WorkItemWriteOutcomeUnknownError("operation", "branch");
    mocks.patch.mockRejectedValue(error);
    await expect(patchWorkItem(
      { id: item.id, set: { title: "Updated" } }, { id: "agent:cas" }
    )).rejects.toBe(error);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });
  describe.each(["patch", "create"] as const)("%s adapter error boundary", (operation) => {
    const invoke = () => operation === "patch"
      ? patch({ set: { title: "Updated" }, expectedRevision: 2 })
      : create();
    it.each([
      { commitHash: "commit", itemId: item.id },
      { commitHash: undefined, itemId: item.id },
      { commitHash: "commit", itemId: undefined },
      { commitHash: undefined, itemId: undefined },
    ])("returns the exact nonretryable receipt for %j", async ({ commitHash, itemId }) => {
      // Use the public adapter entry: its packed constructor can differ from root.
      const error = new AdapterWriteOutcomeUnknownError(
        "adapter-operation", "adapter-branch", commitHash, itemId
      );
      mocks[operation].mockRejectedValue(error);
      const response = await invoke();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "work_item_write_outcome_unknown",
        retryable: false,
        lookup: {
          operationId: "adapter-operation",
          branch: "adapter-branch",
          commitHash: commitHash ?? null,
          itemId: itemId ?? null,
        },
        message: error.message,
      });
      expect(mocks[operation]).toHaveBeenCalledTimes(1);
      expect(mocks[operation === "patch" ? "create" : "patch"]).not.toHaveBeenCalled();
    });
    it("preserves unrelated errors without retry", async () => {
      const error = new Error("unrelated port failure");
      mocks[operation].mockRejectedValue(error);
      await expect(invoke()).rejects.toBe(error);
      expect(mocks[operation]).toHaveBeenCalledTimes(1);
    });
    it("requires authentication before mutation", async () => {
      mocks.sessionUser = null;
      expect((await invoke()).status).toBe(401);
      expect(mocks.patch).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    });
  });
});

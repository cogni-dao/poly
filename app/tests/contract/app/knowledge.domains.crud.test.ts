// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Poly HTTP consumer proof against the real released fake adapter; SQL conformance belongs to its producer. */
import "next/dist/server/node-environment";
import { FakeKnowledgeStoreAdapter } from "@cogni/knowledge-store/adapters/fake";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@cogni/node-contracts",
  () =>
    import(
      "../../../../packages/node-contracts/src/knowledge.domains.v1.contract"
    ),
);
vi.mock("@/app/(app)/knowledge/_server/loaders", () => ({
  loadDomains: vi.fn(),
}));
let store: FakeKnowledgeStoreAdapter | undefined;
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ knowledgeStorePort: store }),
}));

import {
  handleDelete,
  handleGet,
  handleUpdate,
} from "@/app/api/v1/knowledge/domains/_handlers";

const agent = {
  id: "agent-user",
  walletAddress: null,
  displayName: "agent",
  avatarColor: null,
};
const human = { ...agent, id: "human-user", walletAddress: "0x123" };
const log = { info: vi.fn() };
const patch = (body: unknown) =>
  new Request("https://poly.test/api/v1/knowledge/domains/shelf", {
    method: "PATCH",
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({
    id: "shelf",
    name: "Shelf",
    description: "old",
  });
  await store.registerDomain({ id: "occupied", name: "Occupied" });
  await store.withWrite(
    { operationId: "test.seed", message: "seed" },
    async (write) => {
      await write.upsertKnowledge({
        id: "entry",
        domain: "occupied",
        title: "Entry",
        content: "Evidence",
        sourceType: "agent",
      });
    },
  );
});

describe("Poly domain item HTTP handlers", () => {
  it.each([agent, human])(
    "reads, patches, clears and deletes for $id",
    async (principal) => {
      expect((await handleGet("shelf", principal)).status).toBe(200);
      const updated = await handleUpdate(
        patch({ name: "Renamed", description: null }),
        "shelf",
        principal,
        log,
      );
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({
        id: "shelf",
        name: "Renamed",
        description: null,
      });
      const before = await store?.currentCommit();
      expect(
        (
          await handleUpdate(
            patch({ name: "Renamed", description: null }),
            "shelf",
            principal,
            log,
          )
        ).status,
      ).toBe(200);
      expect(await store?.currentCommit()).toBe(before);
      expect(
        await (await handleDelete("shelf", principal, log)).json(),
      ).toEqual({ id: "shelf", deleted: true });
      expect((await handleGet("shelf", principal)).status).toBe(404);
    },
  );
  it("rejects unauthenticated calls, invalid patches and absent domains", async () => {
    expect((await handleGet("shelf", null)).status).toBe(401);
    expect(
      (await handleUpdate(patch({ name: "x" }), "shelf", null, log)).status,
    ).toBe(401);
    expect((await handleDelete("shelf", null, log)).status).toBe(401);
    for (const body of [
      {},
      { id: "renamed" },
      { name: "" },
      { name: null },
      { description: 42 },
    ]) {
      expect(
        (await handleUpdate(patch(body), "shelf", agent, log)).status,
      ).toBe(400);
    }
    expect((await handleGet("missing", agent)).status).toBe(404);
    expect(
      (await handleUpdate(patch({ name: "x" }), "missing", agent, log)).status,
    ).toBe(404);
    expect((await handleDelete("missing", agent, log)).status).toBe(404);
  });
  it("refuses nonempty and baseline deletion without changing the store", async () => {
    const before = await store?.currentCommit();
    const response = await handleDelete("occupied", agent, log);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      errorCode: "domain_not_empty",
      entryCount: 1,
    });
    for (const id of ["meta", "mission", "strategy"]) {
      expect(await (await handleDelete(id, agent, log)).json()).toMatchObject({
        errorCode: "domain_protected",
      });
    }
    expect(await store?.currentCommit()).toBe(before);
    expect(await store?.getKnowledge("entry")).not.toBeNull();
  });
  it("reports unavailable storage", async () => {
    store = undefined;
    expect((await handleGet("shelf", agent)).status).toBe(503);
    expect(
      (await handleUpdate(patch({ name: "x" }), "shelf", agent, log)).status,
    ).toBe(503);
    expect((await handleDelete("shelf", agent, log)).status).toBe(503);
  });
});

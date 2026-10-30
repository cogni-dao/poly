// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Consumer proof: canonical fields survive Poly's HTTP and executable tool boundaries. */
import { createKnowledgeCapability } from "@cogni/knowledge-store";
import { FakeKnowledgeStoreAdapter } from "@cogni/knowledge-store/adapters/fake";
import {
  toWorkItemId,
  type WorkItem,
  type WorkItemCommandPort,
} from "@cogni/work-items";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";
import { toToolSpec } from "../../../packages/ai-tools/src/schema";
import {
  createKnowledgeReadImplementation,
  KnowledgeReadOutputSchema,
  knowledgeReadContract,
} from "../../../packages/ai-tools/src/tools/knowledge-read";
import {
  createKnowledgeSearchImplementation,
  KnowledgeSearchOutputSchema,
} from "../../../packages/ai-tools/src/tools/knowledge-search";
import {
  createWorkItemQueryImplementation,
  WorkItemQueryOutputSchema,
} from "../../../packages/ai-tools/src/tools/work-item-query";
import { KnowledgeRowSchema } from "../../../packages/node-contracts/src/knowledge.list.v1.contract";
import { WorkItemDtoSchema } from "../../../packages/node-contracts/src/work.items.list.v1.contract";

it("compiles both Poly's Zod 3 operators and released read contracts", () => {
  const local = toToolSpec({
    name: "poly__probe",
    description: "local operator",
    effect: "read_only",
    inputSchema: z.object({ wallet: z.string() }),
    outputSchema: z.object({}),
    redact: (x) => x,
    allowlist: [],
  });
  expect(local.spec.inputSchema.properties).toHaveProperty("wallet");
  expect(
    toToolSpec(knowledgeReadContract).spec.inputSchema.properties,
  ).toHaveProperty("id");
});

describe("canonical read inheritance", () => {
  it("retains complete work metadata, CAS and pagination through the executable query tool", async () => {
    const item: WorkItem = {
      id: toWorkItemId("task.9500"),
      type: "task",
      title: "Poly",
      status: "needs_implement",
      actor: "either",
      assignees: [{ kind: "agent", agentId: "agent-a" }],
      externalRefs: [
        {
          system: "github",
          kind: "pr",
          url: "https://github.com/cogni-dao/poly/pull/1",
        },
      ],
      labels: ["poly"],
      specRefs: ["spec"],
      revision: 7,
      deployVerified: false,
      createdAt: "2026-10-30T00:00:00Z",
      updatedAt: "2026-10-30T00:00:00Z",
      claimedByRun: "lease-a",
      lastCommand: "implement",
      reviewer: "independent",
      outcome: "preserve product",
      estimate: 2,
    };
    const list = vi.fn().mockResolvedValue({
      items: [item],
      nextCursor: "next",
      pageInfo: { endCursor: "next", hasMore: true },
    });
    const patch = vi.fn().mockResolvedValue(item);
    const capability = createWorkItemCapability({
      workItemQuery: {
        list,
        get: vi.fn().mockResolvedValue(item),
        listRelations: vi.fn(),
      },
      workItemCommand: {} as WorkItemCommandPort,
      backlogWriter: { store: { patch }, principalId: () => "agent-a" },
    });
    const output = await createWorkItemQueryImplementation({
      workItemCapability: capability,
      nodePublicOrigin: "https://poly-test.cognidao.org",
    }).execute({ cursor: "prior", limit: 5 });
    const wire = WorkItemQueryOutputSchema.parse(output);
    const {
      actor: _actor,
      assignees: _assignees,
      ...expected
    } = WorkItemDtoSchema.parse(item);
    expect(wire.items[0]).toMatchObject(expected);
    expect(wire.items[0]?.assignees).toEqual([
      { kind: "agent", id: "agent-a", agentId: "agent-a" },
    ]);
    expect(wire.nextCursor).toBe("next");
    expect(list).toHaveBeenCalledWith({ cursor: "prior", limit: 5 });
    await capability.patch({
      id: item.id,
      expectedRevision: 7,
      set: { scores: null },
    });
    expect(patch).toHaveBeenCalledWith(
      { id: item.id, expectedRevision: 7, set: { scores: null } },
      "agent-a",
    );
  });
  it("carries hypothesis metadata through get/list/search without losing local content", async () => {
    const store = new FakeKnowledgeStoreAdapter();
    await store.registerDomain({ id: "signals", name: "Signals" });
    await store.withWrite(
      { operationId: "test.seed", message: "seed" },
      async (write) => {
        await write.upsertKnowledge({
          id: "signal",
          domain: "signals",
          title: "Poly signal",
          content: "prediction evidence",
          sourceType: "agent",
          useWhen: "ranking signals",
          evaluateAt: new Date("2026-11-01T00:00:00Z"),
          resolutionStrategy: "agent",
        });
      },
    );
    const knowledgeCapability = createKnowledgeCapability(store);
    const deps = {
      knowledgeCapability: {
        ...knowledgeCapability,
        async get(id: string) {
          const entry = await knowledgeCapability.get(id);
          return entry
            ? { ...entry, sourceUrl: "https://untrusted.invalid/entry" }
            : null;
        },
      },
      nodePublicOrigin: "https://poly-test.cognidao.org",
    };
    const read = KnowledgeReadOutputSchema.parse(
      await createKnowledgeReadImplementation(deps).execute({ id: "signal" }),
    );
    const search = KnowledgeSearchOutputSchema.parse(
      await createKnowledgeSearchImplementation(deps).execute({
        domain: "signals",
        query: "prediction",
      }),
    );
    expect(read.entries[0]?.sourceUrl).toBe(
      "https://poly-test.cognidao.org/knowledge/signal",
    );
    for (const entry of [
      read.entries[0],
      search.results[0],
      ...(await knowledgeCapability.list({ domain: "signals" })),
    ]) {
      expect(KnowledgeRowSchema.parse(entry)).toMatchObject({
        id: "signal",
        useWhen: "ranking signals",
        evaluateAt: "2026-11-01T00:00:00.000Z",
        resolutionStrategy: "agent",
        content: "prediction evidence",
      });
    }
  });
});

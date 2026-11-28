// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/agent-harness-binding`
 * Purpose: Prove the binding invariants of the shared Cogni harness over Poly's REAL catalog and tool bundles (no fake entries).
 * Scope: Which graph can hold the shell, what the read-only prioritizer may hold, which contracts must declare a lock, and what the
 *   coordinator prompt tells the model this node runs.
 * Invariants:
 *   - SHELL_ONLY_IN_COGNI: `core__sandbox_shell` is listed only by `cogni`.
 *   - PRIORITIZER_IS_READ_ONLY: every tool the prioritizer lists resolves to a `read_only` contract.
 *   - EVERY_WRITE_DECLARES_REQUIRES: a contract whose effect is not `read_only` declares `requires` (the guard denies it otherwise).
 *   - PROMPT_MATCHES_NODE: the coordinator prompt names no workflow or write tool this node does not run.
 * Side-effects: none
 * Links: src/bootstrap/ai/node-catalog.ts, packages/langgraph-graphs/src/catalog.ts, story.0090
 * @internal
 */

import { SANDBOX_SHELL_NAME } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";

import { POLY_CORE_TOOL_BUNDLE } from "@/bootstrap/ai/evaluation-baseline";
import { POLY_NODE_LANGGRAPH_CATALOG } from "@/bootstrap/ai/node-catalog";
import { PRINCIPAL_TOOL_BUNDLE } from "@/bootstrap/ai/principal-tool-source";

const bundle = [...POLY_CORE_TOOL_BUNDLE, ...PRINCIPAL_TOOL_BUNDLE];
const byId = new Map(bundle.map((tool) => [tool.contract.name, tool.contract]));

describe("shared Cogni harness binding (real catalog and bundles)", () => {
  it("lists the shell in the cogni coordinator only", () => {
    const holders = Object.entries(POLY_NODE_LANGGRAPH_CATALOG)
      .filter(([, entry]) => entry.toolIds.includes(SANDBOX_SHELL_NAME))
      .map(([name]) => name);
    expect(holders).toEqual(["cogni"]);
  });

  it("gives the work-prioritizer only read_only tools, each resolvable in the node bundle", () => {
    const toolIds =
      POLY_NODE_LANGGRAPH_CATALOG["work-prioritizer"]?.toolIds ?? [];
    expect(toolIds.length).toBeGreaterThan(0);
    for (const id of toolIds) {
      const contract = byId.get(id);
      // Metric and goal-progress tools are bound by the container's metric tools, not the static bundle.
      if (!contract) {
        expect(
          id.startsWith("core__metric") || id === "core__goal_progress",
          `${id} must resolve in the node bundle`
        ).toBe(true);
        continue;
      }
      expect(contract.effect, `${id} effect`).toBe("read_only");
    }
  });

  it("gives poly-brain and poly-research only read_only tools, each resolvable in the node bundle (adoption audit)", () => {
    for (const graph of ["poly-brain", "poly-research"]) {
      const toolIds = POLY_NODE_LANGGRAPH_CATALOG[graph]?.toolIds ?? [];
      expect(toolIds.length, `${graph} tools`).toBeGreaterThan(0);
      for (const id of toolIds) {
        expect(byId.get(id)?.effect, `${graph}: ${id} effect`).toBe("read_only");
        expect(byId.get(id)?.requires, `${graph}: ${id} requires`).toBeUndefined();
      }
    }
  });

  it("names a seeded internal principal only where a graph needs one", () => {
    const principals = Object.fromEntries(
      Object.entries(POLY_NODE_LANGGRAPH_CATALOG).map(([name, entry]) => [
        name,
        entry.principal,
      ])
    );
    // 0092 seeds node-ai and prioritizer. Poly's own graphs offer no scoped tool, so they name none.
    expect(principals).toEqual({
      cogni: "node-ai",
      "work-prioritizer": "prioritizer",
      "poly-brain": undefined,
      "poly-research": undefined,
    });
  });

  it("declares requires on every non-read_only contract in the node bundles", () => {
    const missing = bundle
      .filter((tool) => tool.contract.effect !== "read_only")
      .filter((tool) => !tool.contract.requires)
      .map((tool) => tool.contract.name);
    expect(missing).toEqual([]);
    // The shell's own lock is the one the admin turns On.
    expect(byId.get(SANDBOX_SHELL_NAME)?.requires).toMatchObject({
      scope: "sandbox:exec",
      kind: "node",
    });
  });

  it("tells the cogni coordinator only about workflows this node runs", () => {
    const prompt = POLY_NODE_LANGGRAPH_CATALOG.cogni?.systemPrompt ?? "";
    expect(prompt).toContain("Host-owned registered workflows:");
    expect(prompt).not.toContain("work-closeout");
    expect(prompt).not.toContain("core__work_item_update");
    expect(prompt).not.toContain("core__work_item_artifact_record");
    expect(prompt).toContain("langgraph:work-prioritizer");
    expect(prompt).toContain("langgraph:poly-brain");
    expect(prompt).toContain("langgraph:poly-research");
  });
});

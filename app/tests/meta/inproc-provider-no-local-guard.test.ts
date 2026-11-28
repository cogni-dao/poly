// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/meta/inproc-provider-no-local-guard`
 * Purpose: Fail the build when Poly grows local graph-run guard, runner or catalog-composition code beside the shared in-process provider.
 * Scope: Scans app/src (and the graph package's source) for the guard and tool-runner primitives and for the files Poly deleted. Does NOT test runtime behavior.
 * Invariants:
 *   - NO_LOCAL_PROVIDER_LOGIC: the tool guard, the run-start tool filter, the tool runner and the graph runner are used only inside `@cogni-dao/langgraph-graphs/inproc`. A node that needs different behavior changes the package, not a local supplement.
 *   - NO_COPIED_PROVIDER_FILES: the copied provider supplements (source context loader, catalog types, local runner) stay deleted
 *   - THIN_ADAPTER: Poly's provider adapter stays a wiring file
 * Side-effects: IO (file system reads)
 * Links: https://node-template.cognidao.org/knowledge/inproc-provider-package-design
 * @public
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = process.cwd();
const SRC = join(APP, "src");
const GRAPH_PACKAGE_SRC = join(APP, "../packages/langgraph-graphs/src");
const ADAPTER = join(SRC, "adapters/server/ai/langgraph/inproc.provider.ts");

/** Primitives only the package provider may use. */
const FORBIDDEN = [
  "guardTools",
  "offeredToolIds",
  "createToolRunner",
  "createToolAllowlistPolicy",
  "createStaticToolSourceFromRecord",
  "ToolAuthorityError",
  "createInProcGraphRunner",
  "createSharedInProcGraphRunner",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

/** Code with comments removed, so a rule documented in a header does not trip the scan. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the in-process provider has no local guard code", () => {
  it("app/src and the graph package use none of the guard or runner primitives, except two named files", () => {
    // Two files are allowed by name: the package's own re-export of the published runner, and the LangGraph dev server's tool
    // executor, which has no run scope and denies every scoped or non-read_only tool (a different path from the provider).
    const allowed = [
      join(GRAPH_PACKAGE_SRC, "index.ts"),
      join(GRAPH_PACKAGE_SRC, "runtime/core/dev-tool-exec.ts"),
    ];
    const hits = [...sourceFiles(SRC), ...sourceFiles(GRAPH_PACKAGE_SRC)]
      .filter((file) => !allowed.includes(file))
      .flatMap((file) =>
        FORBIDDEN.filter((name) =>
          new RegExp(`\\b${name}\\b`).test(code(file))
        ).map((name) => `${file.slice(APP.length + 1)}: ${name}`)
      );
    expect(hits).toEqual([]);
  });

  it("the copied provider supplements stay deleted", () => {
    for (const gone of [
      join(SRC, "adapters/server/ai/langgraph/source-context.ts"),
      join(SRC, "adapters/server/ai/langgraph/catalog.ts"),
      join(GRAPH_PACKAGE_SRC, "inproc"),
    ]) {
      expect(existsSync(gone), gone).toBe(false);
    }
  });

  it("the adapter builds the provider from the package and stays small", () => {
    const text = code(ADAPTER);
    expect(text).toContain("createLangGraphInProcProvider");
    expect(text).not.toMatch(/@langchain\//);
    expect(
      text.split("\n").filter((line) => line.trim()).length
    ).toBeLessThanOrEqual(130);
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/meta/readyz-probe-semantics`
 * Purpose: Lock the shallow runtime probe versus deep stack-bootstrap readiness split.
 * Scope: Verifies probe call sites in the stack harness and public meta smoke test. Does not execute HTTP probes.
 * Invariants: Full-stack bootstrap uses `?deep=1`; the ordinary meta/default readiness probe remains shallow.
 * Side-effects: IO (reads repository source files)
 * Links: src/app/(infra)/readyz/route.ts, tests/stack/setup/wait-for-probes.ts
 * @internal
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appRoot = new URL("../../", import.meta.url);

function readAppSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, appRoot), "utf8");
}

describe("readiness probe semantics", () => {
  it("uses deep readiness for stack bootstrap", () => {
    const setup = readAppSource("tests/stack/setup/wait-for-probes.ts");

    expect(setup).toContain('new URL("/readyz?deep=1", baseUrl)');
    expect(setup).not.toContain('new URL("/readyz", baseUrl)');
  });

  it("keeps the ordinary meta readiness smoke shallow", () => {
    const metaSmoke = readAppSource(
      "tests/stack/meta/meta-endpoints.stack.test.ts"
    );

    expect(metaSmoke).toContain('fetch(baseUrl("/readyz"))');
    expect(metaSmoke).not.toContain("/readyz?deep=1");
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/admin-acts-in-admin`
 * Purpose: ONE_MINT import lock: `requireAdminSession` is the only place that manufactures an `AdminSession`.
 * Scope: Reads app source text; no runtime behavior.
 * Invariants: ADMIN_ACTS_IN_ADMIN / ONE_MINT: no other file casts to `AdminSession`.
 * Side-effects: filesystem reads
 * Links: src/app/(admin)/_lib/admin-session.ts
 * @internal
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../../src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("AdminSession mint", () => {
  it("is cast in exactly one file", () => {
    const minters = sources(root)
      .filter((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .some(
            (line) =>
              /\bas AdminSession\b/.test(line) &&
              !/^\s*(\*|\/\/|\/\*)/.test(line)
          )
      )
      .map((file) => path.relative(root, file));
    expect(minters).toEqual(["app/(admin)/_lib/admin-session.ts"]);
  });
});

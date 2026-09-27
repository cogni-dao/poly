// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `tests/unit/schema/poly-schema-duplication`
 * Purpose: Guard the load-bearing duplication of poly's Postgres schema slices — `packages/db-schema/src/` (globbed by drizzle.config.ts, owns migrations) vs `packages/poly-db-schema/src/` (imported directly by 25 runtime files). Both are live; only one drives `drizzle-kit generate`.
 * Scope: Byte-compares each duplicated slice modulo its `Module:` doc line. Does NOT validate schema correctness, RLS, or the migration chain.
 * Invariants:
 *   - POLY_SCHEMA_SLICES_IDENTICAL — the two copies differ only in the `Module:` path. Any other divergence means either a migration exists with no runtime types, or runtime types exist with no migration (schema-update failure mode #3), which surfaces in prod as `column "X" does not exist`.
 * Side-effects: reads files from the repo root
 * Links: .claude/skills/schema-update/SKILL.md, packages/db-schema/src/copy-trade.ts, packages/poly-db-schema/src/copy-trade.ts
 * @internal
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// vitest cwd is `app/`; the schema packages live one level up.
const REPO_ROOT = resolve(__dirname, "../../../..");

/**
 * Slices that exist in BOTH packages. Sourced from `packages/poly-db-schema`'s
 * export map — if you add a slice there, add it here or the guard silently
 * stops covering it.
 */
const DUPLICATED_SLICES = [
  "copy-trade.ts",
  "poly-redeem-jobs.ts",
  "trader-activity.ts",
  "wallet-connections.ts",
  "wallet-grants.ts",
] as const;

/** Strip the one line that is legitimately different: the `Module:` doc path. */
function normalize(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.includes("* Module: `@cogni/"))
    .join("\n");
}

describe("poly Postgres schema duplication", () => {
  it.each(DUPLICATED_SLICES)(
    "%s is identical in db-schema and poly-db-schema (modulo the Module: doc path)",
    (slice) => {
      const forMigrations = readFileSync(
        resolve(REPO_ROOT, "packages/db-schema/src", slice),
        "utf8"
      );
      const forRuntime = readFileSync(
        resolve(REPO_ROOT, "packages/poly-db-schema/src", slice),
        "utf8"
      );

      // Failure here means you edited one copy. Apply the SAME edit to the
      // other: `packages/db-schema/src/<slice>` is what drizzle-kit globs
      // (drizzle.config.ts), `packages/poly-db-schema/src/<slice>` is what
      // order-ledger.ts and 24 other files import at runtime.
      expect(normalize(forRuntime)).toBe(normalize(forMigrations));
    }
  );

  it("the Module: doc line is the only sanctioned difference", () => {
    // Sanity-check the normalizer itself: if someone deletes the Module: header,
    // normalize() would start hiding real diffs.
    const a = readFileSync(
      resolve(REPO_ROOT, "packages/db-schema/src/copy-trade.ts"),
      "utf8"
    );
    const b = readFileSync(
      resolve(REPO_ROOT, "packages/poly-db-schema/src/copy-trade.ts"),
      "utf8"
    );
    expect(a).toContain("* Module: `@cogni/db-schema/copy-trade`");
    expect(b).toContain("* Module: `@cogni/poly-db-schema/copy-trade`");
    expect(a).not.toBe(b);
  });
});

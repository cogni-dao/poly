// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `drizzle.config`
 * Purpose: Per-node drizzle-kit config for Poly — core platform schema plus Poly-local tables.
 * Scope: Drizzle-kit CLI boundary for a node-at-repo-root template fork.
 * Invariants: Postgres schema only. The packages/db-schema glob includes shared core slices and Poly-local Postgres slices; Doltgres remains isolated in drizzle.doltgres.config.ts. DATABASE_URL must be provided by caller.
 * Side-effects: IO (drizzle-kit writes to ./app/src/adapters/server/db/migrations).
 * Notes: No relative imports — drizzle-kit compiles configs to a temp dir, breaking `./app/...`-style paths. All paths are repo-root-relative.
 * Links: work/items/task.0324.per-node-db-schema-independence.md
 * @internal
 */

import { defineConfig } from "drizzle-kit";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for drizzle-kit (drizzle.config.ts). " +
        "Forks must invoke via a caller that sets DATABASE_URL from their .env file or container env.",
    );
  }
  return url;
}

export default defineConfig({
  schema: "./packages/db-schema/src/**/*.ts",
  out: "./app/src/adapters/server/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: requireDatabaseUrl() },
  verbose: true,
  strict: true,
});

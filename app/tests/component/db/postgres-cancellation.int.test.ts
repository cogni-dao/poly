// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/postgres-cancellation`
 * Purpose: Preserve subsequent result indices after a partial-row statement timeout.
 * Scope: Installed postgres-js ESM and CommonJS entry points against real Postgres.
 * Invariants: Native cancellation remains an error; the same backend returns dense rows.
 * Side-effects: Read-only constant queries on the component test database.
 * Links: https://cognidao.org/work/items/bug.5474,
 *   https://github.com/porsager/postgres/issues/1253
 * @internal
 */

import { createRequire } from "node:module";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const postgresCjs: typeof postgres = createRequire(import.meta.url)("postgres");

for (const [entryPoint, createSql] of [
  ["ESM", postgres],
  ["CommonJS", postgresCjs],
] as const) {
  describe(`postgres-js cancellation recovery (${entryPoint})`, () => {
    it("preserves 57014 and restarts the next result at index zero", async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL required: run test:component");
      const sql = createSql(url, {
        max: 1,
        idle_timeout: 0,
        connect_timeout: 5,
        connection: {
          default_transaction_read_only: "on",
          statement_timeout: 500,
        },
      });
      try {
        const before = await sql`SELECT pg_backend_pid() AS pid`;
        await expect(sql`
          SELECT g, pg_sleep(CASE WHEN g > 5 THEN 0.2 ELSE 0 END)
          FROM generate_series(1, 20) g
        `).rejects.toMatchObject({
          name: "PostgresError",
          code: "57014",
          message: "canceling statement due to statement timeout",
        });

        const rows =
          await sql`SELECT 'a'::text AS x UNION ALL SELECT 'b'::text AS x`;
        expect(rows.length).toBe(2);
        expect(Object.keys(rows).filter((key) => /^\d+$/.test(key))).toEqual([
          "0",
          "1",
        ]);
        expect(rows[0]).toEqual({ x: "a" });
        expect(rows[1]).toEqual({ x: "b" });
        const after = await sql`SELECT pg_backend_pid() AS pid`;
        expect(after[0]?.pid).toBe(before[0]?.pid);
      } finally {
        await sql.end({ timeout: 1 });
      }
    }, 10_000);
  });
}

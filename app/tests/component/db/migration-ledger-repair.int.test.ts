// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/db/migration-ledger-repair.int`
 * Purpose: Proves bug.5415's exact candidate-a migration-ledger repair against real PostgreSQL.
 * Scope: Executes migration 0086's SQL over clean, polluted, and unsupported ledger shapes; does not exercise deployment orchestration.
 * Invariants: CLEAN_HISTORY_NOOP, EXACT_TUPLE_ONLY, SCHEMA_PRECONDITIONS, TRANSACTIONAL_LEDGER_NORMALIZATION
 * Side-effects: IO (ephemeral component-test PostgreSQL; polluted cases always roll back)
 * Links: app/src/adapters/server/db/migrations/0086_repair_candidate_migration_identity.sql, https://cognidao.org/work/items/bug.5415
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPAIR_SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../../src/adapters/server/db/migrations/0086_repair_candidate_migration_identity.sql"
  ),
  "utf8"
);

const CANONICAL_HASH =
  "6753c89a9c1eace1aaf11e37e4627937db2afa89f5df0ff93c5f1a4d0000f763";
const CANONICAL_WHEN = 1791096737117;
const POLLUTED_HASH =
  "1d1ea3793363f479929e7d79c6866bf611268ec016565d83f0616b73bd4f50a6";
const POLLUTED_WHEN = 1791098285556;
const ROLLBACK = Symbol("rollback test transaction");

type LedgerSql = Sql | TransactionSql;

async function ledgerCount(
  sql: LedgerSql,
  hash: string,
  createdAt: number
): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count
    FROM drizzle.__drizzle_migrations
    WHERE hash = ${hash} AND created_at = ${createdAt}
  `;
  return Number(rows[0]?.count ?? 0);
}

async function withRollback(
  client: Sql,
  exercise: (tx: TransactionSql) => Promise<void>
): Promise<void> {
  try {
    await client.begin(async (tx) => {
      await exercise(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

describe("candidate migration ledger repair", () => {
  let client: Sql;

  beforeAll(() => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    client = postgres(databaseUrl, { max: 1 });
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  it("is a no-op for canonical history", async () => {
    expect(await ledgerCount(client, CANONICAL_HASH, CANONICAL_WHEN)).toBe(1);
    expect(await ledgerCount(client, POLLUTED_HASH, POLLUTED_WHEN)).toBe(0);

    await client.unsafe(REPAIR_SQL);

    expect(await ledgerCount(client, CANONICAL_HASH, CANONICAL_WHEN)).toBe(1);
    expect(await ledgerCount(client, POLLUTED_HASH, POLLUTED_WHEN)).toBe(0);
  });

  it("normalizes only the exact cancelled-flight tuple", async () => {
    await withRollback(client, async (tx) => {
      await tx`
        UPDATE drizzle.__drizzle_migrations
        SET hash = ${POLLUTED_HASH}, created_at = ${POLLUTED_WHEN}
        WHERE hash = ${CANONICAL_HASH} AND created_at = ${CANONICAL_WHEN}
      `;

      await tx.unsafe(REPAIR_SQL);

      expect(await ledgerCount(tx, CANONICAL_HASH, CANONICAL_WHEN)).toBe(1);
      expect(await ledgerCount(tx, POLLUTED_HASH, POLLUTED_WHEN)).toBe(0);
    });
  });

  it("fails closed for an unknown tuple", async () => {
    await withRollback(client, async (tx) => {
      await tx`
        UPDATE drizzle.__drizzle_migrations
        SET hash = ${"unknown-candidate-migration"}, created_at = ${POLLUTED_WHEN}
        WHERE hash = ${CANONICAL_HASH} AND created_at = ${CANONICAL_WHEN}
      `;

      await expect(tx.unsafe(REPAIR_SQL)).rejects.toThrow(
        /unsupported migration ledger shape/
      );
    });
  });

  it("refuses metadata repair when canonical schema effects are absent", async () => {
    await withRollback(client, async (tx) => {
      await tx`
        UPDATE drizzle.__drizzle_migrations
        SET hash = ${POLLUTED_HASH}, created_at = ${POLLUTED_WHEN}
        WHERE hash = ${CANONICAL_HASH} AND created_at = ${CANONICAL_WHEN}
      `;
      await tx.unsafe(
        'DROP INDEX public.poly_copy_trade_decisions_investigation_idx'
      );

      await expect(tx.unsafe(REPAIR_SQL)).rejects.toThrow(
        /schema preconditions are missing/
      );
    });
  });
});

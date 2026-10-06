// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import type { ReservedSql, Sql } from "postgres";

type Rows = ReadonlyArray<Record<string, unknown>>;

export function makeFakeDoltgresSql(
  respond: (query: string) => Rows | Promise<Rows>,
  queries: string[]
): Sql {
  const unsafe = async (query: string): Promise<Rows> => {
    queries.push(query);
    if (query === "SELECT 1 AS work_items_ready") {
      return [{ work_items_ready: 1 }];
    }
    if (query.startsWith("SELECT pg_try_advisory_lock")) {
      return [{ pg_try_advisory_lock: true }];
    }
    if (query.startsWith("SELECT pg_advisory_unlock")) {
      return [{ pg_advisory_unlock: true }];
    }
    if (query === "SELECT dolt_checkout('main')") {
      return [{ dolt_checkout: [0, ""] }];
    }
    if (query.includes("dolt_checkout('-b'")) {
      return [{ dolt_checkout: [0, ""] }];
    }
    if (query === "SELECT table_name FROM dolt.status") return [];
    if (query === "SELECT name, hash FROM dolt.branches") return [];
    if (query.includes("FROM dolt.merge_status")) return [];
    if (query === "SELECT dolt_add('work_items')") {
      return [{ dolt_add: [0, ""] }];
    }
    if (query.startsWith("SELECT dolt_commit")) {
      return [{ dolt_commit: "test-commit" }];
    }
    if (query.startsWith("SELECT dolt_merge(")) {
      return [{ dolt_merge: ["test-merge", 0, 0, "ok"] }];
    }
    if (query.startsWith("SELECT dolt_branch")) {
      return [{ dolt_branch: [0, ""] }];
    }
    return await respond(query);
  };

  const reserved = {
    unsafe,
    release: () => undefined,
  } as unknown as ReservedSql;
  return {
    unsafe,
    reserve: async () => reserved,
    end: async () => undefined,
  } as unknown as Sql;
}

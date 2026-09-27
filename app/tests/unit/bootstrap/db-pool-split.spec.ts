// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/db-pool-split`
 * Purpose: Verifies the request/job/read DB pool split at the container seam (task.5014).
 * Scope: Asserts resolveServiceReadDb is a distinct singleton pool from resolveServiceDb/resolveAppDb with env-tuned max + application_name. Does NOT open connections (postgres-js pools are lazy until first query).
 * Invariants: Module cache reset between tests; env restored; no live DB required.
 * Side-effects: process.env
 * Links: src/bootstrap/container.ts, src/adapters/server/db/drizzle.service-read-client.ts
 * @public
 */

import { BASE_VALID_ENV } from "@tests/_fixtures/env/base-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = process.env;

describe("DB pool split (task.5014)", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("resolves three distinct singleton pools with env-tuned max and application_name", async () => {
    Object.assign(process.env, {
      ...BASE_VALID_ENV,
      DB_POOL_MAX: "7",
      DB_SERVICE_POOL_MAX: "9",
      DB_READ_POOL_MAX: "3",
    });

    const { resolveAppDb, resolveServiceDb, resolveServiceReadDb } =
      await import("@/bootstrap/container");

    const appDb = resolveAppDb();
    const serviceDb = resolveServiceDb();
    const readDb = resolveServiceReadDb();

    // Three distinct pool instances — jobs (serviceDb) can exhaust their pool
    // without touching the dashboard/research read pool (readDb).
    expect(readDb).not.toBe(serviceDb);
    expect(readDb).not.toBe(appDb);
    expect(serviceDb).not.toBe(appDb);

    // Env-tuned per-pool connection budgets.
    expect(appDb.$client.options.max).toBe(7);
    expect(serviceDb.$client.options.max).toBe(9);
    expect(readDb.$client.options.max).toBe(3);

    // application_name distinguishes the pools in pg_stat_activity.
    expect(appDb.$client.options.connection.application_name).toBe(
      "cogni_template_app"
    );
    expect(serviceDb.$client.options.connection.application_name).toBe(
      "cogni_service"
    );
    expect(readDb.$client.options.connection.application_name).toBe(
      "cogni_service_read"
    );
  });

  it("uses default pool sizes (10/10/5) when env vars are unset", async () => {
    Object.assign(process.env, BASE_VALID_ENV);
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_SERVICE_POOL_MAX;
    delete process.env.DB_READ_POOL_MAX;

    const { resolveAppDb, resolveServiceDb, resolveServiceReadDb } =
      await import("@/bootstrap/container");

    expect(resolveAppDb().$client.options.max).toBe(10);
    expect(resolveServiceDb().$client.options.max).toBe(10);
    expect(resolveServiceReadDb().$client.options.max).toBe(5);
  });

  it("returns the same read-pool instance on repeated resolution (lazy singleton)", async () => {
    Object.assign(process.env, BASE_VALID_ENV);

    const { resolveServiceReadDb } = await import("@/bootstrap/container");

    expect(resolveServiceReadDb()).toBe(resolveServiceReadDb());
  });
});

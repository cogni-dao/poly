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
      // Raised budget so the env-tuned maxes pass through unclamped (bug.5064).
      DB_SERVICE_ROLE_BUDGET: "20",
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

  it("uses default pool sizes (1/2/1) when env vars are unset", async () => {
    // bug.5064: service+read+leader share role service_poly (ceiling 8, two pods
    // during blue/green) so one pod holds at most 4: service 2 + read 1 + leader 1.
    Object.assign(process.env, BASE_VALID_ENV);
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_SERVICE_POOL_MAX;
    delete process.env.DB_READ_POOL_MAX;
    delete process.env.DB_SERVICE_ROLE_BUDGET;

    const { resolveAppDb, resolveServiceDb, resolveServiceReadDb } =
      await import("@/bootstrap/container");

    expect(resolveAppDb().$client.options.max).toBe(1);
    expect(resolveServiceDb().$client.options.max).toBe(2);
    expect(resolveServiceReadDb().$client.options.max).toBe(1);
  });

  it("clamps injected runtimePoolLimits (service 4 / read 2) to the per-pod service_poly budget", async () => {
    // Production injects 4/2 (7 per pod with the leader, 14 across two blue/green
    // pods against a role ceiling of 8 → SQLSTATE 53300, bug.5064).
    Object.assign(process.env, BASE_VALID_ENV, {
      DB_SERVICE_POOL_MAX: "4",
      DB_READ_POOL_MAX: "2",
    });
    delete process.env.DB_SERVICE_ROLE_BUDGET;
    delete process.env.JOB_LEADER_ELECTION_ENABLED;

    const { resolveServiceDb, resolveServiceReadDb } = await import(
      "@/bootstrap/container"
    );
    const service = resolveServiceDb().$client.options.max;
    const read = resolveServiceReadDb().$client.options.max;

    expect(service).toBe(2);
    expect(read).toBe(1);
    // + 1 leader connection <= 4 per pod; two pods <= role ceiling 8.
    expect(service + read + 1).toBeLessThanOrEqual(4);
  });

  it("returns the same read-pool instance on repeated resolution (lazy singleton)", async () => {
    Object.assign(process.env, BASE_VALID_ENV);

    const { resolveServiceReadDb } = await import("@/bootstrap/container");

    expect(resolveServiceReadDb()).toBe(resolveServiceReadDb());
  });
});

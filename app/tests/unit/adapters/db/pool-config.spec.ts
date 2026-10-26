// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/db/pool-config`
 * Purpose: Verify the conservative app default preserves explicit runtime overrides.
 * Scope: Lazy client binding and nonsecret configuration evidence.
 * Invariants: No clamp; service/read pool defaults remain unchanged.
 * Side-effects: none (mocked factories/logger).
 * @internal
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serverSchema } from "@/shared/env/server-env";

const fakes = vi.hoisted(() => ({
  app: vi.fn(() => ({ role: "app" })),
  info: vi.fn(),
}));
vi.mock("@cogni/db-client", () => ({ createAppDbClient: fakes.app }));
vi.mock("@/shared/config/repoSpec.server", () => ({
  getNodeId: () => "test-node",
}));
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: { DB_POOL_CONFIGURED: "adapter.db_pool.configured" },
  makeLogger: () => ({ info: fakes.info }),
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ DATABASE_URL: "app-dsn", DB_POOL_MAX: 3 }),
}));

describe("app runtime pool configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("preserves the explicit maximum and logs safe configuration once", async () => {
    const { getAppDb } = await import("@/adapters/server/db/drizzle.client");
    expect(getAppDb()).toBe(getAppDb());
    expect(fakes.app).toHaveBeenCalledExactlyOnceWith("app-dsn", { max: 3 });
    expect(fakes.info).toHaveBeenCalledExactlyOnceWith(
      {
        event: "adapter.db_pool.configured",
        role: "app",
        requestedMax: 3,
        max: 3,
        pid: process.pid,
      },
      "adapter.db_pool.configured"
    );
  });

  it("defaults only the app pool to one and preserves injected settings", () => {
    const schema = serverSchema.pick({
      DB_POOL_MAX: true,
      DB_SERVICE_POOL_MAX: true,
      DB_READ_POOL_MAX: true,
    });
    expect(schema.parse({})).toEqual({
      DB_POOL_MAX: 1,
      DB_SERVICE_POOL_MAX: 10,
      DB_READ_POOL_MAX: 5,
    });
    expect(
      schema.parse({
        DB_POOL_MAX: "",
        DB_SERVICE_POOL_MAX: "",
        DB_READ_POOL_MAX: "",
      })
    ).toEqual({ DB_POOL_MAX: 1, DB_SERVICE_POOL_MAX: 10, DB_READ_POOL_MAX: 5 });
    expect(
      schema.parse({
        DB_POOL_MAX: "3",
        DB_SERVICE_POOL_MAX: "4",
        DB_READ_POOL_MAX: "2",
      })
    ).toEqual({ DB_POOL_MAX: 3, DB_SERVICE_POOL_MAX: 4, DB_READ_POOL_MAX: 2 });
  });
});

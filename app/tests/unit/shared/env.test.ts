// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/env/server`
 * Purpose: Verifies environment variable validation and schema parsing of server and client env modules under different env conditions.
 * Scope: Covers Zod schema validation, env var processing, and error cases. Does NOT test actual env loading or runtime behavior.
 * Invariants: Module cache resets between tests; env vars restore consistently; validation errors throw with expected messages.
 * Side-effects: process.env
 * Notes: Uses vi.resetModules for fresh imports; tests both server and client schemas; env restoration via beforeEach/afterEach.
 * Links: src/shared/env/server.ts, src/shared/env/client.ts
 * @public
 */

import { BASE_VALID_ENV } from "@tests/_fixtures/env/base-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules(); // clear Node's module cache
  process.env = { ...ORIGINAL_ENV }; // clean copy for each test
});

afterEach(() => {
  process.env = ORIGINAL_ENV; // restore after suite
});

describe("env schemas", () => {
  it("parses minimal valid env with distinct DB users", async () => {
    Object.assign(process.env, {
      ...BASE_VALID_ENV,
      LITELLM_MASTER_KEY: "adminkey",
      NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "test-project-id",
    });

    const { serverEnv } = await import("@/shared/env/server");
    const { clientEnv } = await import("@/shared/env/client");

    const env = serverEnv();
    // DATABASE_URL comes from BASE_VALID_ENV (app_user)
    expect(env.DATABASE_URL).toBe(
      "postgresql://app_user:password@localhost:5432/test_db"
    );
    expect(clientEnv().NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID).toBe(
      "test-project-id"
    );
  });

  it("uses provided DATABASE_URL when present", async () => {
    Object.assign(process.env, {
      ...BASE_VALID_ENV,
      DATABASE_URL: "sqlite://build.db",
      LITELLM_MASTER_KEY: "adminkey",
      NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "test-project-id",
    });

    const { serverEnv } = await import("@/shared/env/server");

    const env = serverEnv();
    expect(env.DATABASE_URL).toBe("sqlite://build.db");
  });

  it("throws when DATABASE_URL is missing", async () => {
    const envWithoutDbUrl = { ...BASE_VALID_ENV };
    // @ts-expect-error - intentionally removing required field for test
    delete envWithoutDbUrl.DATABASE_URL;

    Object.assign(process.env, envWithoutDbUrl);
    // Explicitly delete to prevent DATABASE_URL inherited from outer CI env leaking in
    delete process.env.DATABASE_URL;

    const { serverEnv } = await import("@/shared/env/server");

    expect(() => serverEnv()).toThrow();
  });

  it("throws when DATABASE_URL and DATABASE_SERVICE_URL use same user", async () => {
    Object.assign(process.env, {
      ...BASE_VALID_ENV,
      // Both use same user - violates role separation requirement
      DATABASE_URL: "postgresql://same_user:pass@localhost:5432/db",
      DATABASE_SERVICE_URL: "postgresql://same_user:pass@localhost:5432/db",
    });

    const { serverEnv } = await import("@/shared/env/server");

    expect(() => serverEnv()).toThrow(/same user/i);
  });

  it("throws when DATABASE_URL uses superuser", async () => {
    Object.assign(process.env, {
      ...BASE_VALID_ENV,
      // Using postgres superuser - violates security requirement
      DATABASE_URL: "postgresql://postgres:pass@localhost:5432/db",
      DATABASE_SERVICE_URL: "postgresql://app_service:pass@localhost:5432/db",
    });

    const { serverEnv } = await import("@/shared/env/server");

    expect(() => serverEnv()).toThrow(/superuser/i);
  });

  it("throws when DATABASE_SERVICE_URL uses superuser", async () => {
    Object.assign(process.env, {
      ...BASE_VALID_ENV,
      DATABASE_URL: "postgresql://app_user:pass@localhost:5432/db",
      // Using root superuser - violates security requirement
      DATABASE_SERVICE_URL: "postgresql://root:pass@localhost:5432/db",
    });

    const { serverEnv } = await import("@/shared/env/server");

    expect(() => serverEnv()).toThrow(/superuser/i);
  });

  it("allows non-PostgreSQL URLs to bypass role checks", async () => {
    // sqlite URLs don't have meaningful usernames, so role checks are skipped
    Object.assign(process.env, {
      ...BASE_VALID_ENV,
      DATABASE_URL: "sqlite://build.db",
      DATABASE_SERVICE_URL: "sqlite://build.db",
    });

    const { serverEnv } = await import("@/shared/env/server");

    // Should not throw - non-PostgreSQL URLs skip role separation checks
    const env = serverEnv();
    expect(env.DATABASE_URL).toBe("sqlite://build.db");
  });

  // PAPER_ENFORCE_MODE regression (prod 503 / CONTAINER_INIT_FAILED).
  // `.cogni/repo-spec.yaml` documents production as `PAPER_ENFORCE_MODE=live`
  // and OpenBao holds that literal, but the schema only admitted "paper" — so
  // the value the deploy contract prescribes bricked container init on every
  // API route. The wire accepts unset | "live" | "paper"; code sees only
  // `"paper" | undefined`.
  describe("PAPER_ENFORCE_MODE", () => {
    async function parseWith(value: string | undefined) {
      Object.assign(process.env, {
        ...BASE_VALID_ENV,
        LITELLM_MASTER_KEY: "adminkey",
        NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "test-project-id",
      });
      if (value === undefined) {
        // biome-ignore lint/performance/noDelete: env cleanup for this case
        delete process.env.PAPER_ENFORCE_MODE;
      } else {
        process.env.PAPER_ENFORCE_MODE = value;
      }
      const { serverEnv } = await import("@/shared/env/server");
      return serverEnv();
    }

    it("accepts the production value 'live' and normalizes it to undefined", async () => {
      const env = await parseWith("live");
      expect(env.PAPER_ENFORCE_MODE).toBeUndefined();
    });

    it("keeps 'paper' so paper-only envs still short-circuit the live executor", async () => {
      const env = await parseWith("paper");
      expect(env.PAPER_ENFORCE_MODE).toBe("paper");
    });

    it("treats unset and empty as undefined", async () => {
      expect((await parseWith(undefined)).PAPER_ENFORCE_MODE).toBeUndefined();
      vi.resetModules();
      expect((await parseWith("")).PAPER_ENFORCE_MODE).toBeUndefined();
    });

    it("still hard-fails an unrecognized value rather than assuming live", async () => {
      // Fail-safe direction: a typo must refuse to boot, never silently route
      // a paper-only env onto the live CLOB with real USDC.
      await expect(parseWith("papper")).rejects.toThrow();
    });
  });

  // TODO: this fail-fast test being flaky
  it.skip("throws when required server vars are missing", async () => {
    Object.assign(process.env, {
      NODE_ENV: "test",
      // intentionally missing required keys
    });

    await expect(async () => {
      const { serverEnv } = await import("../../../src/shared/env/server");
      serverEnv(); // should throw ZodError
    }).rejects.toThrow();
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { BASE_VALID_ENV } from "@tests/_fixtures/env/base-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = process.env;

describe("paper trading env invariants", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("defaults the sidecar URL to pod loopback and paper mode", async () => {
    Object.assign(process.env, BASE_VALID_ENV);

    const { serverEnv } = await import("@/shared/env/server");
    const env = serverEnv();

    expect(env.PAPER_SIDECAR_URL).toBe("http://127.0.0.1:9100");
    expect(env.PAPER_ENFORCE_MODE).toBe("paper");
  });

  it("requires paper mode in candidate and preview environments", async () => {
    Object.assign(process.env, {
      ...BASE_VALID_ENV,
      DEPLOY_ENVIRONMENT: "candidate-a",
      PAPER_ENFORCE_MODE: "disabled",
    });

    const { serverEnv } = await import("@/shared/env/server");

    expect(() => serverEnv()).toThrow(/PAPER_ENFORCE_MODE=paper/);
  });

  it("blocks live mode without explicit approval", async () => {
    Object.assign(process.env, {
      ...BASE_VALID_ENV,
      DEPLOY_ENVIRONMENT: "production",
      PAPER_ENFORCE_MODE: "live",
      PAPER_LIVE_TRADING_APPROVED: "false",
    });

    const { serverEnv } = await import("@/shared/env/server");

    expect(() => serverEnv()).toThrow(/PAPER_LIVE_TRADING_APPROVED=true/);
  });
});

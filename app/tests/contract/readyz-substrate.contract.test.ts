// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/readyz-substrate.contract`
 * Purpose: Prove the shallow/deep readiness contract for async substrate dependencies.
 * Scope: Exercises the /readyz route with isolated Temporal and scheduler-worker probes. Does not perform network or database IO.
 * Invariants: Default readiness stays healthy while emitting critical dependency events; `?deep=1` returns 503 for either missing dependency.
 * Side-effects: none
 * Links: src/app/(infra)/readyz/route.ts, Cogni-DAO/cogni#1860
 * @internal
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertEvmRpcConfig: vi.fn(),
  assertRuntimeSecrets: vi.fn(),
  assertSchedulerWorkerConnectivity: vi.fn(),
  assertTemporalConnectivity: vi.fn(),
  checkEvmRpcConnectivity: vi.fn(),
  error: vi.fn(),
  serverEnv: vi.fn(),
  setBuildInfo: vi.fn(),
  verifySystemTenant: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    paymentRailsActive: false,
    scheduleControl: {},
    serviceAccountService: {},
  }),
}));

vi.mock("@/bootstrap/healthchecks", () => ({
  verifySystemTenant: (...args: unknown[]) =>
    mocks.verifySystemTenant(...args),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (
        ctx: {
          log: {
            debug: ReturnType<typeof vi.fn>;
            error: ReturnType<typeof vi.fn>;
            info: ReturnType<typeof vi.fn>;
            warn: ReturnType<typeof vi.fn>;
          };
        },
        request: NextRequest
      ) => Promise<Response>
    ) =>
    async (request: NextRequest) =>
      handler(
        {
          log: {
            debug: vi.fn(),
            error: mocks.error,
            info: vi.fn(),
            warn: vi.fn(),
          },
        },
        request
      ),
}));

vi.mock("@/shared/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/env")>();
  return {
    ...actual,
    serverEnv: () => mocks.serverEnv(),
  };
});

vi.mock("@/shared/env/invariants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/env/invariants")>();
  return {
    ...actual,
    assertEvmRpcConfig: (...args: unknown[]) =>
      mocks.assertEvmRpcConfig(...args),
    assertRuntimeSecrets: (...args: unknown[]) =>
      mocks.assertRuntimeSecrets(...args),
    assertSchedulerWorkerConnectivity: (...args: unknown[]) =>
      mocks.assertSchedulerWorkerConnectivity(...args),
    assertTemporalConnectivity: (...args: unknown[]) =>
      mocks.assertTemporalConnectivity(...args),
    checkEvmRpcConnectivity: (...args: unknown[]) =>
      mocks.checkEvmRpcConnectivity(...args),
  };
});

vi.mock("@/shared/observability/server/metrics", () => ({
  setBuildInfo: (...args: unknown[]) => mocks.setBuildInfo(...args),
}));

import { GET } from "@/app/(infra)/readyz/route";
import { InfraConnectivityError } from "@/shared/env/invariants";

function request(path = "/readyz"): NextRequest {
  return new NextRequest(`http://localhost:3200${path}`);
}

describe("GET /readyz async substrate contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.serverEnv.mockReturnValue({
      APP_BUILD_SHA: "readyz-contract-sha",
      APP_ENV: "test",
    });
    mocks.assertTemporalConnectivity.mockResolvedValue(undefined);
    mocks.assertSchedulerWorkerConnectivity.mockResolvedValue(undefined);
    mocks.checkEvmRpcConnectivity.mockResolvedValue({ ok: true });
    mocks.verifySystemTenant.mockResolvedValue(undefined);
  });

  it("keeps shallow readiness healthy and critically observes both missing dependencies", async () => {
    mocks.assertTemporalConnectivity.mockRejectedValue(
      new InfraConnectivityError("Temporal is unavailable")
    );
    mocks.assertSchedulerWorkerConnectivity.mockRejectedValue(
      new InfraConnectivityError("scheduler-worker is unavailable")
    );

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "healthy",
      buildSha: "readyz-contract-sha",
    });
    expect(mocks.verifySystemTenant).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledTimes(2);
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.temporal.unreachable",
        severity: "critical",
        reason: "INFRA_UNREACHABLE",
        dependency: "temporal",
      }),
      expect.stringContaining("MISSION-CRITICAL async substrate down")
    );
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.scheduler_worker.unreachable",
        severity: "critical",
        reason: "INFRA_UNREACHABLE",
        dependency: "scheduler-worker",
      }),
      expect.stringContaining("MISSION-CRITICAL async substrate down")
    );
  });

  it("returns 503 from the deep probe when Temporal is unavailable", async () => {
    mocks.assertTemporalConnectivity.mockRejectedValue(
      new InfraConnectivityError("Temporal is unavailable")
    );

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "Temporal is unavailable",
    });
    expect(mocks.assertSchedulerWorkerConnectivity).not.toHaveBeenCalled();
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
  });

  it("returns 503 from the deep probe when scheduler-worker is unavailable", async () => {
    mocks.assertSchedulerWorkerConnectivity.mockRejectedValue(
      new InfraConnectivityError("scheduler-worker is unavailable")
    );

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "scheduler-worker is unavailable",
    });
    expect(mocks.assertTemporalConnectivity).toHaveBeenCalledOnce();
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
  });
});

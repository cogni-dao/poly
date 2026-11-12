// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/startup-assertions`
 * Purpose: Prove the boot-time provisioning assertion fails the pod when the system tenant is absent or unreachable (bug.0022).
 * Scope: Unit test with a mocked verifySystemTenant and injected exit; no database IO.
 * Invariants: Rejection => critical log + exit(1); success => no exit; a hung check is bounded; tests stay inert by default.
 * Side-effects: none
 * Links: src/bootstrap/startup-assertions.ts
 * @internal
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifySystemTenant: vi.fn(),
  loggerConstruction: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/bootstrap/healthchecks", () => ({
  verifySystemTenant: (...args: unknown[]) => mocks.verifySystemTenant(...args),
}));
vi.mock("@/shared/observability", () => ({
  makeLogger: () => { mocks.loggerConstruction(); return { error: mocks.error }; },
}));

import type { ServiceAccountService } from "@/ports";
import {
  assertSystemTenantAtBoot,
  resetStartupAssertionsForTest,
  startSystemTenantAssertionOnBoot,
} from "@/bootstrap/startup-assertions";

const service = {} as ServiceAccountService;

beforeEach(() => {
  vi.clearAllMocks();
  resetStartupAssertionsForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("boot system-tenant assertion (bug.0022)", () => {
  it("exits non-zero and logs critical when verifySystemTenant rejects", async () => {
    mocks.verifySystemTenant.mockRejectedValue(
      new Error("FATAL: cogni_system billing account missing. Run migrations.")
    );
    const exit = vi.fn();

    const pending = startSystemTenantAssertionOnBoot(service, { exit, force: true });
    expect(startSystemTenantAssertionOnBoot(service, { exit, force: true })).toBe(pending);
    await expect(pending).rejects.toThrow();

    expect(mocks.verifySystemTenant).toHaveBeenCalledWith(service);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "startup.system_tenant.failed",
        severity: "critical",
      }),
      expect.stringContaining("exiting")
    );
  });

  it("does not exit when the system tenant is provisioned", async () => {
    mocks.verifySystemTenant.mockResolvedValue(undefined);
    const exit = vi.fn();

    await startSystemTenantAssertionOnBoot(service, { exit, force: true });

    expect(exit).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("rejects from assertSystemTenantAtBoot rather than swallowing the error", async () => {
    mocks.verifySystemTenant.mockRejectedValue(new Error("connection refused"));

    await expect(assertSystemTenantAtBoot(service)).rejects.toThrow(
      "connection refused"
    );
  });

  it("bounds a hung check and fails the pod instead of hanging boot", async () => {
    vi.useFakeTimers();
    mocks.verifySystemTenant.mockReturnValue(new Promise<never>(() => {}));
    const exit = vi.fn();

    const pending = startSystemTenantAssertionOnBoot(service, {
      exit,
      force: true,
      timeoutMs: 5000,
    });
    const rejection = expect(pending).rejects.toThrow("exceeded");
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "critical" }),
      expect.any(String)
    );
  });

  it("runs once per process", async () => {
    mocks.verifySystemTenant.mockResolvedValue(undefined);
    const exit = vi.fn();

    await startSystemTenantAssertionOnBoot(service, { exit, force: true });
    await startSystemTenantAssertionOnBoot(service, { exit, force: true });

    expect(mocks.verifySystemTenant).toHaveBeenCalledTimes(1);
  });

  it("is inert under test unless forced", async () => {
    const exit = vi.fn();

    await startSystemTenantAssertionOnBoot(service, { exit });

    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
  it("exits once and retains the original rejection if diagnostic emission fails", async () => {
    const original = new Error("private-tenant-detail");
    mocks.verifySystemTenant.mockRejectedValue(original);
    mocks.error.mockImplementationOnce(() => { throw new Error("logger failed"); });
    const exit = vi.fn();
    const pending = startSystemTenantAssertionOnBoot(service, { exit, force: true });
    await expect(pending).rejects.toBe(original);
    expect(startSystemTenantAssertionOnBoot(service, { exit, force: true })).toBe(pending);
    await expect(pending).rejects.toBe(original);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("exits once and retains the rejection if diagnostic construction fails", async () => {
    const original = new Error("private-tenant-detail");
    mocks.verifySystemTenant.mockRejectedValue(original);
    mocks.loggerConstruction.mockImplementationOnce(() => { throw new Error("logger failed"); });
    const exit = vi.fn();
    const pending = startSystemTenantAssertionOnBoot(service, { exit, force: true });
    await expect(pending).rejects.toBe(original);
    expect(startSystemTenantAssertionOnBoot(service, { exit, force: true })).toBe(pending);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

});

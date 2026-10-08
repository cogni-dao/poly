// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  attemptGovernanceStartupReconcile,
  type GovernanceStartupReconcileDeps,
} from "@/bootstrap/startup-reconcile";

function setup(runSync: GovernanceStartupReconcileDeps["runSync"]) {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Pick<Logger, "info" | "warn" | "error">;
  const scheduled: Array<() => void> = [];
  const scheduleRetry = vi.fn((callback: () => void) => {
    scheduled.push(callback);
  });
  const deps: GovernanceStartupReconcileDeps = {
    runSync,
    log,
    scheduleRetry,
    maxAttempts: 2,
    retryDelayMs: 15_000,
  };
  return { deps, log, scheduled, scheduleRetry };
}

describe("governance startup reconcile", () => {
  it("logs a successful direct reconcile without scheduling HTTP retries", async () => {
    const runSync = vi.fn().mockResolvedValue({ created: 1 });
    const { deps, log, scheduleRetry } = setup(runSync);

    await attemptGovernanceStartupReconcile(deps, 1);

    expect(runSync).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        event: "governance.startup_reconcile.complete",
      }),
      expect.any(String)
    );
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it("logs and schedules a bounded retry, then emits terminal failure", async () => {
    const runSync = vi.fn().mockRejectedValue(new Error("temporal unavailable"));
    const { deps, log, scheduled, scheduleRetry } = setup(runSync);

    await attemptGovernanceStartupReconcile(deps, 1);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        event: "governance.startup_reconcile.retry",
      }),
      expect.any(String)
    );
    expect(scheduleRetry).toHaveBeenCalledWith(
      expect.any(Function),
      15_000
    );

    scheduled[0]?.();
    await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 2,
          event: "governance.startup_reconcile.failed",
        }),
        expect.any(String)
      )
    );
    expect(scheduleRetry).toHaveBeenCalledOnce();
  });
});

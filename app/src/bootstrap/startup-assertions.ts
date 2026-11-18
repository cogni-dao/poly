// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/startup-assertions`
 * Purpose: Assert node provisioning invariants once at process boot (bug.0022).
 * Scope: Verifies the cogni_system tenant exists on native startup; a pod that fails it exits non-zero. Does not monitor ongoing health.
 * Invariants:
 *   - SYSTEM_TENANT_STARTUP_CHECK: an unprovisioned pod crash-loops instead of serving; `/readyz` no longer hard-gates on this DB check.
 *   - Bounded: a hung connect fails the pod after BOOT_SYSTEM_TENANT_TIMEOUT_MS rather than hanging boot.
 *   - The failure is never swallowed: it is logged critical, then the process exits 1.
 *   - CAPACITY_IS_NOT_UNPROVISIONED (bug.5064): a DB connection-capacity failure (53300) is
 *     logged as a warning and boot continues — only a real missing tenant / other error exits.
 *   - Tests are inert (APP_ENV=test / VITEST).
 * Side-effects: IO (one database query), process exit on failure.
 * Links: bootstrap/healthchecks.ts, bootstrap/container.ts, app/(infra)/readyz/readyz-probes.ts
 * @public
 */

import type { ServiceAccountService } from "@/ports";
import { makeLogger } from "@/shared/observability";
import { isDbCapacityError } from "@/shared/observability/db-capacity-error";
import { safeErrorDimensions } from "@/shared/observability/safe-error-dimensions";
import { verifySystemTenant } from "./healthchecks";

/** Upper bound on the boot-time tenant query so a wedged connect cannot hang boot. */
export const BOOT_SYSTEM_TENANT_TIMEOUT_MS = 10_000;

let started: Promise<void> | undefined;

/** Reject if the system tenant is absent, the DB errors, or the budget is exceeded. */
export async function assertSystemTenantAtBoot(
  serviceAccountService: ServiceAccountService,
  timeoutMs: number = BOOT_SYSTEM_TENANT_TIMEOUT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `FATAL: system tenant boot check exceeded ${timeoutMs}ms budget`
          )
        ),
      timeoutMs
    );
  });
  try {
    await Promise.race([verifySystemTenant(serviceAccountService), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Once-per-process boot hook. Runs `assertSystemTenantAtBoot`; on failure logs
 * critical and exits 1 so the pod crash-loops. `exit` is injectable for tests.
 */
export function startSystemTenantAssertionOnBoot(
  serviceAccountService: ServiceAccountService,
  options: {
    exit?: (code: number) => void;
    timeoutMs?: number;
    force?: boolean;
  } = {}
): Promise<void> {
  // biome-ignore lint/style/noProcessEnv: startup gate before container config
  const isTest = process.env.APP_ENV === "test" || process.env.VITEST === "true";
  if (started) return started;
  if (isTest && !options.force) return Promise.resolve();
  const exit = options.exit ?? ((code: number) => process.exit(code));
  started = assertSystemTenantAtBoot(
    serviceAccountService,
    options.timeoutMs
  ).catch((error: unknown) => {
    // bug.5064: a saturated service role (SQLSTATE 53300) says nothing about
    // provisioning — it is transient capacity shared across lanes. Exiting here
    // crash-loops the pod so /version never answers. Serve instead; /readyz?deep=1
    // keeps reporting postgres failed until a connection is available.
    if (isDbCapacityError(error)) {
      try {
        makeLogger({ component: "startup-assertions" }).warn(
          {
            event: "startup.system_tenant.deferred_db_capacity",
            severity: "warning",
            ...safeErrorDimensions(error),
          },
          "system tenant check skipped: database connection capacity exhausted; serving"
        );
      } catch {
        // Diagnostics must never block boot.
      }
      return;
    }
    try {
      makeLogger({ component: "startup-assertions" }).error(
        { event: "startup.system_tenant.failed", severity: "critical", errorCode: "SYSTEM_TENANT_QUALIFICATION_FAILED" },
        "system tenant qualification failed; exiting"
      );
    } catch {
      // Diagnostics cannot replace the qualification rejection or prevent exit.
    }
    exit(1);
    throw error;
  });
  return started;
}

/** Test-only: allow the once-per-process guard to re-arm. */
export function resetStartupAssertionsForTest(): void {
  started = undefined;
}

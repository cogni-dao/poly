// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Direct, observable, retrying governance schedule reconcile at app boot. */

import type { Logger } from "pino";

let started = false;
export const GOVERNANCE_RECONCILE_MAX_ATTEMPTS = 8;
export const GOVERNANCE_RECONCILE_RETRY_DELAY_MS = 15_000;

export interface GovernanceStartupReconcileDeps {
  runSync(): Promise<unknown>;
  log: Pick<Logger, "info" | "warn" | "error">;
  scheduleRetry(callback: () => void, delayMs: number): unknown;
  maxAttempts: number;
  retryDelayMs: number;
}

async function defaultRunSync(): Promise<unknown> {
  const { runGovernanceSchedulesSyncJob } = await import(
    "@/bootstrap/jobs/syncGovernanceSchedules.job"
  );
  return runGovernanceSchedulesSyncJob();
}

/** One attempt in the fail-soft startup state machine. Exported for unit proof. */
export async function attemptGovernanceStartupReconcile(
  deps: GovernanceStartupReconcileDeps,
  attempt: number
): Promise<void> {
  try {
    await deps.runSync();
    deps.log.info(
      { attempt, event: "governance.startup_reconcile.complete" },
      "Governance schedules reconciled at startup"
    );
  } catch (error) {
    if (attempt < deps.maxAttempts) {
      deps.log.warn(
        { attempt, error, event: "governance.startup_reconcile.retry" },
        "Governance startup reconcile failed; retrying"
      );
      deps.scheduleRetry(
        () => void attemptGovernanceStartupReconcile(deps, attempt + 1),
        deps.retryDelayMs
      );
      return;
    }
    deps.log.error(
      { attempt, error, event: "governance.startup_reconcile.failed" },
      "Governance startup reconcile exhausted retries"
    );
  }
}

export function startGovernanceSyncOnBoot(
  log: Pick<Logger, "info" | "warn" | "error">
): void {
  if (started) return;
  // biome-ignore lint/style/noProcessEnv: startup gate before config is available
  if (process.env.APP_ENV === "test" || process.env.VITEST === "true") return;
  started = true;
  void attemptGovernanceStartupReconcile(
    {
      runSync: defaultRunSync,
      log,
      scheduleRetry: (callback, delayMs) => setTimeout(callback, delayMs),
      maxAttempts: GOVERNANCE_RECONCILE_MAX_ATTEMPTS,
      retryDelayMs: GOVERNANCE_RECONCILE_RETRY_DELAY_MS,
    },
    1
  );
}

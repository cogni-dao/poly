// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Direct, retrying governance schedule reconcile at app boot. */

let started = false;
const MAX_ATTEMPTS = 8;
const RETRY_DELAY_MS = 15_000;

export function startGovernanceSyncOnBoot(): void {
	if (started) return;
	// biome-ignore lint/style/noProcessEnv: startup gate before config is available
	if (process.env.APP_ENV === "test" || process.env.VITEST === "true") return;
	started = true;
	void attemptReconcile(1);
}

async function attemptReconcile(attempt: number): Promise<void> {
	try {
		const { runGovernanceSchedulesSyncJob } = await import(
			"@/bootstrap/jobs/syncGovernanceSchedules.job"
		);
		await runGovernanceSchedulesSyncJob();
	} catch {
		if (attempt < MAX_ATTEMPTS) {
			setTimeout(() => void attemptReconcile(attempt + 1), RETRY_DELAY_MS);
		}
	}
}

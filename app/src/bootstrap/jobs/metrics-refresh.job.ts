// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** One node-owned refresh clock on the existing worker. No metrics workflow or worker. */
import { toUserId } from "@cogni/ids";
import { SYSTEM_ACTOR } from "@cogni/ids/system";
import {
	COGNI_SYSTEM_BILLING_ACCOUNT_ID,
	COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import { getContainer } from "@/bootstrap/container";
import { getNodeId } from "@/shared/config";
export const METRICS_REFRESH_ROUTE = "/api/internal/metrics/refresh";
export async function ensureMetricsRefreshSchedule() {
	const container = getContainer();
	const nodeId = getNodeId();
	const grant = await container.executionGrantPort.ensureGrant({
		userId: toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID),
		billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
		scopes: [`task:dispatch:${nodeId}:${METRICS_REFRESH_ROUTE}`],
	});
	const scheduleId = `metrics:${nodeId}:refresh`;
	const params = {
		scheduleId,
		nodeId,
		ownerUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
		cron: "* * * * *",
		timezone: "UTC",
		graphId: `task:${METRICS_REFRESH_ROUTE}`,
		executionGrantId: grant.id,
		input: { executionGrantId: grant.id },
		workflowType: "NodeTaskWorkflow",
		overlapPolicy: "skip" as const,
		catchupWindowMs: 0,
	};
	const previous = await container.scheduleControl.describeSchedule(scheduleId);
	if (previous)
		await container.scheduleControl.updateSchedule(scheduleId, params);
	else {
		try {
			await container.scheduleControl.createSchedule(params);
		} catch (error) {
			// Another replica, or an ambiguous create, may already own this ID.
			// Reconcile the observed schedule instead of creating another clock.
			const current =
				await container.scheduleControl.describeSchedule(scheduleId);
			if (!current) throw error;
			await container.scheduleControl.updateSchedule(scheduleId, params);
		}
	}
	const current =
		await container.scheduleControl.describeSchedule(scheduleId);
	return {
		scheduleId,
		paused: current?.isPaused ?? false,
		nextRunAt: current?.nextRunAtIso,
	};
}
export async function runMetricsRefresh(executionGrantId: string) {
	const c = getContainer();
	const nodeId = getNodeId();
	await c.executionGrantWorkerPort.validateGrantForScope(
		SYSTEM_ACTOR,
		nodeId,
		executionGrantId,
		`task:dispatch:${nodeId}:${METRICS_REFRESH_ROUTE}`,
	);
	if (!c.goalMetrics) throw new Error("metrics_unavailable");
	return c.goalMetrics.refreshDue();
}

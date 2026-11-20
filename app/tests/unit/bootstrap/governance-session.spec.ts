// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	held: false,
	acquired: true,
	unlockFails: false,
	callbackFails: false,
	existing: true,
	acquireFails: false,
	releases: 0,
	queries: 0,
	waiters: [] as (() => void)[],
	makeDb: null as null | ((client: unknown) => unknown),
}));
vi.mock("@cogni/ids", () => ({ toUserId: (id: string) => id }));
vi.mock("@cogni/node-shared", () => ({
	COGNI_SYSTEM_BILLING_ACCOUNT_ID: "billing",
	COGNI_SYSTEM_PRINCIPAL_USER_ID: "system",
}));
vi.mock("@/shared/db/schema", () => ({
	schedules: { id: "id", ownerUserId: "owner", temporalScheduleId: "temporal" },
}));
vi.mock("drizzle-orm", () => ({ and: () => null, eq: () => null }));
vi.mock("@/shared/config", () => ({
	getGovernanceConfig: () => ({}),
	getNodeId: () => "node",
}));
vi.mock("@/shared/env/server-env", () => ({
	serverEnv: () => ({ GOVERNANCE_SCHEDULES_ENABLED: true }),
}));
vi.mock("@/bootstrap/container", () => ({
	getContainer: () => ({
		log: { info() {}, warn() {} },
		executionGrantPort: { ensureGrant: async () => ({ id: "grant" }) },
		scheduleControl: { listScheduleIds: async () => [] },
	}),
}));
vi.mock("@cogni/scheduler-core", () => ({
	syncGovernanceSchedules: async (
		_config: unknown,
		deps: {
			ensureGovernanceGrant: () => Promise<unknown>;
			upsertGovernanceScheduleRow: (input: {
				cron: string;
				timezone: string;
				ownerUserId: string;
				temporalScheduleId: string;
				executionGrantId: string;
				graphId: string;
				input: object;
			}) => Promise<unknown>;
			disableSchedule: (id: string) => Promise<unknown>;
		},
	) => {
		await deps.ensureGovernanceGrant();
		await deps.upsertGovernanceScheduleRow({
			cron: "0 * * * *",
			timezone: "UTC",
			ownerUserId: "system",
			temporalScheduleId: "governance:test",
			executionGrantId: "grant",
			graphId: "graph",
			input: {},
		});
		await deps.disableSchedule("governance:old");
		if (state.callbackFails) throw new Error("callback failure");
		return { created: [], updated: [], resumed: [], skipped: [], paused: [] };
	},
}));
vi.mock("@/adapters/server/db/drizzle.service-client", () => {
	const query = async (pinned: boolean, select = false) => {
		if (!pinned && state.held)
			await new Promise<void>((resolve) => state.waiters.push(resolve));
		state.queries++;
		return select && !state.existing ? [] : [{ id: "row" }];
	};
	const db = (pinned: boolean) => ({
		select: () => ({
			from: () => ({ where: () => ({ limit: () => query(pinned, true) }) }),
		}),
		update: () => ({ set: () => ({ where: () => query(pinned) }) }),
		insert: () => ({ values: () => ({ returning: () => query(pinned) }) }),
	});
	state.makeDb = (client) => db(client === reserved);
	const reserved = Object.assign(
		async (strings: TemplateStringsArray) => {
			if (strings[0]?.includes("pg_try_advisory_lock")) {
				if (state.acquireFails) throw new Error("acquire failure");
				return [{ acquired: state.acquired }];
			}
			if (state.unlockFails) throw new Error("unlock failure");
			return [{ pg_advisory_unlock: true }];
		},
		{
			release: () => {
				state.held = false;
				state.releases++;
				for (const wake of state.waiters.splice(0)) wake();
			},
		},
	);
	return {
		getServiceDb: () => ({
			...db(false),
			$client: {
				reserve: async () => {
					state.held = true;
					return reserved;
				},
			},
		}),
		fakePinnedDb: () => db(true),
	};
});
vi.mock("drizzle-orm/postgres-js", () => ({
	drizzle: (client: unknown) => state.makeDb?.(client),
}));

import { runGovernanceSchedulesSyncJob } from "@/bootstrap/jobs/syncGovernanceSchedules.job";

describe("governance sync with a one-connection service pool", () => {
	beforeEach(() => {
		state.held = false;
		state.acquired = true;
		state.unlockFails = false;
		state.callbackFails = false;
		state.existing = true;
		state.acquireFails = false;
		state.releases = 0;
		state.queries = 0;
		state.waiters = [];
	});
	it("finishes service queries while holding the only connection", async () => {
		const result = await Promise.race([
			runGovernanceSchedulesSyncJob().then(() => "finished"),
			new Promise<string>((resolve) =>
				setTimeout(() => resolve("blocked"), 100),
			),
		]);
		expect(result).toBe("finished");
		expect(state.queries).toBe(3);
		expect(state.releases).toBe(1);
	});
	it("inserts a missing schedule on the held session", async () => {
		state.existing = false;
		await runGovernanceSchedulesSyncJob();
		expect(state.queries).toBe(3);
		expect(state.releases).toBe(1);
	}, 500);
	it("releases when acquisition fails", async () => {
		state.acquireFails = true;
		await expect(runGovernanceSchedulesSyncJob()).rejects.toThrow(
			"acquire failure",
		);
		expect(state.releases).toBe(1);
	});
	it("releases when the lock is refused", async () => {
		state.acquired = false;
		await runGovernanceSchedulesSyncJob();
		expect(state.releases).toBe(1);
		expect(state.queries).toBe(0);
	});
	it("releases on callback failure", async () => {
		state.callbackFails = true;
		await expect(runGovernanceSchedulesSyncJob()).rejects.toThrow(
			"callback failure",
		);
		expect(state.releases).toBe(1);
	}, 500);
	it("releases when unlock fails", async () => {
		state.unlockFails = true;
		await expect(runGovernanceSchedulesSyncJob()).rejects.toThrow(
			"unlock failure",
		);
		expect(state.releases).toBe(1);
	}, 500);
});

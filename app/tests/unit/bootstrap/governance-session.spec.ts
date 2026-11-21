// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	held: false,
	lockHeld: false,
	acquired: true,
	acquireFailsAt: 0,
	callbackFails: false,
	existing: true,
	newLedger: false,
	invalidLedgerRow: false,
	refuseEager: false,
	failEndAt: 0,
	triggerFails: false,
	triggers: 0,
	phases: 0,
	commits: 0,
	rollbacks: 0,
	endedSessions: 0,
	unsafeReuses: 0,
	queries: 0,
	events: [] as string[],
	waiters: [] as (() => void)[],
	makeDb: null as null | ((client: unknown) => unknown),
}));
vi.mock("@cogni/ids", () => ({ toUserId: (id: string) => id }));
vi.mock("@cogni/node-shared", () => ({
	COGNI_SYSTEM_BILLING_ACCOUNT_ID: "billing",
	COGNI_SYSTEM_PRINCIPAL_USER_ID: "system",
}));
vi.mock("@/shared/db/schema", () => ({
	schedules: {
		id: "id",
		ownerUserId: "owner",
		temporalScheduleId: "temporal",
		enabled: "enabled",
	},
}));
// Keep drizzle-orm real: a partial root mock breaks built schema barrels using sql.
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
		scheduleControl: {
			listScheduleIds: async () => [],
			triggerSchedule: async () => {
				state.events.push("trigger");
				state.triggers++;
				if (state.triggerFails) throw new Error("trigger acknowledgement lost");
			},
		},
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
			temporalScheduleId: state.newLedger
				? "governance:ledger_ingest"
				: "governance:test",
			executionGrantId: "grant",
			graphId: "graph",
			input: {},
		});
		await deps.disableSchedule("governance:old");
		if (state.callbackFails) throw new Error("callback failure");
		return {
			created: state.newLedger ? ["governance:ledger_ingest"] : [],
			updated: [],
			resumed: [],
			skipped: [],
			paused: [],
		};
	},
}));
vi.mock("@/adapters/server/db/drizzle.service-client", () => {
	const freeResource = () => {
		state.held = false;
		for (const wake of state.waiters.splice(0)) wake();
	};
	const query = async (pinned: boolean, phase: number, select = false) => {
		if (!pinned && state.held)
			await new Promise<void>((resolve) => state.waiters.push(resolve));
		if (pinned && !state.lockHeld)
			throw new Error("query outside lock ownership");
		state.queries++;
		if (phase === 2) {
			state.events.push("revalidate");
			return state.invalidLedgerRow ? [] : [{ id: "row" }];
		}
		return select && !state.existing ? [] : [{ id: "row" }];
	};
	const acquire = (phase: number) => {
		if (state.acquireFailsAt === phase) throw new Error("acquire failure");
		const acquired = state.acquired && !(phase === 2 && state.refuseEager);
		state.lockHeld = acquired;
		state.events.push(`lock:${phase}`);
		return [{ acquired }];
	};
	const db = (pinned: boolean, phase = 0) => ({
		execute: async () => acquire(phase),
		select: () => ({
			from: () => ({
				where: () => ({ limit: () => query(pinned, phase, true) }),
			}),
		}),
		update: () => ({ set: () => ({ where: () => query(pinned, phase) }) }),
		insert: () => ({
			values: () => ({ returning: () => query(pinned, phase) }),
		}),
	});
	// Retain the previous public reservation seam for meaningful before/after proof:
	// the old job must reach unsafe unlock/reuse, rather than a missing mock method.
	const reserved = Object.assign(
		async (strings: TemplateStringsArray) => {
			if (strings[0]?.includes("pg_try_advisory_lock")) return acquire(1);
			if (state.failEndAt) throw new Error("session end failure");
			state.lockHeld = false;
			return [{ pg_advisory_unlock: true }];
		},
		{
			release: () => {
				if (state.lockHeld) state.unsafeReuses++;
				freeResource();
			},
		},
	);
	state.makeDb = (client) => db(client === reserved);
	return {
		getServiceDb: () => ({
			...db(false),
			$client: {
				reserve: async () => {
					state.held = true;
					return reserved;
				},
			},
			transaction: async (
				fn: (tx: ReturnType<typeof db>) => Promise<unknown>,
			) => {
				state.held = true;
				const phase = ++state.phases;
				try {
					const result = await fn(db(true, phase));
					if (state.failEndAt === phase) {
						// Model the native driver's session-loss path, not manual pool release.
						state.endedSessions++;
						state.events.push(`session-ended:${phase}`);
						throw new Error("session end failure");
					}
					state.commits++;
					state.events.push(`commit:${phase}`);
					return result;
				} catch (err) {
					if (state.failEndAt !== phase) state.rollbacks++;
					throw err;
				} finally {
					state.lockHeld = false;
					freeResource();
				}
			},
		}),
	};
});
vi.mock("drizzle-orm/postgres-js", () => ({
	drizzle: (client: unknown) => state.makeDb?.(client),
}));

import { runGovernanceSchedulesSyncJob } from "@/bootstrap/jobs/syncGovernanceSchedules.job";

function expectSafeReuse() {
	expect(state.held).toBe(false);
	expect(state.lockHeld).toBe(false);
	expect(state.unsafeReuses).toBe(0);
}

describe("governance sync with a one-connection service pool", () => {
	beforeEach(() => {
		Object.assign(state, {
			held: false,
			lockHeld: false,
			acquired: true,
			acquireFailsAt: 0,
			callbackFails: false,
			existing: true,
			newLedger: false,
			invalidLedgerRow: false,
			refuseEager: false,
			failEndAt: 0,
			triggerFails: false,
			triggers: 0,
			phases: 0,
			commits: 0,
			rollbacks: 0,
			endedSessions: 0,
			unsafeReuses: 0,
			queries: 0,
			events: [],
			waiters: [],
		});
	});
	it("finishes callback service queries while holding the only connection", async () => {
		const result = await Promise.race([
			runGovernanceSchedulesSyncJob().then(() => "finished"),
			new Promise<string>((resolve) =>
				setTimeout(() => resolve("blocked"), 100),
			),
		]);
		expect(result).toBe("finished");
		expect(state.queries).toBe(3);
		expectSafeReuse();
	});
	it("inserts a missing schedule on the lock-owning session", async () => {
		state.existing = false;
		await runGovernanceSchedulesSyncJob();
		expect(state.queries).toBe(3);
		expectSafeReuse();
	}, 500);
	it("cleans up when acquisition fails", async () => {
		state.acquireFailsAt = 1;
		await expect(runGovernanceSchedulesSyncJob()).rejects.toThrow(
			"acquire failure",
		);
		expectSafeReuse();
	});
	it("does no callback work when the lock is refused", async () => {
		state.acquired = false;
		expect(await runGovernanceSchedulesSyncJob()).toEqual({
			created: 0,
			updated: 0,
			resumed: 0,
			skipped: 0,
			paused: 0,
		});
		expect(state.queries).toBe(0);
		expectSafeReuse();
	});
	it("rolls back callback failure before the session can be reused", async () => {
		state.callbackFails = true;
		await expect(runGovernanceSchedulesSyncJob()).rejects.toThrow(
			"callback failure",
		);
		expect(state.rollbacks).toBe(1);
		expectSafeReuse();
	}, 500);
	it("never returns uncertain lock ownership to the pool", async () => {
		state.failEndAt = 1;
		await expect(runGovernanceSchedulesSyncJob()).rejects.toThrow(
			"session end failure",
		);
		expectSafeReuse();
		expect(state.endedSessions).toBe(1);
		state.failEndAt = 0;
		await runGovernanceSchedulesSyncJob();
		expectSafeReuse();
	}, 500);
	it("commits rows before revalidating and triggering under a fresh guard", async () => {
		state.newLedger = true;
		await runGovernanceSchedulesSyncJob();
		expect(state.events).toEqual([
			"lock:1",
			"commit:1",
			"lock:2",
			"revalidate",
			"trigger",
			"commit:2",
		]);
		expect(state.triggers).toBe(1);
		expectSafeReuse();
	});
	it("skips eager dispatch after an intervening pause or replacement", async () => {
		state.newLedger = true;
		state.invalidLedgerRow = true;
		await runGovernanceSchedulesSyncJob();
		expect(state.triggers).toBe(0);
		expect(state.events).toContain("revalidate");
		expectSafeReuse();
	});
	it("skips optional eager dispatch when its nonblocking guard is refused", async () => {
		state.newLedger = true;
		state.refuseEager = true;
		await runGovernanceSchedulesSyncJob();
		expect(state.triggers).toBe(0);
		expect(state.events).not.toContain("revalidate");
		expectSafeReuse();
	});
	it("does not replay a trigger with a lost acknowledgement", async () => {
		state.newLedger = true;
		state.triggerFails = true;
		await runGovernanceSchedulesSyncJob();
		expect(state.triggers).toBe(1);
		expect(state.commits).toBe(2);
		expectSafeReuse();
	});
	it("propagates native eager-guard acquisition failure", async () => {
		state.newLedger = true;
		state.acquireFailsAt = 2;
		await expect(runGovernanceSchedulesSyncJob()).rejects.toThrow(
			"acquire failure",
		);
		expect(state.triggers).toBe(0);
		expectSafeReuse();
	});
	it("propagates uncertain guard completion after a successful trigger", async () => {
		state.newLedger = true;
		state.failEndAt = 2;
		await expect(runGovernanceSchedulesSyncJob()).rejects.toThrow(
			"session end failure",
		);
		expect(state.triggers).toBe(1);
		expect(state.endedSessions).toBe(1);
		expectSafeReuse();
	});
});

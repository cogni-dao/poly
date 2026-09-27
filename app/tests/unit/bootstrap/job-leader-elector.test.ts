// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/job-leader-elector`
 * Purpose: Prove the task.5016 leader-election state machine with a faked
 *          lock session and fake timers: acquire → start jobs, standby →
 *          retry on cadence, session death → stop jobs + re-elect, stop()
 *          → clean teardown. No DB, no HTTP.
 * Scope: `startJobLeaderElector` only. The real Postgres session adapter +
 *        two-instance promotion is covered by
 *        tests/component/jobs/job-leader-election.int.test.ts.
 * Invariants:
 *   - EDGE_TRIGGERED: startJobs fires exactly once per standby→leader edge;
 *     stopJobs exactly once per leader→standby edge (heartbeats don't
 *     re-start).
 *   - STANDBY_RETRIES: a non-leader retries acquisition every
 *     retryIntervalMs and promotes when the lock frees up.
 *   - LOSS_STOPS_JOBS: a heartbeat error (or false — lock held elsewhere)
 *     stops jobs, disposes the session, and re-enters standby with a fresh
 *     session.
 *   - CONNECT_FAILURE_IS_RETRIED: createSession rejection never throws out
 *     of the timer loop; the elector keeps retrying.
 *   - STOP_IS_TERMINAL: stop() stops jobs (iff leader), disposes the
 *     session, and no further probes fire.
 * Side-effects: none (fake timers)
 * Links: work/items/task.5016, src/bootstrap/jobs/job-leader-elector.ts
 * @public
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ElectorLogger,
	type JobLeaderElectorHandle,
	type LeaderLockSession,
	startJobLeaderElector,
} from "@/bootstrap/jobs/job-leader-elector";

const RETRY_MS = 20_000;
const HEARTBEAT_MS = 10_000;

interface FakeSession extends LeaderLockSession {
	acquireResults: Array<boolean | Error>;
	acquireCalls: number;
	disposed: boolean;
}

/** Session whose tryAcquire() shifts scripted results (last one repeats). */
function makeSession(script: Array<boolean | Error>): FakeSession {
	const session: FakeSession = {
		acquireResults: [...script],
		acquireCalls: 0,
		disposed: false,
		tryAcquire: async () => {
			session.acquireCalls += 1;
			const next =
				session.acquireResults.length > 1
					? (session.acquireResults.shift() as boolean | Error)
					: session.acquireResults[0];
			if (next instanceof Error) throw next;
			return next === true;
		},
		dispose: async () => {
			session.disposed = true;
		},
	};
	return session;
}

function makeLogger(): ElectorLogger & {
	events: Array<{ level: string; event: unknown }>;
} {
	const events: Array<{ level: string; event: unknown }> = [];
	const push =
		(level: string) => (obj: Record<string, unknown>, _msg?: string) => {
			events.push({ level, event: obj.event });
		};
	return {
		events,
		info: push("info"),
		warn: push("warn"),
		error: push("error"),
	};
}

async function flushMicrotasks(): Promise<void> {
	// Drain the promise chain the timer tick kicked off (several awaits deep).
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await flushMicrotasks();
}

describe("job-leader-elector state machine", () => {
	let handle: JobLeaderElectorHandle | null = null;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		vi.useRealTimers();
		if (handle) {
			await handle.stop();
			handle = null;
		}
	});

	function start(opts: {
		sessions: FakeSession[];
		startJobs: () => void;
		stopJobs: () => void;
		logger?: ElectorLogger;
	}): { handle: JobLeaderElectorHandle; createCalls: () => number } {
		let createCalls = 0;
		handle = startJobLeaderElector({
			createSession: async () => {
				const s = opts.sessions[createCalls];
				createCalls += 1;
				if (!s) throw new Error("no more scripted sessions");
				return s;
			},
			startJobs: opts.startJobs,
			stopJobs: opts.stopJobs,
			logger: opts.logger ?? makeLogger(),
			instanceId: "test#1",
			retryIntervalMs: RETRY_MS,
			heartbeatIntervalMs: HEARTBEAT_MS,
		});
		return { handle, createCalls: () => createCalls };
	}

	it("acquires on first probe, starts jobs once, heartbeats without restarting", async () => {
		const startJobs = vi.fn();
		const stopJobs = vi.fn();
		const session = makeSession([true]);
		const logger = makeLogger();
		const { handle: h } = start({
			sessions: [session],
			startJobs,
			stopJobs,
			logger,
		});

		await flushMicrotasks();
		expect(h.isLeader()).toBe(true);
		expect(startJobs).toHaveBeenCalledTimes(1);
		expect(logger.events).toContainEqual({
			level: "info",
			event: "jobs.leader_acquired",
		});

		// Three heartbeats: still leader, no re-start, no stop.
		await advance(HEARTBEAT_MS * 3);
		expect(session.acquireCalls).toBe(4);
		expect(startJobs).toHaveBeenCalledTimes(1);
		expect(stopJobs).not.toHaveBeenCalled();
		expect(h.isLeader()).toBe(true);
	});

	it("stands by when the lock is held, retries on cadence, promotes when freed", async () => {
		const startJobs = vi.fn();
		const stopJobs = vi.fn();
		// Held elsewhere for two probes, then free.
		const session = makeSession([false, false, true]);
		const logger = makeLogger();
		const { handle: h } = start({
			sessions: [session],
			startJobs,
			stopJobs,
			logger,
		});

		await flushMicrotasks();
		expect(h.isLeader()).toBe(false);
		expect(startJobs).not.toHaveBeenCalled();
		expect(logger.events).toContainEqual({
			level: "info",
			event: "jobs.leader_standby",
		});

		await advance(RETRY_MS); // second probe: still false
		expect(h.isLeader()).toBe(false);

		await advance(RETRY_MS); // third probe: acquires
		expect(h.isLeader()).toBe(true);
		expect(startJobs).toHaveBeenCalledTimes(1);
		// standby log emitted once, not once per retry
		expect(
			logger.events.filter((e) => e.event === "jobs.leader_standby"),
		).toHaveLength(1);
	});

	it("stops jobs and re-elects on heartbeat session error (leader death path)", async () => {
		const startJobs = vi.fn();
		const stopJobs = vi.fn();
		const dyingSession = makeSession([
			true,
			new Error("57P01 terminating connection"),
		]);
		const freshSession = makeSession([true]);
		const logger = makeLogger();
		const { handle: h, createCalls } = start({
			sessions: [dyingSession, freshSession],
			startJobs,
			stopJobs,
			logger,
		});

		await flushMicrotasks();
		expect(h.isLeader()).toBe(true);

		// Heartbeat hits the dead connection → demote + dispose.
		await advance(HEARTBEAT_MS);
		expect(stopJobs).toHaveBeenCalledTimes(1);
		expect(dyingSession.disposed).toBe(true);
		expect(h.isLeader()).toBe(false);
		expect(logger.events).toContainEqual({
			level: "warn",
			event: "jobs.leader_lost",
		});

		// Next retry opens a fresh session and re-acquires → jobs restart.
		await advance(RETRY_MS);
		expect(createCalls()).toBe(2);
		expect(h.isLeader()).toBe(true);
		expect(startJobs).toHaveBeenCalledTimes(2);
	});

	it("treats heartbeat=false as leadership lost to another pod", async () => {
		const startJobs = vi.fn();
		const stopJobs = vi.fn();
		// Acquired, then the (silently swapped) session reports the lock is
		// held elsewhere.
		const session = makeSession([true, false]);
		const { handle: h } = start({
			sessions: [session, makeSession([false])],
			startJobs,
			stopJobs,
		});

		await flushMicrotasks();
		expect(h.isLeader()).toBe(true);

		await advance(HEARTBEAT_MS);
		expect(stopJobs).toHaveBeenCalledTimes(1);
		expect(h.isLeader()).toBe(false);
		expect(session.disposed).toBe(true);
	});

	it("retries when createSession rejects (DB down) without throwing", async () => {
		const startJobs = vi.fn();
		const stopJobs = vi.fn();
		let attempt = 0;
		const good = makeSession([true]);
		const logger = makeLogger();
		handle = startJobLeaderElector({
			createSession: async () => {
				attempt += 1;
				if (attempt < 3) throw new Error("ECONNREFUSED");
				return good;
			},
			startJobs,
			stopJobs,
			logger,
			instanceId: "test#1",
			retryIntervalMs: RETRY_MS,
			heartbeatIntervalMs: HEARTBEAT_MS,
		});

		await flushMicrotasks();
		expect(handle.isLeader()).toBe(false);
		await advance(RETRY_MS); // attempt 2 fails
		expect(handle.isLeader()).toBe(false);
		await advance(RETRY_MS); // attempt 3 connects + acquires
		expect(handle.isLeader()).toBe(true);
		expect(startJobs).toHaveBeenCalledTimes(1);
		expect(
			logger.events.filter(
				(e) => e.event === "jobs.leader_lock_connect_failed",
			),
		).toHaveLength(2);
	});

	it("stop() while leader stops jobs, disposes the session, and halts probing", async () => {
		const startJobs = vi.fn();
		const stopJobs = vi.fn();
		const session = makeSession([true]);
		const { handle: h } = start({ sessions: [session], startJobs, stopJobs });

		await flushMicrotasks();
		expect(h.isLeader()).toBe(true);

		await h.stop();
		expect(stopJobs).toHaveBeenCalledTimes(1);
		expect(session.disposed).toBe(true);
		expect(h.isLeader()).toBe(false);

		const probesAtStop = session.acquireCalls;
		await advance(HEARTBEAT_MS * 5);
		expect(session.acquireCalls).toBe(probesAtStop);
		// Idempotent double-stop.
		await h.stop();
		expect(stopJobs).toHaveBeenCalledTimes(1);
		handle = null;
	});

	it("stop() while standby never calls stopJobs", async () => {
		const startJobs = vi.fn();
		const stopJobs = vi.fn();
		const session = makeSession([false]);
		const { handle: h } = start({ sessions: [session], startJobs, stopJobs });

		await flushMicrotasks();
		expect(h.isLeader()).toBe(false);

		await h.stop();
		expect(stopJobs).not.toHaveBeenCalled();
		expect(startJobs).not.toHaveBeenCalled();
		expect(session.disposed).toBe(true);
		handle = null;
	});

	it("startJobs throwing does not forfeit leadership", async () => {
		const startJobs = vi.fn(() => {
			throw new Error("partial boot");
		});
		const stopJobs = vi.fn();
		const session = makeSession([true]);
		const logger = makeLogger();
		const { handle: h } = start({
			sessions: [session],
			startJobs,
			stopJobs,
			logger,
		});

		await flushMicrotasks();
		expect(h.isLeader()).toBe(true);
		expect(logger.events).toContainEqual({
			level: "error",
			event: "jobs.leader_start_jobs_failed",
		});
		// Heartbeat continues; no demotion.
		await advance(HEARTBEAT_MS);
		expect(h.isLeader()).toBe(true);
		expect(stopJobs).not.toHaveBeenCalled();
	});
});

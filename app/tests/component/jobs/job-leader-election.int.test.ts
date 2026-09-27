// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/jobs/job-leader-election.int.test`
 * Purpose: Prove task.5016 single-writer leader election against a REAL
 *          Postgres: two elector instances sharing one database elect
 *          exactly one leader; terminating the leader's backend session
 *          (pg_terminate_backend — the crashed-pod stand-in) stops its jobs
 *          and promotes the standby within the retry cadence.
 * Scope: `startJobLeaderElector` + the real `createJobLeaderLockSession`
 *        postgres-js adapter. Job start/stop are counters — container job
 *        wiring is out of scope (state machine edges are unit-tested).
 * Invariants:
 *   - EXACTLY_ONE_LEADER: with both electors live, one and only one holds
 *     `pg_try_advisory_lock(hashtext('poly:job-runner'))`.
 *   - DEATH_PROMOTES_STANDBY: killing the leader's backend releases the
 *     session lock server-side; the standby acquires it and starts jobs,
 *     while the deposed leader stops its jobs.
 *   - GRACEFUL_STOP_PROMOTES: elector.stop() releases the lock so the
 *     other instance promotes without waiting for a TCP timeout.
 *   - KEYSPACE_NO_COLLISION: hashtext('poly:job-runner') differs from
 *     hashtext('governance_sync') — the repo's other fixed session-lock
 *     key (see the ADVISORY_KEYSPACE note in order-ledger.ts).
 * Side-effects: IO (database connections, backend termination via
 *   testcontainers)
 * Links: work/items/task.5016, src/bootstrap/jobs/job-leader-elector.ts,
 *   src/adapters/server/db/job-leader-lock.client.ts
 * @public
 */

import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobLeaderLockSession } from "@/adapters/server/db/job-leader-lock.client";
import {
	type ElectorLogger,
	JOB_LEADER_LOCK_KEY_TEXT,
	type JobLeaderElectorHandle,
	startJobLeaderElector,
} from "@/bootstrap/jobs/job-leader-elector";

const RETRY_MS = 250;
const HEARTBEAT_MS = 150;
/** Generous CI budget for one promote cycle (connect + retry cadence). */
const SETTLE_TIMEOUT_MS = 15_000;

const silentLogger: ElectorLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

interface Instance {
	handle: JobLeaderElectorHandle;
	appName: string;
	starts: number;
	stops: number;
}

function connectionString(): string {
	const url = process.env.DATABASE_SERVICE_URL;
	if (!url) {
		throw new Error(
			"DATABASE_SERVICE_URL not set — run via pnpm test:component",
		);
	}
	return url;
}

function startInstance(name: string, retryMs: number = RETRY_MS): Instance {
	const appName = `job-leader-${name}-${process.pid}`;
	const instance: Partial<Instance> = { appName, starts: 0, stops: 0 };
	instance.handle = startJobLeaderElector({
		createSession: () =>
			createJobLeaderLockSession({
				connectionString: connectionString(),
				applicationName: appName,
			}),
		startJobs: () => {
			instance.starts = (instance.starts ?? 0) + 1;
		},
		stopJobs: () => {
			instance.stops = (instance.stops ?? 0) + 1;
		},
		logger: silentLogger,
		instanceId: appName,
		retryIntervalMs: retryMs,
		heartbeatIntervalMs: HEARTBEAT_MS,
	});
	return instance as Instance;
}

async function terminateBackend(appName: string): Promise<void> {
	await getSeedDb().execute(
		sql`SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE application_name = ${appName}`,
	);
}

describe("job leader election (two instances, one Postgres)", () => {
	const live: Instance[] = [];

	afterEach(async () => {
		// Tear down every elector so the advisory lock never leaks into the
		// next spec (component lane shares one DB epoch).
		await Promise.all(live.map((i) => i.handle.stop()));
		live.length = 0;
	});

	it("elects exactly one leader; backend death promotes the standby", async () => {
		// Deterministic seating: A first, then B once A leads. A's standby
		// retry is much slower than B's so post-crash promotion is
		// deterministic (in production both pods race — either winning is
		// fine; here we pin the outcome to assert the promotion path).
		const a = startInstance("a", 10_000);
		live.push(a);
		await vi.waitFor(() => expect(a.handle.isLeader()).toBe(true), {
			timeout: SETTLE_TIMEOUT_MS,
		});
		expect(a.starts).toBe(1);

		const b = startInstance("b");
		live.push(b);
		// Give B several retry cycles to (incorrectly) grab the lock.
		await new Promise((r) => setTimeout(r, RETRY_MS * 3));
		expect(a.handle.isLeader()).toBe(true);
		expect(b.handle.isLeader()).toBe(false);
		expect(b.starts).toBe(0);
		// EXACTLY_ONE_LEADER, asserted at the database: one session holds it.
		const holders = await getSeedDb().execute(
			sql`SELECT count(*)::int AS n
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND objid::bigint = (hashtext(${JOB_LEADER_LOCK_KEY_TEXT})::bigint & 4294967295)
            AND granted`,
		);
		expect((holders as unknown as Array<{ n: number }>)[0]?.n).toBe(1);

		// Crash the leader: terminate its pinned backend. The server releases
		// the session lock; A's next heartbeat errors → stops jobs; B promotes.
		await terminateBackend(a.appName);
		await vi.waitFor(
			() => {
				expect(b.handle.isLeader()).toBe(true);
				expect(a.stops).toBe(1);
			},
			{ timeout: SETTLE_TIMEOUT_MS },
		);
		expect(b.starts).toBe(1);
		// Never two leaders at once after promotion settles.
		expect(a.handle.isLeader()).toBe(false);
	});

	it("graceful stop() releases the lock and the other instance promotes", async () => {
		const a = startInstance("a2");
		live.push(a);
		await vi.waitFor(() => expect(a.handle.isLeader()).toBe(true), {
			timeout: SETTLE_TIMEOUT_MS,
		});

		const b = startInstance("b2");
		live.push(b);
		await new Promise((r) => setTimeout(r, RETRY_MS * 2));
		expect(b.handle.isLeader()).toBe(false);

		await a.handle.stop();
		expect(a.stops).toBe(1);
		await vi.waitFor(() => expect(b.handle.isLeader()).toBe(true), {
			timeout: SETTLE_TIMEOUT_MS,
		});
		expect(b.starts).toBe(1);
	});

	it("documented fixed advisory keys do not collide (keyspace note)", async () => {
		const rows = await getSeedDb().execute(
			sql`SELECT hashtext(${JOB_LEADER_LOCK_KEY_TEXT}) AS runner,
                 hashtext('governance_sync') AS governance`,
		);
		const row = (
			rows as unknown as Array<{ runner: number; governance: number }>
		)[0];
		expect(row).toBeDefined();
		expect(row?.runner).not.toBe(row?.governance);
	});
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/db/job-leader-lock.client`
 * Purpose: Postgres-backed `LeaderLockSession` for job-runner leader
 *   election (task.5016). Opens a DEDICATED `max: 1` postgres-js client —
 *   NOT the shared app/service/read pools — and pins its single connection
 *   with `reserve()` so the session-level advisory lock lives and dies with
 *   exactly one backend session.
 * Scope: Connection lifecycle + the two lock statements. No election logic
 *   (state machine lives in `@/bootstrap/jobs/job-leader-elector`).
 * Invariants:
 *   - DEDICATED_CONNECTION: never borrows from the shared pools — a busy
 *     pool must not delay (or time out) the leadership heartbeat, and pool
 *     connection-swapping must not strand the lock on an unprobed session.
 *     Backend math: this is the "+1 leader-election connection" line in
 *     packages/db-client/src/build-client.ts.
 *   - SESSION_PINNED: all lock statements run on the ONE reserved
 *     connection. `max_lifetime: null` — postgres-js's default random
 *     45–90 min lifetime would recycle the connection and drop the lock.
 *   - DISPOSE_NEVER_THROWS: teardown (unlock-all, release, end) swallows
 *     errors — a dead connection is the expected teardown path, and the
 *     server already released the lock when the session died.
 * Side-effects: IO (one database connection per created session)
 * Links: work/items/task.5016, src/bootstrap/jobs/job-leader-elector.ts,
 *   packages/db-client/src/build-client.ts (pool backend math)
 * @internal
 */

import postgres from "postgres";

import {
	JOB_LEADER_LOCK_KEY_TEXT,
	type LeaderLockSession,
} from "@/bootstrap/jobs/job-leader-elector";

export interface JobLeaderLockSessionOptions {
	/** Service-role DSN (DATABASE_SERVICE_URL). App-role would also work — the lock is roleless — but jobs are a service concern. */
	connectionString: string;
	/**
	 * `application_name` for pg_stat_activity. Default `cogni_job_leader`.
	 * Tests override per instance so they can terminate a specific backend.
	 */
	applicationName?: string;
}

/**
 * Open a fresh pinned session for the elector. Throws when the initial
 * connect fails (the elector logs + retries on its standby cadence).
 */
export async function createJobLeaderLockSession(
	options: JobLeaderLockSessionOptions,
): Promise<LeaderLockSession> {
	// DEAD_SESSION_IS_NEVER_QUERIED: once the pinned connection closes
	// (pg_terminate_backend, network cut, failover), Postgres has already
	// released the advisory lock server-side — and postgres-js will still
	// route new statements onto the dead reserved connection, where they
	// never settle AND its write scheduler throws an uncaught TypeError on
	// the nulled socket (postgres@3.4.9 src/connection.js nextWrite). The
	// client's `onclose` hook flips `broken`, after which tryAcquire()
	// throws synchronously (elector demotes + builds a fresh session) and
	// dispose() skips the unlock statement.
	let broken = false;

	const sql = postgres(options.connectionString, {
		max: 1,
		// Reserved connections are exempt from idle collection, but be explicit:
		// this connection is intentionally long-lived.
		idle_timeout: 0,
		// Default is a random 45–90 min recycle — fatal for a session lock.
		max_lifetime: null,
		connect_timeout: 10,
		onclose: () => {
			broken = true;
		},
		connection: {
			application_name: options.applicationName ?? "cogni_job_leader",
		},
	});

	let reserved: Awaited<ReturnType<typeof sql.reserve>>;
	try {
		reserved = await sql.reserve();
	} catch (err) {
		await sql.end({ timeout: 5 }).catch(() => {});
		throw err;
	}

	/** Bounded await — a half-dead connection must never hang teardown. */
	const withTimeout = async (p: Promise<unknown>, ms: number) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				p.catch(() => {}),
				new Promise((resolve) => {
					timer = setTimeout(resolve, ms);
					timer.unref?.();
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	};

	return {
		async tryAcquire(): Promise<boolean> {
			if (broken) {
				throw new Error(
					"leader-lock session closed — lock already released server-side",
				);
			}
			try {
				const rows =
					await reserved`SELECT pg_try_advisory_lock(hashtext(${JOB_LEADER_LOCK_KEY_TEXT})) AS acquired`;
				return rows[0]?.acquired === true;
			} catch (err) {
				broken = true;
				throw err;
			}
		},
		async dispose(): Promise<void> {
			if (!broken) {
				// Releases every hold-count of every advisory lock this session
				// took (HEARTBEAT_IS_REACQUIRE bumps the count each probe), so a
				// graceful stop() frees the lock for the standby immediately.
				await withTimeout(
					reserved`SELECT pg_advisory_unlock_all()` as unknown as Promise<unknown>,
					2_000,
				);
			}
			try {
				reserved.release();
			} catch {
				// Already released/destroyed.
			}
			// timeout is seconds: force-close sockets quickly on a dead session.
			await withTimeout(sql.end({ timeout: 1 }), 3_000);
		},
	};
}

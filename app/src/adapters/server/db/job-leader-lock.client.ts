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
 *   - NO_STRAY_BACKENDS (bug.5066): postgres-js 3.4.9 can silently reconnect a
 *     client AFTER `end()` — `reserve()` leaves its query in the pool queue, so
 *     when the first connect fails (e.g. 53300 `too many connections`) the
 *     closed connection's `onclose` re-dials with the stale query and the
 *     revived socket is owned by nobody (idle_timeout 0, max_lifetime null →
 *     lives until pod death). Every standby retry during a full role could
 *     mint one. Defence: (1) failed connect ends with `timeout: 0` so the pool
 *     queue is drained at once; (2) each session carries a per-process
 *     `application_name` and, once established, terminates every OTHER backend
 *     with that exact name (`pg_terminate_backend`, same role → allowed), so a
 *     stray left by an earlier attempt is reaped by the next one; (3) a
 *     module-level gauge (`getLeaderLockClientStats`) counts opened/closed
 *     clients and reaped strays and is logged by the elector.
 * Side-effects: IO (one database connection per created session)
 * Links: work/items/task.5016, src/bootstrap/jobs/job-leader-elector.ts,
 *   packages/db-client/src/build-client.ts (pool backend math)
 * @internal
 */

import { randomBytes } from "node:crypto";
import postgres from "postgres";

import {
	JOB_LEADER_LOCK_KEY_TEXT,
	type LeaderLockSession,
} from "@/bootstrap/jobs/job-leader-elector";

/**
 * Per-module-instance token: the default `application_name` is unique per
 * process (and per duplicated module graph), so the stray sweep can never
 * terminate another pod's legitimate leader connection.
 */
const PROCESS_TOKEN = randomBytes(4).toString("hex");
const DEFAULT_APPLICATION_NAME = `cogni_job_leader:${PROCESS_TOKEN}`;

/** Module-level gauge of leader-lock postgres-js clients (bug.5066). */
const gauge = { opened: 0, closed: 0, strays_reaped: 0 };

export interface LeaderLockClientStats {
	/** postgres-js clients created by this module instance. */
	opened: number;
	/** Clients whose `end()` settled. */
	closed: number;
	/** `opened - closed`: clients this process believes are alive (expected 0 or 1). */
	live: number;
	/** Backends terminated by the stray sweep — non-zero PROVES a stray leaked. */
	strays_reaped: number;
}

export function getLeaderLockClientStats(): LeaderLockClientStats {
	return { ...gauge, live: gauge.opened - gauge.closed };
}

export interface JobLeaderLockSessionOptions {
	/** Service-role DSN (DATABASE_SERVICE_URL). App-role would also work — the lock is roleless — but jobs are a service concern. */
	connectionString: string;
	/**
	 * `application_name` for pg_stat_activity. Default
	 * `cogni_job_leader:<per-process token>`. MUST be unique per elector — the
	 * stray sweep terminates every other backend carrying this exact name.
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

	const applicationName = options.applicationName ?? DEFAULT_APPLICATION_NAME;
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
			application_name: applicationName,
		},
	});
	gauge.opened += 1;
	/** Count a client closed exactly once, whichever teardown path ends it. */
	let counted = false;
	const endClient = async (timeoutSeconds: number): Promise<void> => {
		try {
			await sql.end({ timeout: timeoutSeconds });
		} finally {
			if (!counted) {
				counted = true;
				gauge.closed += 1;
			}
		}
	};

	let reserved: Awaited<ReturnType<typeof sql.reserve>>;
	try {
		reserved = await sql.reserve();
	} catch (err) {
		// timeout 0 → destroy() on the next tick, which drains the pool queue
		// (incl. reserve()'s stale entry) so postgres-js cannot re-dial.
		await endClient(0).catch(() => {});
		throw err;
	}

	// NO_STRAY_BACKENDS: reap any other backend left by this process's earlier
	// attempts. Best-effort + bounded — never fails or stalls session creation.
	try {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const rows = await Promise.race([
			reserved`SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))::int AS reaped
				FROM pg_stat_activity
				WHERE application_name = ${applicationName} AND pid <> pg_backend_pid()`,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), 3_000);
				timer.unref?.();
			}),
		]).finally(() => clearTimeout(timer));
		const reaped = Number(rows?.[0]?.reaped ?? 0);
		if (reaped > 0) gauge.strays_reaped += reaped;
	} catch {
		// Sweep is advisory; a failure here is the dead-session path tryAcquire handles.
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
			await withTimeout(endClient(1), 3_000);
		},
	};
}

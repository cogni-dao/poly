// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/db/job-leader-lock.client`
 * Purpose: Postgres-backed `LeaderLockSession` for job-runner leader
 *   election (task.5016). Opens a DEDICATED `max: 1` postgres-js client —
 *   NOT the shared app/service/read pools — whose single connection IS the
 *   session, so the session-level advisory lock lives and dies with exactly
 *   one backend session.
 * Scope: Connection lifecycle + the two lock statements. No election logic
 *   (state machine lives in `@/bootstrap/jobs/job-leader-elector`).
 * Invariants:
 *   - DEDICATED_CONNECTION: never borrows from the shared pools — a busy
 *     pool must not delay (or time out) the leadership heartbeat, and pool
 *     connection-swapping must not strand the lock on an unprobed session.
 *     Backend math: this is the "+1 leader-election connection" line in
 *     packages/db-client/src/build-client.ts.
 *   - SESSION_PINNED: all lock statements run on the client's ONE connection.
 *     `max_lifetime: null` — postgres-js's default random 45–90 min lifetime
 *     would recycle the connection and drop the lock.
 *   - DISPOSE_NEVER_THROWS: teardown (unlock-all, release, end) swallows
 *     errors — a dead connection is the expected teardown path, and the
 *     server already released the lock when the session died.
 *   - NO_RESERVE_NO_STRAY (bug.5066): the session is the client's ONE connection
 *     (`max: 1`, no idle/lifetime recycle) used directly — never `sql.reserve()`.
 *     postgres-js 3.4.9 `reserve()` pushes its query onto the pool queue AND hands
 *     it to the dialling connection; when the dial fails (ECONNRESET, 53300 `too
 *     many connections`) the promise rejects but the entry stays queued, and the
 *     closed connection's `onclose` re-dials with it AFTER `end()` — a backend
 *     nobody owns (idle_timeout 0, max_lifetime null: it lives until pod death and
 *     holds a role slot, so the next standby retry fails too). An ordinary query
 *     dials directly (`connect(closed.shift(), query)`) and never enters the queue,
 *     so a failed connect leaves nothing to re-dial. `sql.end({timeout:0})` does not
 *     help: `c.end()` wins the race and cancels postgres-js's destroy timer.
 *   - BACKENDS_ARE_COUNTED_AT_THE_SERVER: `backendStats()` reads pg_stat_activity on
 *     this session's own connection (no extra slot), so the gauge cannot disagree
 *     with the role's real backend count the way a client-side opened/closed
 *     counter does.
 *   - LOCK_NEVER_OUTLIVES_ITS_HOLDER (bug.5066): the session asks the server to end
 *     it after `idle_session_timeout` of silence. A holder whose TCP session dies
 *     without a FIN/RST (Akash closes the lease, the pod vanishes behind NAT) leaves
 *     a half-open backend that still holds the advisory lock; the server only reaps
 *     it via keepalive after ~2h11m (tcp_keepalives_idle 7200 + 9 x 75). Live
 *     candidate-a: pids 716323/716335 held `poly:job-runner` for hours after their
 *     lease closed, and the new pod sat in standby. Idle timeout is the principled
 *     bound because the lock IS a lease: its holder proves liveness by talking
 *     (heartbeat 10s / retry 20s), so silence for 3 intervals ends it. It is a
 *     USERSET per-session value (no role/server change; database-expert axiom 3),
 *     independent of NAT/kernel keepalive behaviour, and also catches a holder that
 *     is alive at TCP level but frozen. A server without the setting (PG < 14)
 *     refuses the connection loudly at connect (SQLSTATE 42704, logged at error
 *     level by the elector), so election never runs unbounded.
 *     The other half is the elector's: a holder CUT OFF from the database (a
 *     partition, not a crash) never hears that the server freed its lock, so the
 *     elector bounds every probe (FENCE_BEFORE_TAKEOVER) and demotes before the idle
 *     timeout lets a standby acquire. idle timeout alone would give two leaders.
 * Side-effects: IO (one database connection per created session)
 * Links: work/items/task.5016, src/bootstrap/jobs/job-leader-elector.ts,
 *   packages/db-client/src/build-client.ts (pool backend math)
 * @internal
 */

import postgres from "postgres";

import {
	JOB_LEADER_LOCK_KEY_TEXT,
	LEADER_SESSION_IDLE_TIMEOUT_MS,
	type LeaderBackendStats,
	type LeaderLockSession,
} from "@/bootstrap/jobs/job-leader-elector";

/** `application_name` of the leader-lock backend in pg_stat_activity. */
export const DEFAULT_APPLICATION_NAME = "cogni_job_leader";

export interface JobLeaderLockSessionOptions {
	/** Service-role DSN (DATABASE_SERVICE_URL). App-role would also work — the lock is roleless — but jobs are a service concern. */
	connectionString: string;
	/**
	 * `application_name` for pg_stat_activity. Default `cogni_job_leader`.
	 * Tests override per instance so they can terminate a specific backend.
	 */
	applicationName?: string;
	/**
	 * Server-side `idle_session_timeout` for this session, ms (default
	 * `LEADER_SESSION_IDLE_TIMEOUT_MS`). MUST exceed the elector's retry and
	 * heartbeat intervals, or a healthy session is ended between probes.
	 */
	idleSessionTimeoutMs?: number;
	/**
	 * Advisory-lock key text (`hashtext(...)`). Default `JOB_LEADER_LOCK_KEY_TEXT`.
	 * Tests pass a private key so component files running in parallel workers do
	 * not contend for the one production lock.
	 */
	lockKeyText?: string;
}

/**
 * Open a fresh pinned session for the elector. Throws when the initial
 * connect fails (the elector logs + retries on its standby cadence).
 */
export async function createJobLeaderLockSession(
	options: JobLeaderLockSessionOptions,
): Promise<LeaderLockSession> {
	// DEAD_SESSION_IS_NEVER_QUERIED: once the connection closes
	// (pg_terminate_backend, network cut, failover), Postgres has already
	// released the advisory lock server-side — and postgres-js would happily
	// re-dial for the next statement, silently taking the lock on a NEW backend
	// nobody is tracking. The client's `onclose` hook flips `broken`, after which
	// tryAcquire() throws synchronously (elector demotes + builds a fresh
	// session) and dispose() skips the unlock statement.
	let broken = false;

	const applicationName = options.applicationName ?? DEFAULT_APPLICATION_NAME;
	const lockKeyText = options.lockKeyText ?? JOB_LEADER_LOCK_KEY_TEXT;
	const sql = postgres(options.connectionString, {
		max: 1,
		// This connection is intentionally long-lived.
		idle_timeout: 0,
		// Default is a random 45–90 min recycle — fatal for a session lock.
		max_lifetime: null,
		connect_timeout: 10,
		onclose: () => {
			broken = true;
		},
		connection: {
			application_name: applicationName,
			// LOCK_NEVER_OUTLIVES_ITS_HOLDER: unitless value = milliseconds.
			idle_session_timeout:
				options.idleSessionTimeoutMs ?? LEADER_SESSION_IDLE_TIMEOUT_MS,
		},
	});

	// Dial with an ordinary query — NOT `sql.reserve()` (NO_RESERVE_NO_STRAY).
	try {
		await sql`select 1`;
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
					await sql`SELECT pg_try_advisory_lock(hashtext(${lockKeyText})) AS acquired`;
				return rows[0]?.acquired === true;
			} catch (err) {
				broken = true;
				throw err;
			}
		},
		async backendStats(): Promise<LeaderBackendStats | undefined> {
			if (broken) return undefined;
			try {
				// Own connection → needs no extra role slot, so it still answers when
				// the role is nearly full. `client_addr` identifies this pod (or the
				// NAT address it shares); NULL on unix sockets matches via IS NOT
				// DISTINCT FROM. Bounded: a stuck probe never delays an elector log.
				let timer: ReturnType<typeof setTimeout> | undefined;
				const rows = await Promise.race([
					sql`SELECT
							count(*) FILTER (WHERE usename = current_user)::int AS role,
							count(*) FILTER (WHERE usename = current_user
								AND client_addr IS NOT DISTINCT FROM inet_client_addr())::int AS pod,
							count(*) FILTER (WHERE usename = current_user
								AND client_addr IS NOT DISTINCT FROM inet_client_addr()
								AND application_name = current_setting('application_name'))::int AS leader
						FROM pg_stat_activity
						WHERE backend_type = 'client backend'`,
					new Promise<undefined>((resolve) => {
						timer = setTimeout(() => resolve(undefined), 2_000);
						timer.unref?.();
					}),
				]).finally(() => clearTimeout(timer));
				const row = rows?.[0];
				return row
					? {
							role: Number(row.role),
							pod: Number(row.pod),
							leader: Number(row.leader),
						}
					: undefined;
			} catch {
				return undefined;
			}
		},
		async dispose(): Promise<void> {
			if (!broken) {
				// Releases every hold-count of every advisory lock this session
				// took (HEARTBEAT_IS_REACQUIRE bumps the count each probe), so a
				// graceful stop() frees the lock for the standby immediately.
				await withTimeout(
					sql`SELECT pg_advisory_unlock_all()` as unknown as Promise<unknown>,
					2_000,
				);
			}
			// timeout is seconds: force-close sockets quickly on a dead session.
			await withTimeout(sql.end({ timeout: 1 }), 3_000);
		},
	};
}

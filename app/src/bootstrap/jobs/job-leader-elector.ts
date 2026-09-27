// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/job-leader-elector`
 * Purpose: Single-writer leader election for ALL in-process background jobs
 *   (task.5016). One session-level Postgres advisory lock —
 *   `pg_try_advisory_lock(hashtext('poly:job-runner'))` — is the whole
 *   leadership domain: the pod holding it runs every job container.ts
 *   starts (mirror polls, order/targets reconcilers, resting sweep,
 *   auto-wrap, trader-observation, market-outcome, price-history,
 *   top-wallet-stats, redeem pipelines); every other pod stands by.
 * Scope: Pure state machine over an injected `LeaderLockSession` port.
 *   Owns cadence (standby retry + leader heartbeat on one timer), state
 *   transitions, and leader logs. Does NOT open connections (the
 *   `@/adapters/server/db/job-leader-lock.client` adapter does), does NOT
 *   know which jobs exist (container.ts injects start/stop closures).
 * Invariants:
 *   - ONE_LEADERSHIP_DOMAIN: a single lock key gates ALL jobs. No per-job
 *     locks — partial leadership (pod A runs the mirror, pod B runs the
 *     sweep) is a strictly harder failure surface than one writer pod.
 *   - HEARTBEAT_IS_REACQUIRE: the leader's liveness probe re-runs
 *     `tryAcquire()` on the SAME session. Session-level advisory locks are
 *     re-entrant, so the holder gets `true` (hold-count bump — released
 *     wholesale by session end, never one-by-one); a session that silently
 *     died/reconnected either reacquires the free lock (still sole leader,
 *     keep going) or sees `false`/an error (another pod won → demote). This
 *     makes the probe a lock ASSERTION, not just a `SELECT 1`.
 *   - LOSS_STOPS_JOBS: any heartbeat failure → `stopJobs()` BEFORE the
 *     session is disposed, then standby. Split-brain exposure is bounded by
 *     one heartbeat interval (default 10s) — same class of window as k8s
 *     lease-based election; double-placement is additionally backstopped by
 *     the `one_open_per_market` partial unique index.
 *   - IDEMPOTENT_TRANSITIONS: `startJobs` fires only on a standby→leader
 *     edge, `stopJobs` only on a leader→standby edge; container.ts job
 *     starts/stops are epoch-guarded so a stop that races a mid-boot start
 *     wins (see `_jobsEpoch` in container.ts).
 *   - TIMERS_UNREF: the retry/heartbeat timer never holds the process open
 *     (tests, `next build` workers).
 *   - CACHES_STAY_PER_REPLICA: this elects WRITERS only. The in-process
 *     coalesce/TTL read caches (`@features/wallet-analysis/server/coalesce`,
 *     `dashboard-route-cache.ts`) remain per-replica by design — a second
 *     replica only degrades cache hit rate, never correctness.
 * Side-effects: timers, logs; IO only through the injected session port.
 * Links: work/items/task.5016,
 *   src/adapters/server/db/job-leader-lock.client.ts (session adapter),
 *   src/features/trading/order-ledger.ts (advisory keyspace note),
 *   src/bootstrap/jobs/syncGovernanceSchedules.job.ts (sibling
 *   `hashtext('governance_sync')` session lock)
 * @public
 */

/**
 * The documented advisory-lock key string. `hashtext(...)` of this literal is
 * the int4 lock id. Shared keyspace with the repo's other advisory locks
 * (`governance_sync`, order-ledger / wallet-provision xact locks) — collision
 * analysis lives next to the xact-lock usage in order-ledger.ts and is
 * asserted (vs `governance_sync`) in the component test.
 */
export const JOB_LEADER_LOCK_KEY_TEXT = "poly:job-runner";

/** Standby cadence — how often a non-leader retries acquisition. */
export const DEFAULT_LEADER_RETRY_INTERVAL_MS = 20_000;
/** Leader cadence — how often the holder re-asserts the lock (loss bound). */
export const DEFAULT_LEADER_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * One pinned Postgres session holding (or trying for) the advisory lock.
 * Implementations MUST pin a single backend session — the lock is
 * session-scoped, so a pooled client that transparently swaps connections
 * would hold the lock on a session nobody probes.
 */
export interface LeaderLockSession {
	/**
	 * `SELECT pg_try_advisory_lock(hashtext(<key>))` on the pinned session.
	 * Non-blocking. Throws when the session/connection is unusable.
	 */
	tryAcquire(): Promise<boolean>;
	/**
	 * Best-effort teardown: advisory-unlock-all + close the connection.
	 * MUST swallow its own errors (a dead connection is the common case).
	 */
	dispose(): Promise<void>;
}

/** Minimal structural logger (pino-compatible) so unit tests fake it flat. */
export interface ElectorLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
}

export interface JobLeaderElectorDeps {
	/** Opens a fresh pinned session. Called lazily + after every session loss. */
	createSession: () => Promise<LeaderLockSession>;
	/** Start ALL background jobs (the existing container.ts start paths). */
	startJobs: () => void;
	/** Stop ALL background jobs. Must be safe to call when none are running. */
	stopJobs: () => void;
	logger: ElectorLogger;
	/** Pod-identifying string for the leader logs (hostname#pid, pod name…). */
	instanceId: string;
	retryIntervalMs?: number;
	heartbeatIntervalMs?: number;
}

export interface JobLeaderElectorHandle {
	/** True while this instance holds the lock and its jobs are started. */
	isLeader(): boolean;
	/** Stop electing: stop jobs if leader, release the lock, clear timers. */
	stop(): Promise<void>;
}

/**
 * Start the elector. Fires an immediate first acquisition attempt, then
 * self-schedules: `retryIntervalMs` while standby, `heartbeatIntervalMs`
 * while leader. Never throws out of its timer loop.
 */
export function startJobLeaderElector(
	deps: JobLeaderElectorDeps,
): JobLeaderElectorHandle {
	const retryMs = deps.retryIntervalMs ?? DEFAULT_LEADER_RETRY_INTERVAL_MS;
	const heartbeatMs =
		deps.heartbeatIntervalMs ?? DEFAULT_LEADER_HEARTBEAT_INTERVAL_MS;
	const baseLog = {
		lock_key: JOB_LEADER_LOCK_KEY_TEXT,
		instance_id: deps.instanceId,
	};

	let stopped = false;
	let leader = false;
	let session: LeaderLockSession | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let ticking = false;
	let standbyLogged = false;

	function schedule(ms: number): void {
		if (stopped) return;
		timer = setTimeout(() => {
			void tick();
		}, ms);
		// Never hold the process open for election (vitest, build workers).
		timer.unref?.();
	}

	async function disposeSession(): Promise<void> {
		const s = session;
		session = null;
		if (s) {
			try {
				await s.dispose();
			} catch {
				// dispose() is contractually best-effort; belt and braces.
			}
		}
	}

	/** leader → standby edge: stop jobs FIRST, then log. */
	function demote(reason: string, err?: unknown): void {
		leader = false;
		standbyLogged = false;
		deps.logger.warn(
			{
				event: "jobs.leader_lost",
				...baseLog,
				reason,
				err: err instanceof Error ? err.message : err ? String(err) : undefined,
			},
			"job-runner leadership lost — stopping all background jobs",
		);
		try {
			deps.stopJobs();
		} catch (stopErr) {
			deps.logger.error(
				{
					event: "jobs.leader_stop_jobs_failed",
					...baseLog,
					err: stopErr instanceof Error ? stopErr.message : String(stopErr),
				},
				"stopJobs threw during demotion — continuing to standby",
			);
		}
	}

	async function tick(): Promise<void> {
		if (stopped || ticking) return;
		ticking = true;
		try {
			if (!session) {
				try {
					session = await deps.createSession();
				} catch (err) {
					deps.logger.warn(
						{
							event: "jobs.leader_lock_connect_failed",
							...baseLog,
							err: err instanceof Error ? err.message : String(err),
						},
						"leader-lock connection failed — retrying",
					);
					schedule(retryMs);
					return;
				}
				if (stopped) {
					await disposeSession();
					return;
				}
			}

			let acquired: boolean;
			try {
				acquired = await session.tryAcquire();
			} catch (err) {
				// Connection died. If leader: the lock auto-released server-side the
				// moment our session ended — stop jobs and race to reacquire.
				if (leader) demote("session_error", err);
				else
					deps.logger.warn(
						{
							event: "jobs.leader_lock_probe_failed",
							...baseLog,
							err: err instanceof Error ? err.message : String(err),
						},
						"standby lock probe failed — recreating session",
					);
				await disposeSession();
				schedule(retryMs);
				return;
			}

			if (stopped) {
				// stop() raced our probe; stop() handles job/session teardown.
				return;
			}

			if (acquired) {
				if (!leader) {
					leader = true;
					standbyLogged = false;
					deps.logger.info(
						{ event: "jobs.leader_acquired", ...baseLog },
						"job-runner leadership acquired — starting all background jobs",
					);
					try {
						deps.startJobs();
					} catch (err) {
						deps.logger.error(
							{
								event: "jobs.leader_start_jobs_failed",
								...baseLog,
								err: err instanceof Error ? err.message : String(err),
							},
							"startJobs threw — still leader; jobs may be partially started",
						);
					}
				}
				schedule(heartbeatMs);
			} else {
				if (leader) {
					// Re-entrant acquire on our own session can only return false if
					// the session was swapped under us AND another pod won the race.
					demote("lock_held_elsewhere");
					await disposeSession();
				} else if (!standbyLogged) {
					standbyLogged = true;
					deps.logger.info(
						{
							event: "jobs.leader_standby",
							...baseLog,
							retry_interval_ms: retryMs,
						},
						"another pod holds the job-runner lock — standing by",
					);
				}
				schedule(retryMs);
			}
		} finally {
			ticking = false;
		}
	}

	// First attempt on the microtask queue — callers get the handle back
	// synchronously; jobs start as soon as the lock answers.
	void tick();

	return {
		isLeader: () => leader,
		stop: async () => {
			if (stopped) return;
			stopped = true;
			if (timer) clearTimeout(timer);
			if (leader) {
				leader = false;
				deps.logger.info(
					{ event: "jobs.leader_released", ...baseLog },
					"elector stopped — stopping background jobs and releasing lock",
				);
				try {
					deps.stopJobs();
				} catch {
					// Best-effort on shutdown.
				}
			}
			await disposeSession();
		},
	};
}

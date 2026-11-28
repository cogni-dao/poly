// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/jobs/job-leader-dead-holder.int.test`
 * Purpose: Prove bug.5066's second finding against a REAL Postgres: a leader
 *          lock must not outlive its holder, and a holder must not outlive its
 *          lock. When the holder's TCP session dies SILENTLY (no FIN, no RST in
 *          either direction — an Akash lease closed, a partition behind NAT),
 *          the standby takes over within a bounded time AND the cut-off holder
 *          has already demoted (stopped its jobs) by then: never two leaders.
 * Scope: Two `startJobLeaderElector` instances on the real
 *        `createJobLeaderLockSession`; the leader's connection runs through a
 *        TCP proxy that can start dropping every byte without closing a socket.
 *        Live evidence: candidate-a pids 716323/716335 kept `poly:job-runner`
 *        for hours after their lease closed, because Postgres reaps a
 *        half-open peer only via kernel keepalive (7200s + 9 x 75s).
 * Invariants:
 *   - LOCK_NEVER_OUTLIVES_ITS_HOLDER: after the holder goes silent, the server
 *     ends its session after `idle_session_timeout` and the standby acquires
 *     within idle timeout + one standby retry (+ CI slack). On the pre-fix
 *     adapter nothing ends the session, so the standby never acquires inside
 *     the bound.
 *   - FENCE_BEFORE_TAKEOVER: the holder is still ALIVE (a partition, not a
 *     crash). Its heartbeat is never ACKed and the proxy delivers neither the
 *     server's FIN nor anything else, so only the elector's probe timeout can
 *     tell it: it demotes (stopJobs) strictly before the standby's startJobs.
 *   - SERVER_SIDE_PROOF: the dead holder's backend is gone from
 *     pg_stat_activity and exactly one session holds the advisory lock.
 * Side-effects: IO (database connections, a loopback TCP proxy)
 * Links: work/items/bug.5066, src/adapters/server/db/job-leader-lock.client.ts,
 *   src/bootstrap/jobs/job-leader-elector.ts (LEADER_SESSION_IDLE_TIMEOUT_MS)
 * @public
 */

import net from "node:net";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobLeaderLockSession } from "@/adapters/server/db/job-leader-lock.client";
import {
	type ElectorLogger,
	type JobLeaderElectorHandle,
	startJobLeaderElector,
} from "@/bootstrap/jobs/job-leader-elector";

/** Private lock key: files run in parallel workers; never contend for the real one. */
const LOCK_KEY_TEXT = `poly:job-runner:test-dead-holder-${process.pid}`;
const IDLE_TIMEOUT_MS = 1_500;
const RETRY_MS = 250;
const HEARTBEAT_MS = 150;
/** Elector fence: a probe unanswered this long demotes the holder. */
const PROBE_TIMEOUT_MS = 500;
/** Takeover bound: server idle timeout + one standby retry + CI slack. */
const TAKEOVER_BOUND_MS = IDLE_TIMEOUT_MS + RETRY_MS + 3_000;

const silentLogger: ElectorLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

/** Loopback proxy that can go silent: bytes dropped, sockets left open. */
async function startBlackholeProxy(target: { host: string; port: number }) {
	let silent = false;
	const open = new Set<net.Socket>();
	const server = net.createServer((client) => {
		const upstream = net.connect(target.port, target.host);
		open.add(client);
		open.add(upstream);
		const drop = () => {
			// Silent = a NAT/partition: neither the server's FIN nor a client close
			// crosses the proxy. Sockets stay in `open`, destroyed only by close().
			if (silent) return;
			open.delete(client);
			open.delete(upstream);
			client.destroy();
			upstream.destroy();
		};
		client.on("close", drop);
		upstream.on("close", drop);
		client.on("error", () => {});
		upstream.on("error", () => {});
		client.on("data", (d) => {
			if (!silent) upstream.write(d);
		});
		upstream.on("data", (d) => {
			if (!silent) client.write(d);
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	return {
		port: (server.address() as net.AddressInfo).port,
		goSilent: () => {
			silent = true;
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const s of open) s.destroy();
				server.close(() => resolve());
			}),
	};
}

async function advisoryHolders(): Promise<number> {
	const rows = (await getSeedDb().execute(
		sql`SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory'
          AND objid::bigint = (hashtext(${LOCK_KEY_TEXT})::bigint & 4294967295)
          AND granted`,
	)) as unknown as Array<{ n: number }>;
	return rows[0]?.n ?? -1;
}

async function backendsNamed(applicationName: string): Promise<number> {
	const rows = (await getSeedDb().execute(
		sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name = ${applicationName}`,
	)) as unknown as Array<{ n: number }>;
	return rows[0]?.n ?? -1;
}

describe("job leader lock never outlives its holder (bug.5066)", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((fn) => fn()));
	});

	it("holder TCP goes silent: the server ends its session and the standby takes over within the bound", async () => {
		const direct = process.env.DATABASE_SERVICE_URL ?? "";
		const url = new URL(direct);
		const proxy = await startBlackholeProxy({
			host: url.hostname,
			port: Number(url.port),
		});
		url.hostname = "127.0.0.1";
		url.port = String(proxy.port);
		const viaProxy = url.toString();

		const appA = `job-leader-dead-a-${process.pid}`;
		const appB = `job-leader-dead-b-${process.pid}`;
		const start = (
			connectionString: string,
			applicationName: string,
		): {
			handle: JobLeaderElectorHandle;
			starts: () => number;
			stoppedAt: () => number | null;
			startedAt: () => number | null;
		} => {
			let starts = 0;
			let startedAt: number | null = null;
			let stoppedAt: number | null = null;
			const handle = startJobLeaderElector({
				createSession: () =>
					createJobLeaderLockSession({
						connectionString,
						applicationName,
						idleSessionTimeoutMs: IDLE_TIMEOUT_MS,
						lockKeyText: LOCK_KEY_TEXT,
					}),
				startJobs: () => {
					starts += 1;
					startedAt = Date.now();
				},
				stopJobs: () => {
					stoppedAt ??= Date.now();
				},
				logger: silentLogger,
				instanceId: applicationName,
				retryIntervalMs: RETRY_MS,
				heartbeatIntervalMs: HEARTBEAT_MS,
				probeTimeoutMs: PROBE_TIMEOUT_MS,
			});
			return {
				handle,
				starts: () => starts,
				startedAt: () => startedAt,
				stoppedAt: () => stoppedAt,
			};
		};

		// Holder A (through the proxy) leads; standby B (direct) waits.
		const a = start(viaProxy, appA);
		cleanups.push(proxy.close, () => a.handle.stop());
		await vi.waitFor(() => expect(a.handle.isLeader()).toBe(true), {
			timeout: 15_000,
		});
		const b = start(direct, appB);
		cleanups.push(() => b.handle.stop());
		await new Promise((r) => setTimeout(r, RETRY_MS * 4));
		expect(b.handle.isLeader()).toBe(false);
		expect(await advisoryHolders()).toBe(1);

		// A is cut off silently: nothing reaches Postgres, no socket is closed in
		// either direction, and A's process keeps running.
		expect(PROBE_TIMEOUT_MS + HEARTBEAT_MS).toBeLessThan(IDLE_TIMEOUT_MS);
		const silentAt = Date.now();
		proxy.goSilent();

		await vi.waitFor(() => expect(b.handle.isLeader()).toBe(true), {
			timeout: TAKEOVER_BOUND_MS,
			interval: 25,
		});
		const takeoverMs = (b.startedAt() ?? Date.now()) - silentAt;
		expect(takeoverMs).toBeLessThan(TAKEOVER_BOUND_MS);
		expect(b.starts()).toBe(1);

		// FENCE_BEFORE_TAKEOVER: the cut-off holder stopped its jobs BEFORE the
		// standby started its own — and is no longer leader. (Without the probe
		// timeout A's heartbeat hangs for ~15 min and both run jobs.)
		const demoteMs = (a.stoppedAt() ?? Number.POSITIVE_INFINITY) - silentAt;
		expect(a.stoppedAt()).not.toBeNull();
		expect(a.handle.isLeader()).toBe(false);
		expect(a.stoppedAt() as number).toBeLessThan(b.startedAt() as number);
		expect(demoteMs).toBeLessThanOrEqual(HEARTBEAT_MS + PROBE_TIMEOUT_MS + 750);
		console.info(
			JSON.stringify({ event: "test.dead_holder_timing", demoteMs, takeoverMs }),
		);

		// Server truth: the dead holder's backend is gone; one session holds the lock.
		expect(await backendsNamed(appA)).toBe(0);
		expect(await advisoryHolders()).toBe(1);
	}, 30_000);
});

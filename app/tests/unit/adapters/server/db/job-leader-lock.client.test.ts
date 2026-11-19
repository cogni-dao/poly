// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/db/job-leader-lock.client`
 * Purpose: Prove the bug.5066 invariants of the leader-lock adapter with a
 *          mocked postgres-js: elector retry cycles never hold more than ONE
 *          live client, failed connects end with `timeout: 0` (drains the
 *          reserve() queue entry that lets postgres-js re-dial after end()),
 *          and an established session sweeps stray backends by name.
 * Scope: `createJobLeaderLockSession` + `startJobLeaderElector`. No DB.
 * Invariants:
 *   - AT_MOST_ONE_LIVE_CLIENT: across N probe-failure retry cycles the number
 *     of un-ended clients never exceeds 1 (the current session).
 *   - FAILED_CONNECT_IS_DRAINED: reserve() rejection → end({timeout: 0}).
 *   - STRAYS_ARE_REAPED: session start runs the name-scoped terminate sweep
 *     and the gauge reports what it killed.
 * Side-effects: none (fake timers, mocked postgres)
 * Links: work/items/bug.5066, src/adapters/server/db/job-leader-lock.client.ts
 * @public
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeClient {
	opts: { connection?: { application_name?: string }; onclose?: () => void };
	ended: boolean;
	endTimeouts: number[];
	queries: string[];
	released: boolean;
}

const h = vi.hoisted(() => ({
	clients: [] as FakeClient[],
	live: 0,
	maxLive: 0,
	failReserve: false,
	failAcquire: false,
	reaped: 0,
}));

vi.mock("postgres", () => ({
	default: (_url: string, opts: FakeClient["opts"]) => {
		const client: FakeClient = {
			opts,
			ended: false,
			endTimeouts: [],
			queries: [],
			released: false,
		};
		h.clients.push(client);
		h.live += 1;
		h.maxLive = Math.max(h.maxLive, h.live);
		const reserved = Object.assign(
			(strings: TemplateStringsArray) => {
				const text = strings.join("?");
				client.queries.push(text);
				if (text.includes("pg_try_advisory_lock")) {
					if (h.failAcquire) {
						opts.onclose?.();
						return Promise.reject(new Error("connection closed"));
					}
					return Promise.resolve([{ acquired: false }]);
				}
				if (text.includes("pg_terminate_backend"))
					return Promise.resolve([{ reaped: h.reaped }]);
				return Promise.resolve([]);
			},
			{
				release: () => {
					client.released = true;
				},
			},
		);
		return {
			reserve: async () => {
				if (h.failReserve) throw new Error("too many connections for role");
				return reserved;
			},
			end: async ({ timeout }: { timeout: number }) => {
				if (!client.ended) h.live -= 1;
				client.ended = true;
				client.endTimeouts.push(timeout);
			},
		};
	},
}));

import {
	createJobLeaderLockSession,
	getLeaderLockClientStats,
} from "@/adapters/server/db/job-leader-lock.client";
import { startJobLeaderElector } from "@/bootstrap/jobs/job-leader-elector";

const silent = { info() {}, warn() {}, error() {} };

describe("job-leader-lock adapter — bug.5066 connection hygiene", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		h.clients.length = 0;
		h.live = 0;
		h.maxLive = 0;
		h.failReserve = false;
		h.failAcquire = false;
		h.reaped = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("N probe-failure retry cycles hold at most one live client", async () => {
		h.failAcquire = true;
		const before = getLeaderLockClientStats();
		const handle = startJobLeaderElector({
			createSession: () =>
				createJobLeaderLockSession({ connectionString: "postgres://x" }),
			startJobs: () => {},
			stopJobs: () => {},
			logger: silent,
			instanceId: "t",
			retryIntervalMs: 20_000,
		});
		for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(20_000);

		expect(h.clients.length).toBeGreaterThanOrEqual(10);
		expect(h.maxLive).toBeLessThanOrEqual(1);

		await handle.stop();
		expect(h.live).toBe(0);
		expect(h.clients.every((c) => c.ended)).toBe(true);
		expect(getLeaderLockClientStats().live).toBe(before.live);
	});

	it("failed connect ends the client with timeout 0 (drains reserve queue)", async () => {
		h.failReserve = true;
		const before = getLeaderLockClientStats();
		for (let i = 0; i < 5; i++) {
			await expect(
				createJobLeaderLockSession({ connectionString: "postgres://x" }),
			).rejects.toThrow(/too many connections/);
		}
		expect(h.clients).toHaveLength(5);
		expect(h.clients.every((c) => c.ended)).toBe(true);
		expect(h.clients.every((c) => c.endTimeouts[0] === 0)).toBe(true);
		const after = getLeaderLockClientStats();
		expect(after.opened - before.opened).toBe(5);
		expect(after.live).toBe(before.live);
	});

	it("established session sweeps strays by its own application_name and counts them", async () => {
		h.reaped = 2;
		const before = getLeaderLockClientStats();
		const session = await createJobLeaderLockSession({
			connectionString: "postgres://x",
		});
		const client = h.clients[0] as FakeClient;
		const name = client.opts.connection?.application_name ?? "";
		expect(name).toMatch(/^cogni_job_leader:[0-9a-f]{8}$/);
		expect(client.queries.some((q) => q.includes("pg_terminate_backend"))).toBe(
			true,
		);
		expect(
			getLeaderLockClientStats().strays_reaped - before.strays_reaped,
		).toBe(2);
		await session.dispose();
		expect(client.ended).toBe(true);
		expect(client.released).toBe(true);
	});
});

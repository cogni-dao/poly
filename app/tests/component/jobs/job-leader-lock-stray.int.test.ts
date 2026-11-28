// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/jobs/job-leader-lock-stray.int.test`
 * Purpose: Prove bug.5066 against a REAL Postgres: a leader-lock connect that
 *          fails must leave NO backend behind, and the session's backend gauge
 *          must report what `pg_stat_activity` reports.
 * Scope: `createJobLeaderLockSession` (real postgres-js 3.4.9) behind a TCP
 *        proxy that fails the first dial. Mocking postgres-js cannot see this:
 *        the stray is postgres-js re-dialling a queued `reserve()` AFTER
 *        `end()` — a behaviour of the real client.
 * Invariants:
 *   - NO_STRAY_BACKENDS: after a failed first dial (RST), zero backends
 *     carry the session's application_name, even after postgres-js's retry
 *     backoff has elapsed. On the pre-fix adapter one backend is left alive
 *     (idle_timeout 0, max_lifetime null — it lives until pod death).
 *   - GAUGE_IS_THE_SERVER: `backendStats()` is read from pg_stat_activity on the
 *     session's own connection (no extra slot), and its `leader` count equals an
 *     independent query from another connection.
 *   - DISPOSE_RELEASES_BACKEND: dispose() leaves zero backends.
 * Side-effects: IO (database connections, a loopback TCP proxy)
 * Links: work/items/bug.5066, src/adapters/server/db/job-leader-lock.client.ts
 * @public
 */

import net from "node:net";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createJobLeaderLockSession } from "@/adapters/server/db/job-leader-lock.client";

/** Longer than postgres-js's first re-dial backoff (0.5-1.5s) on the pre-fix adapter. */
const REDIAL_WINDOW_MS = 3_500;

/** Loopback proxy to the test Postgres whose FIRST inbound connection is reset. */
async function startFlakyProxy(
	target: { host: string; port: number },
): Promise<{ port: number; dials: () => number; close: () => Promise<void> }> {
	let dials = 0;
	const open = new Set<net.Socket>();
	const server = net.createServer((client) => {
		dials += 1;
		open.add(client);
		client.on("close", () => open.delete(client));
		client.on("error", () => {});
		if (dials === 1) {
			// RST mid-handshake: postgres-js surfaces ECONNRESET (a clean FIN would
			// instead be retried transparently inside the same connect).
			client.resetAndDestroy();
			return;
		}
		const upstream = net.connect(target.port, target.host);
		open.add(upstream);
		upstream.on("close", () => {
			open.delete(upstream);
			client.destroy();
		});
		upstream.on("error", () => {});
		client.on("close", () => upstream.destroy());
		client.pipe(upstream);
		upstream.pipe(client);
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	return {
		port: (server.address() as net.AddressInfo).port,
		dials: () => dials,
		close: () =>
			new Promise<void>((resolve) => {
				for (const s of open) s.destroy();
				server.close(() => resolve());
			}),
	};
}

async function backendsNamed(applicationName: string): Promise<number> {
	const rows = (await getSeedDb().execute(
		sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name = ${applicationName}`,
	)) as unknown as Array<{ n: number }>;
	return rows[0]?.n ?? -1;
}

describe("job leader lock: a failed connect leaves no backend (bug.5066)", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((fn) => fn()));
	});

	it(
		"first dial reset: zero strays after the retry window; the retry owns exactly one backend",
		async () => {
			const url = new URL(process.env.DATABASE_SERVICE_URL ?? "");
			const proxy = await startFlakyProxy({
				host: url.hostname,
				port: Number(url.port),
			});
			cleanups.push(proxy.close);
			url.hostname = "127.0.0.1";
			url.port = String(proxy.port);
			const connectionString = url.toString();
			const applicationName = `job-leader-stray-${process.pid}`;

			await expect(
				createJobLeaderLockSession({ connectionString, applicationName }),
			).rejects.toBeDefined();
			expect(proxy.dials()).toBe(1);

			// Past postgres-js's re-dial backoff: nothing may have been revived.
			await new Promise((r) => setTimeout(r, REDIAL_WINDOW_MS));
			expect(await backendsNamed(applicationName)).toBe(0);

			// The elector's next attempt: one backend, owned, gauge == server.
			const session = await createJobLeaderLockSession({
				connectionString,
				applicationName,
				// Private key: files run in parallel workers; never contend for the real one.
				lockKeyText: `poly:job-runner:test-stray-${process.pid}`,
			});
			cleanups.push(() => session.dispose());
			expect(await session.tryAcquire()).toBe(true);
			expect(await backendsNamed(applicationName)).toBe(1);
			const stats = await session.backendStats?.();
			expect(stats?.leader).toBe(1);
			expect(stats?.role).toBeGreaterThanOrEqual(stats?.leader ?? 99);

			await session.dispose();
			await waitForNoBackends(applicationName);
		},
		30_000,
	);
});

async function waitForNoBackends(applicationName: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if ((await backendsNamed(applicationName)) === 0) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	expect(await backendsNamed(applicationName)).toBe(0);
}

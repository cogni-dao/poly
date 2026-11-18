// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * bug.5057 — the resting sweep is a process singleton: a second start replaces
 * (stops) the first, a stale stop fn only stops its own sweep, and ticks never
 * overlap.
 */

import type { LoggerPort } from "@cogni/poly-market-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startRestingSweep } from "@/bootstrap/jobs/poly-mirror-resting-sweep.job";

function fakeLogger(): LoggerPort {
	const logger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: () => logger,
	};
	return logger as unknown as LoggerPort;
}

function makeSweep(findStaleOpen: () => Promise<unknown[]>) {
	const find = vi.fn(findStaleOpen);
	const deps = {
		ledger: { findStaleOpen: find, markCanceled: vi.fn() },
		cancelOrderFor: vi.fn(),
		logger: fakeLogger(),
		metrics: { incr: vi.fn(), observeDurationMs: vi.fn() },
		intervalMs: 1_000,
	};
	return {
		find,
		deps: deps as unknown as Parameters<typeof startRestingSweep>[0],
	};
}

describe("startRestingSweep singleton (bug.5057)", () => {
	const stops: Array<() => void> = [];
	afterEach(() => {
		for (const s of stops.splice(0)) s();
		vi.useRealTimers();
	});

	it("a second start stops the first: only one sweep ticks per interval", async () => {
		vi.useFakeTimers();
		const a = makeSweep(async () => []);
		const b = makeSweep(async () => []);
		stops.push(startRestingSweep(a.deps));
		const aAtStart = a.find.mock.calls.length;
		stops.push(startRestingSweep(b.deps));
		await vi.advanceTimersByTimeAsync(3_000);
		expect(a.find.mock.calls.length).toBe(aAtStart); // replaced sweep never ticks again
		expect(b.find.mock.calls.length).toBe(1 + 3); // immediate tick + 3 intervals
	});

	it("a stale stop fn does not stop the replacement sweep", async () => {
		vi.useFakeTimers();
		const a = makeSweep(async () => []);
		const b = makeSweep(async () => []);
		const stopA = startRestingSweep(a.deps);
		stops.push(startRestingSweep(b.deps));
		stopA(); // must be a no-op for B
		await vi.advanceTimersByTimeAsync(2_000);
		expect(b.find.mock.calls.length).toBe(1 + 2);
	});

	it("does not re-enter a tick that is still running", async () => {
		vi.useFakeTimers();
		let release: (() => void) | undefined;
		const slow = makeSweep(
			() =>
				new Promise<unknown[]>((resolve) => {
					release = () => resolve([]);
				}),
		);
		stops.push(startRestingSweep(slow.deps));
		await vi.advanceTimersByTimeAsync(5_000); // 5 intervals while tick #1 hangs
		expect(slow.find.mock.calls.length).toBe(1);
		release?.();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(slow.find.mock.calls.length).toBe(2);
	});
});

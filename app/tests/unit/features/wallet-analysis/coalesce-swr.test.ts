// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/coalesce-swr`
 * Purpose: Prove the serve-stale-while-revalidate mode added to the coalesce
 *   TTL cache for the interim research-latency mitigation
 *   (fix/research-route-caching): fresh hit, stale-serve + single-flight
 *   background refresh, absent compute, error-never-cached, refresh-failure
 *   keeps stale, and the `shouldCache` degraded-not-pinned gate.
 * Scope: Unit — real `coalesce.ts` implementation, fake timers for the clock.
 *   No HTTP, no DB. Follows the `dashboard-route-cache.test.ts` patterns.
 * Invariants under test (see coalesce.ts docstring):
 *   - SWR_SINGLE_FLIGHT_REFRESH, FAILED_FETCH_NOT_CACHED, CONCURRENT_DEDUP,
 *     COALESCE_UNCHANGED (legacy coalesce untouched — covered by the existing
 *     dashboard-route-cache suite).
 * Side-effects: none (module cache reset per spec via `clearTtlCache`).
 * Links: src/features/wallet-analysis/server/coalesce.ts,
 *        src/features/wallet-analysis/server/research-read-cache.ts
 * @internal
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTtlCache,
  coalesceSwr,
} from "@/features/wallet-analysis/server/coalesce";

const FRESH_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;
const OPTS = { freshMs: FRESH_MS, staleMs: STALE_MS };
const KEY = "research:test:key";

/** Flush pending microtasks so fire-and-forget background refreshes settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe("coalesceSwr (fix/research-route-caching)", () => {
  beforeEach(() => {
    clearTtlCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("absent key computes once; a concurrent burst shares the in-flight fetch", async () => {
    const fetcher = vi.fn(async () => ({ n: 1 }));

    const [first, second] = await Promise.all([
      coalesceSwr(KEY, fetcher, OPTS),
      coalesceSwr(KEY, fetcher, OPTS),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("a fresh hit serves the cached value with no recompute", async () => {
    const fetcher = vi.fn(async () => ({ n: 1 }));

    const first = await coalesceSwr(KEY, fetcher, OPTS);
    vi.advanceTimersByTime(FRESH_MS - 1_000);
    const second = await coalesceSwr(KEY, fetcher, OPTS);
    await flushMicrotasks();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("a stale hit returns the stale value immediately and refreshes in the background", async () => {
    const fetcher = vi
      .fn<() => Promise<{ n: number }>>()
      .mockResolvedValueOnce({ n: 1 })
      .mockResolvedValueOnce({ n: 2 });

    const first = await coalesceSwr(KEY, fetcher, OPTS);
    vi.advanceTimersByTime(FRESH_MS + 1_000); // stale, inside staleMs

    const staleServed = await coalesceSwr(KEY, fetcher, OPTS);
    expect(staleServed).toBe(first); // stale value served instantly
    await flushMicrotasks(); // let the background refresh land

    expect(fetcher).toHaveBeenCalledTimes(2);
    // The refreshed value is now fresh — served without another fetch.
    const afterRefresh = await coalesceSwr(KEY, fetcher, OPTS);
    expect(afterRefresh).toEqual({ n: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("repeated stale hits kick exactly one background refresh (single-flight)", async () => {
    let resolveRefresh: ((v: { n: number }) => void) | undefined;
    const fetcher = vi
      .fn<() => Promise<{ n: number }>>()
      .mockResolvedValueOnce({ n: 1 })
      .mockImplementation(
        () =>
          new Promise<{ n: number }>((resolve) => {
            resolveRefresh = resolve;
          })
      );

    const first = await coalesceSwr(KEY, fetcher, OPTS);
    vi.advanceTimersByTime(FRESH_MS + 1_000);

    // Three stale hits while the refresh is still in flight.
    expect(await coalesceSwr(KEY, fetcher, OPTS)).toBe(first);
    expect(await coalesceSwr(KEY, fetcher, OPTS)).toBe(first);
    expect(await coalesceSwr(KEY, fetcher, OPTS)).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(2); // initial + ONE refresh

    resolveRefresh?.({ n: 2 });
    await flushMicrotasks();
    expect(await coalesceSwr(KEY, fetcher, OPTS)).toEqual({ n: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("beyond the stale horizon the entry is dead: callers block on a recompute", async () => {
    const fetcher = vi
      .fn<() => Promise<{ n: number }>>()
      .mockResolvedValueOnce({ n: 1 })
      .mockResolvedValueOnce({ n: 2 });

    await coalesceSwr(KEY, fetcher, OPTS);
    vi.advanceTimersByTime(STALE_MS + 1_000);

    const recomputed = await coalesceSwr(KEY, fetcher, OPTS);
    expect(recomputed).toEqual({ n: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("a rejected compute is never cached: the next caller retries (FAILED_FETCH_NOT_CACHED)", async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce("recovered");

    await expect(coalesceSwr(KEY, fetcher, OPTS)).rejects.toThrow("db down");
    await expect(coalesceSwr(KEY, fetcher, OPTS)).resolves.toBe("recovered");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("a failed background refresh keeps serving the stale value and re-arms the refresh guard", async () => {
    const onRefreshError = vi.fn();
    const fetcher = vi
      .fn<() => Promise<{ n: number }>>()
      .mockResolvedValueOnce({ n: 1 })
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce({ n: 2 });

    const first = await coalesceSwr(KEY, fetcher, { ...OPTS, onRefreshError });
    vi.advanceTimersByTime(FRESH_MS + 1_000);

    // Stale hit → refresh #1 fails; stale value still served.
    expect(
      await coalesceSwr(KEY, fetcher, { ...OPTS, onRefreshError })
    ).toBe(first);
    await flushMicrotasks();
    expect(onRefreshError).toHaveBeenCalledTimes(1);

    // Guard re-armed: the next stale hit retries the refresh, which succeeds.
    expect(
      await coalesceSwr(KEY, fetcher, { ...OPTS, onRefreshError })
    ).toBe(first);
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await coalesceSwr(KEY, fetcher, { ...OPTS, onRefreshError })).toEqual(
      { n: 2 }
    );
  });

  it("shouldCache=false serves the value but never pins it (DEGRADED_NOT_PINNED)", async () => {
    type Slice = { kind: "ok" | "warn"; n: number };
    const shouldCache = (v: Slice) => v.kind === "ok";
    const fetcher = vi
      .fn<() => Promise<Slice>>()
      .mockResolvedValueOnce({ kind: "warn", n: 1 })
      .mockResolvedValueOnce({ kind: "ok", n: 2 });

    const degraded = await coalesceSwr(KEY, fetcher, { ...OPTS, shouldCache });
    expect(degraded.kind).toBe("warn");

    // Not cached: the immediate next call recomputes and gets the recovery.
    const recovered = await coalesceSwr(KEY, fetcher, { ...OPTS, shouldCache });
    expect(recovered).toEqual({ kind: "ok", n: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("a non-cacheable background refresh keeps the prior stale value", async () => {
    type Slice = { kind: "ok" | "warn"; n: number };
    const shouldCache = (v: Slice) => v.kind === "ok";
    const fetcher = vi
      .fn<() => Promise<Slice>>()
      .mockResolvedValueOnce({ kind: "ok", n: 1 })
      .mockResolvedValueOnce({ kind: "warn", n: 99 })
      .mockResolvedValueOnce({ kind: "ok", n: 2 });

    const first = await coalesceSwr(KEY, fetcher, { ...OPTS, shouldCache });
    vi.advanceTimersByTime(FRESH_MS + 1_000);

    // Stale hit → refresh returns a warn: the good stale value is NOT replaced.
    expect(await coalesceSwr(KEY, fetcher, { ...OPTS, shouldCache })).toBe(
      first
    );
    await flushMicrotasks();
    expect(await coalesceSwr(KEY, fetcher, { ...OPTS, shouldCache })).toBe(
      first
    );
    await flushMicrotasks();
    // Second stale hit retried the refresh (guard re-armed) and got the ok.
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await coalesceSwr(KEY, fetcher, { ...OPTS, shouldCache })).toEqual({
      kind: "ok",
      n: 2,
    });
  });
});

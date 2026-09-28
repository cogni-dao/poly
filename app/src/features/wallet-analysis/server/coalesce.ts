// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/coalesce`
 * Purpose: Tiny module-scoped TTL cache that also coalesces concurrent requests for the same key — N callers waiting on the same key share one in-flight fetch. `coalesceSwr` adds a serve-stale-while-revalidate mode for the heavy research aggregates.
 * Scope: Pure utility. Does not know about wallets, slices, HTTP, or React. Module-scope state means one instance per Node process; cache survives only while the process lives.
 * Invariants:
 *   - SINGLE_REPLICA: cache lives in-process and stays per-replica even now that background WRITERS are single-pod via leader election (task.5016, `@bootstrap/jobs/job-leader-elector`). >1 replica degrades hit rate only (each replica recomputes from the DB) — a perf, not correctness, concern.
 *   - CONCURRENT_DEDUP: simultaneous calls for the same key resolve to one fetcher invocation (both modes).
 *   - FAILED_FETCH_NOT_CACHED: rejected fetchers are evicted so the next caller retries. In SWR mode a FAILED BACKGROUND REFRESH keeps the existing stale value (still bounded by `staleMs`) and re-arms the refresh guard.
 *   - SWR_SINGLE_FLIGHT_REFRESH: a stale hit returns the stale value immediately and kicks at most ONE background refresh per key, no matter how many callers observe the stale window.
 *   - COALESCE_UNCHANGED: `coalesce()` semantics are untouched; both helpers share one Map so `clearTtlCache`/`clearTtlCacheByPrefix` cover SWR entries too.
 * Side-effects: holds a Map in module scope; no I/O of its own.
 * Notes: Use `clearTtlCache()` in tests to reset module state between specs. Routes that mutate wallet state can selectively evict stale slices with `clearTtlCacheByPrefix(...)`.
 * Links: docs/design/wallet-analysis-components.md
 * @public
 */

type Entry<T> = {
  value?: T;
  expiresAt?: number;
  /** SWR only: serve-stale horizon. Beyond this the entry is dead. */
  staleUntil?: number;
  inFlight?: Promise<T>;
  /** SWR only: guard so a stale window kicks exactly one background refresh. */
  refreshing?: boolean;
};

const cache = new Map<string, Entry<unknown>>();

/**
 * Get-or-fetch with a TTL window and concurrent-dedupe.
 *
 * Behaviour:
 *  1. If a fresh value exists for `key`, return it immediately.
 *  2. If a fetch is already in flight for `key`, await that same promise.
 *  3. Otherwise invoke `fetcher()`, store the in-flight promise, and on
 *     success cache the value with `expiresAt = now + ttlMs`. On failure
 *     evict so the next caller retries.
 */
export async function coalesce<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number
): Promise<T> {
  const now = Date.now();
  const existing = cache.get(key) as Entry<T> | undefined;

  if (existing?.value !== undefined && (existing.expiresAt ?? 0) > now) {
    return existing.value;
  }
  if (existing?.inFlight) {
    return existing.inFlight;
  }

  const promise = (async () => {
    try {
      const value = await fetcher();
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } catch (err) {
      cache.delete(key);
      throw err;
    }
  })();

  cache.set(key, { inFlight: promise });
  return promise;
}

export type CoalesceSwrOptions<T> = {
  /** Age below which a cached value is served with no recompute at all. */
  freshMs: number;
  /**
   * Age below which a cached value is still served instantly, but a single
   * background refresh is kicked. Must be >= freshMs. Beyond it the entry is
   * treated as absent (blocking recompute).
   */
  staleMs: number;
  /**
   * Optional gate: return false to serve a computed value WITHOUT caching it
   * (e.g. degraded `{kind:"warn"}` slices must not be pinned for `staleMs`).
   * On a background refresh, a non-cacheable value keeps the prior stale entry.
   */
  shouldCache?: (value: T) => boolean;
  /** Optional observer for background-refresh failures (they never throw to callers). */
  onRefreshError?: (err: unknown) => void;
};

/**
 * Serve-stale-while-revalidate get-or-fetch (interim research-latency
 * mitigation — see `research-read-cache.ts`).
 *
 * Behaviour:
 *  1. Fresh hit (`age < freshMs`) → return the cached value.
 *  2. Stale-but-present (`freshMs <= age < staleMs`) → return the stale value
 *     immediately AND kick one single-flight background refresh.
 *  3. Absent/expired → compute (single-flight, shared by concurrent callers).
 *     Rejection evicts so the next caller retries (FAILED_FETCH_NOT_CACHED).
 */
export async function coalesceSwr<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: CoalesceSwrOptions<T>
): Promise<T> {
  const now = Date.now();
  const shouldCache = opts.shouldCache ?? (() => true);
  const existing = cache.get(key) as Entry<T> | undefined;

  if (existing?.value !== undefined) {
    if ((existing.expiresAt ?? 0) > now) {
      return existing.value;
    }
    if ((existing.staleUntil ?? 0) > now) {
      if (!existing.refreshing) {
        existing.refreshing = true;
        void (async () => {
          try {
            const value = await fetcher();
            if (shouldCache(value)) {
              cache.set(key, {
                value,
                expiresAt: Date.now() + opts.freshMs,
                staleUntil: Date.now() + opts.staleMs,
              });
            } else {
              // Keep serving the prior stale value (bounded by staleUntil);
              // let a later stale hit retry the refresh.
              existing.refreshing = false;
            }
          } catch (err) {
            existing.refreshing = false;
            opts.onRefreshError?.(err);
          }
        })();
      }
      return existing.value;
    }
  }
  if (existing?.inFlight) {
    return existing.inFlight;
  }

  const promise = (async () => {
    try {
      const value = await fetcher();
      if (shouldCache(value)) {
        cache.set(key, {
          value,
          expiresAt: Date.now() + opts.freshMs,
          staleUntil: Date.now() + opts.staleMs,
        });
      } else {
        cache.delete(key);
      }
      return value;
    } catch (err) {
      cache.delete(key);
      throw err;
    }
  })();

  cache.set(key, { inFlight: promise });
  return promise;
}

/** Test-only: drop all cache state. */
export function clearTtlCache(): void {
  cache.clear();
}

/** Drop every cache key that starts with `prefix`; used after wallet-mutating writes. */
export function clearTtlCacheByPrefix(prefix: string): number {
  let removed = 0;
  for (const key of cache.keys()) {
    if (!key.startsWith(prefix)) continue;
    cache.delete(key);
    removed += 1;
  }
  return removed;
}

/** Test-only: how many keys are currently cached (in-flight or warm). */
export function ttlCacheSize(): number {
  return cache.size;
}

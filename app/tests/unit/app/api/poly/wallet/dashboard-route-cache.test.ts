// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/poly/wallet/dashboard-route-cache`
 * Purpose: Prove the coalesced dashboard-route payload cache (task.5013)
 *   and the longer-TTL wallet-balances cache (task.5010) against the real
 *   `coalesce` TTL cache: burst dedupe, refresh invalidation, tenant
 *   scoping, key shape, error-never-cached, and degraded-balances-never-
 *   cached.
 * Scope: Unit — exercises `dashboard-route-cache` key builders +
 *   `invalidateDashboardRouteCaches` + `coalesceWalletBalances` together
 *   with the real `@features/wallet-analysis/server/coalesce`
 *   implementation the overview/execution routes call. No HTTP, no DB.
 * Invariants:
 *   - two rapid calls for the same key compute once (CONCURRENT_DEDUP +
 *     TTL hit)
 *   - `invalidateDashboardRouteCaches` evicts both routes' keys AND the
 *     balances key for the tenant → next call recomputes; other tenants
 *     stay cached
 *   - rejected fetchers are evicted, never cached (FAILED_FETCH_NOT_CACHED)
 *   - overview keys vary by interval + freshness; execution keys do not
 *   - balances: warm reads outlive the 5s route TTL, expire after 30s,
 *     and null/degraded reads are served once but never pinned
 *     (BALANCES_DEGRADED_NOT_CACHED)
 * Side-effects: none (module cache reset per spec via `clearTtlCache`)
 * Links: src/app/api/v1/poly/wallet/_lib/dashboard-route-cache.ts,
 *        src/features/wallet-analysis/server/coalesce.ts
 * @internal
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coalesceWalletBalances,
  DASHBOARD_ROUTE_CACHE_TTL_MS,
  executionRouteCacheKey,
  invalidateDashboardRouteCaches,
  overviewRouteCacheKey,
  WALLET_BALANCES_CACHE_TTL_MS,
  walletBalancesCacheKey,
} from "@/app/api/v1/poly/wallet/_lib/dashboard-route-cache";
import {
  clearTtlCache,
  coalesce,
} from "@/features/wallet-analysis/server/coalesce";

const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("dashboard-route-cache (task.5013)", () => {
  beforeEach(() => {
    clearTtlCache();
  });

  it("two rapid concurrent calls share one in-flight computation", async () => {
    const fetcher = vi.fn(async () => ({ usdc_total: 12.34 }));
    const key = overviewRouteCacheKey(ACCOUNT_A, "1W", "live");

    const [first, second] = await Promise.all([
      coalesce(key, fetcher, DASHBOARD_ROUTE_CACHE_TTL_MS),
      coalesce(key, fetcher, DASHBOARD_ROUTE_CACHE_TTL_MS),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("a sequential call inside the TTL window serves the cached payload", async () => {
    const fetcher = vi.fn(async () => ({ live_positions: [1, 2, 3] }));
    const key = executionRouteCacheKey(ACCOUNT_A);

    const first = await coalesce(key, fetcher, DASHBOARD_ROUTE_CACHE_TTL_MS);
    const second = await coalesce(key, fetcher, DASHBOARD_ROUTE_CACHE_TTL_MS);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("refresh invalidation evicts both routes' keys and forces recompute", async () => {
    const overviewFetcher = vi.fn(async () => ({ payload: "overview" }));
    const executionFetcher = vi.fn(async () => ({ payload: "execution" }));
    const overviewKey = overviewRouteCacheKey(ACCOUNT_A, "1W", "live");
    const executionKey = executionRouteCacheKey(ACCOUNT_A);

    await coalesce(overviewKey, overviewFetcher, DASHBOARD_ROUTE_CACHE_TTL_MS);
    await coalesce(
      executionKey,
      executionFetcher,
      DASHBOARD_ROUTE_CACHE_TTL_MS
    );
    expect(overviewFetcher).toHaveBeenCalledTimes(1);
    expect(executionFetcher).toHaveBeenCalledTimes(1);

    const removed = invalidateDashboardRouteCaches(ACCOUNT_A);
    expect(removed).toBe(2);

    await coalesce(overviewKey, overviewFetcher, DASHBOARD_ROUTE_CACHE_TTL_MS);
    await coalesce(
      executionKey,
      executionFetcher,
      DASHBOARD_ROUTE_CACHE_TTL_MS
    );
    expect(overviewFetcher).toHaveBeenCalledTimes(2);
    expect(executionFetcher).toHaveBeenCalledTimes(2);
  });

  it("invalidation is tenant-scoped: other accounts stay cached", async () => {
    const fetcherA = vi.fn(async () => "a");
    const fetcherB = vi.fn(async () => "b");
    const keyA = executionRouteCacheKey(ACCOUNT_A);
    const keyB = executionRouteCacheKey(ACCOUNT_B);

    await coalesce(keyA, fetcherA, DASHBOARD_ROUTE_CACHE_TTL_MS);
    await coalesce(keyB, fetcherB, DASHBOARD_ROUTE_CACHE_TTL_MS);

    invalidateDashboardRouteCaches(ACCOUNT_A);

    await coalesce(keyA, fetcherA, DASHBOARD_ROUTE_CACHE_TTL_MS);
    await coalesce(keyB, fetcherB, DASHBOARD_ROUTE_CACHE_TTL_MS);

    expect(fetcherA).toHaveBeenCalledTimes(2);
    expect(fetcherB).toHaveBeenCalledTimes(1);
  });

  it("a thrown error is never cached: the next call retries the fetcher", async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce("recovered");
    const key = overviewRouteCacheKey(ACCOUNT_A, "1W", "live");

    await expect(
      coalesce(key, fetcher, DASHBOARD_ROUTE_CACHE_TTL_MS)
    ).rejects.toThrow("upstream down");

    await expect(
      coalesce(key, fetcher, DASHBOARD_ROUTE_CACHE_TTL_MS)
    ).resolves.toBe("recovered");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("overview keys vary by interval + freshness; execution keys by account only", () => {
    expect(overviewRouteCacheKey(ACCOUNT_A, "1W", "live")).not.toBe(
      overviewRouteCacheKey(ACCOUNT_A, "1M", "live")
    );
    expect(overviewRouteCacheKey(ACCOUNT_A, "1W", "live")).not.toBe(
      overviewRouteCacheKey(ACCOUNT_A, "1W", "read_model")
    );
    expect(overviewRouteCacheKey(ACCOUNT_A, "1W", "live")).not.toBe(
      overviewRouteCacheKey(ACCOUNT_B, "1W", "live")
    );
    expect(executionRouteCacheKey(ACCOUNT_A)).toBe(
      executionRouteCacheKey(ACCOUNT_A)
    );
    expect(executionRouteCacheKey(ACCOUNT_A)).not.toBe(
      executionRouteCacheKey(ACCOUNT_B)
    );
  });

  it("TTL sits inside the 5-10s window the dashboard budgets for", () => {
    expect(DASHBOARD_ROUTE_CACHE_TTL_MS).toBeGreaterThanOrEqual(5_000);
    expect(DASHBOARD_ROUTE_CACHE_TTL_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("wallet balances cache (task.5010)", () => {
  const okBalances = {
    address: "0x1111111111111111111111111111111111111111" as const,
    usdcE: 12.5,
    pusd: 987.65,
    pol: 0.42,
    errors: [] as readonly string[],
  };
  const degradedBalances = {
    ...okBalances,
    usdcE: null,
    pusd: null,
    pol: null,
    errors: ["polygon_rpc: HTTP request timed out"] as readonly string[],
  };

  beforeEach(() => {
    clearTtlCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("balances TTL is meaningfully longer than the route-payload TTL", () => {
    expect(WALLET_BALANCES_CACHE_TTL_MS).toBe(30_000);
    expect(WALLET_BALANCES_CACHE_TTL_MS).toBeGreaterThan(
      DASHBOARD_ROUTE_CACHE_TTL_MS * 2
    );
  });

  it("a warm successful read outlives the route TTL and never re-hits RPC inside 30s", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => okBalances);

    const first = await coalesceWalletBalances(ACCOUNT_A, fetcher);
    // Past the 5s route-payload TTL but inside the 30s balances TTL: a cold
    // route-cache recompute must be served from warm balances (the whole
    // point of taking RPC off the first-paint path).
    vi.advanceTimersByTime(DASHBOARD_ROUTE_CACHE_TTL_MS + 1_000);
    const second = await coalesceWalletBalances(ACCOUNT_A, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("an expired entry (past 30s) refetches", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => okBalances);

    await coalesceWalletBalances(ACCOUNT_A, fetcher);
    vi.advanceTimersByTime(WALLET_BALANCES_CACHE_TTL_MS + 1);
    await coalesceWalletBalances(ACCOUNT_A, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("a concurrent burst shares one balance fetch", async () => {
    const fetcher = vi.fn(async () => okBalances);

    const [first, second] = await Promise.all([
      coalesceWalletBalances(ACCOUNT_A, fetcher),
      coalesceWalletBalances(ACCOUNT_A, fetcher),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("refresh invalidation covers the balances key → next read is fresh RPC", async () => {
    const fetcher = vi.fn(async () => okBalances);

    await coalesceWalletBalances(ACCOUNT_A, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const removed = invalidateDashboardRouteCaches(ACCOUNT_A);
    expect(removed).toBe(1);

    await coalesceWalletBalances(ACCOUNT_A, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("balances invalidation is tenant-scoped", async () => {
    const fetcherA = vi.fn(async () => okBalances);
    const fetcherB = vi.fn(async () => okBalances);

    await coalesceWalletBalances(ACCOUNT_A, fetcherA);
    await coalesceWalletBalances(ACCOUNT_B, fetcherB);

    invalidateDashboardRouteCaches(ACCOUNT_A);

    await coalesceWalletBalances(ACCOUNT_A, fetcherA);
    await coalesceWalletBalances(ACCOUNT_B, fetcherB);

    expect(fetcherA).toHaveBeenCalledTimes(2);
    expect(fetcherB).toHaveBeenCalledTimes(1);
  });

  it("a degraded read (RPC timeout leg → errors) is served but never cached", async () => {
    const fetcher = vi
      .fn<() => Promise<typeof okBalances>>()
      .mockResolvedValueOnce(degradedBalances)
      .mockResolvedValueOnce(okBalances);

    const first = await coalesceWalletBalances(ACCOUNT_A, fetcher);
    expect(first.errors).toContain("polygon_rpc: HTTP request timed out");
    expect(first.usdcE).toBeNull();

    // Degraded snapshot must not be pinned for 30s: the immediate next
    // request retries and gets the recovered balances.
    const second = await coalesceWalletBalances(ACCOUNT_A, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(second).toBe(okBalances);
  });

  it("a null read (no trading wallet yet) is served but never cached", async () => {
    const fetcher = vi
      .fn<() => Promise<typeof okBalances | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(okBalances);

    await expect(coalesceWalletBalances(ACCOUNT_A, fetcher)).resolves.toBeNull();
    // Connecting a wallet must be visible on the very next request.
    await expect(coalesceWalletBalances(ACCOUNT_A, fetcher)).resolves.toBe(
      okBalances
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("balances keys are tenant-distinct and use the documented namespace", () => {
    expect(walletBalancesCacheKey(ACCOUNT_A)).toBe(`balances:${ACCOUNT_A}`);
    expect(walletBalancesCacheKey(ACCOUNT_A)).not.toBe(
      walletBalancesCacheKey(ACCOUNT_B)
    );
  });
});

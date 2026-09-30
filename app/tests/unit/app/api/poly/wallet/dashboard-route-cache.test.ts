// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/poly/wallet/dashboard-route-cache`
 * Purpose: Prove the SWR-coalesced dashboard-route payload cache
 *   (task.5013 + dashboard read-path floor fix), the shared
 *   ledger-positions / current-positions read entries, and the longer-TTL
 *   wallet-balances cache (task.5010) against the real coalesce/coalesceSwr
 *   implementation: fresh serve, stale serve + single background refresh,
 *   burst dedupe, refresh invalidation, tenant scoping, key shape,
 *   error-never-cached, and degraded-balances-never-cached.
 * Scope: Unit — exercises `dashboard-route-cache` key builders + wrappers +
 *   `invalidateDashboardRouteCaches` together with the real
 *   `@features/wallet-analysis/server/coalesce` implementation the
 *   overview/execution routes call. No HTTP, no DB.
 * Invariants:
 *   - SWR_TICKS_SERVE_STALE: a stale hit returns the previous payload
 *     immediately and kicks exactly ONE background recompute
 *   - fresh hits recompute nothing; expired (past staleMs) hits block
 *   - shared reads: one entry serves both routes' byte-identical calls
 *   - `invalidateDashboardRouteCaches` evicts route payloads, balances,
 *     AND shared-read keys for the tenant; other tenants stay cached
 *   - rejected fetchers are evicted, never cached (FAILED_FETCH_NOT_CACHED)
 *   - balances: warm reads outlive the route fresh window, expire after
 *     30s, and null/degraded reads are served once but never pinned
 *     (BALANCES_DEGRADED_NOT_CACHED)
 * Side-effects: none (module cache reset per spec via `clearTtlCache`)
 * Links: src/app/api/v1/poly/wallet/_lib/dashboard-route-cache.ts,
 *        src/features/wallet-analysis/server/coalesce.ts
 * @internal
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coalesceCurrentWalletPositions,
  coalesceDashboardRoutePayload,
  coalesceTenantLedgerPositions,
  coalesceWalletBalances,
  currentWalletPositionsCacheKey,
  DASHBOARD_ROUTE_CACHE_FRESH_MS,
  DASHBOARD_ROUTE_CACHE_STALE_MS,
  DASHBOARD_SHARED_READ_FRESH_MS,
  executionRouteCacheKey,
  invalidateDashboardRouteCaches,
  overviewRouteCacheKey,
  tenantLedgerPositionsCacheKey,
  WALLET_BALANCES_CACHE_TTL_MS,
  walletBalancesCacheKey,
} from "@/app/api/v1/poly/wallet/_lib/dashboard-route-cache";
import { clearTtlCache } from "@/features/wallet-analysis/server/coalesce";

const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

/** Let the void background-refresh promise inside coalesceSwr settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("dashboard route payload cache (task.5013, SWR)", () => {
  beforeEach(() => {
    clearTtlCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("two rapid concurrent calls share one in-flight computation", async () => {
    const fetcher = vi.fn(async () => ({ usdc_total: 12.34 }));
    const key = overviewRouteCacheKey(ACCOUNT_A, "1W", "live");

    const [first, second] = await Promise.all([
      coalesceDashboardRoutePayload(key, fetcher),
      coalesceDashboardRoutePayload(key, fetcher),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("a hit inside the fresh window recomputes nothing", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => ({ live_positions: [1, 2, 3] }));
    const key = executionRouteCacheKey(ACCOUNT_A);

    const first = await coalesceDashboardRoutePayload(key, fetcher);
    vi.advanceTimersByTime(DASHBOARD_ROUTE_CACHE_FRESH_MS - 1_000);
    const second = await coalesceDashboardRoutePayload(key, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("a 30s dashboard tick (stale window) serves the previous payload and kicks ONE background recompute", async () => {
    vi.useFakeTimers();
    let generation = 0;
    const fetcher = vi.fn(async () => ({ generation: (generation += 1) }));
    const key = executionRouteCacheKey(ACCOUNT_A);

    const first = await coalesceDashboardRoutePayload(key, fetcher);
    expect(first).toEqual({ generation: 1 });

    // The client refetches every 30s: past fresh (20s), inside stale (5min).
    vi.advanceTimersByTime(30_000);
    const [tickA, tickB] = await Promise.all([
      coalesceDashboardRoutePayload(key, fetcher),
      coalesceDashboardRoutePayload(key, fetcher),
    ]);
    // Both stale observers get the previous payload instantly...
    expect(tickA).toBe(first);
    expect(tickB).toBe(first);
    await flushMicrotasks();
    // ...and exactly one background recompute ran.
    expect(fetcher).toHaveBeenCalledTimes(2);

    // The refreshed value is now the fresh-window serve.
    const next = await coalesceDashboardRoutePayload(key, fetcher);
    expect(next).toEqual({ generation: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("past the stale horizon the entry is dead: the call blocks on a fresh compute", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockResolvedValueOnce("new");
    const key = executionRouteCacheKey(ACCOUNT_A);

    await coalesceDashboardRoutePayload(key, fetcher);
    vi.advanceTimersByTime(DASHBOARD_ROUTE_CACHE_STALE_MS + 1);

    await expect(coalesceDashboardRoutePayload(key, fetcher)).resolves.toBe(
      "new"
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refresh invalidation evicts both routes' keys and forces recompute", async () => {
    const overviewFetcher = vi.fn(async () => ({ payload: "overview" }));
    const executionFetcher = vi.fn(async () => ({ payload: "execution" }));
    const overviewKey = overviewRouteCacheKey(ACCOUNT_A, "1W", "live");
    const executionKey = executionRouteCacheKey(ACCOUNT_A);

    await coalesceDashboardRoutePayload(overviewKey, overviewFetcher);
    await coalesceDashboardRoutePayload(executionKey, executionFetcher);

    const removed = invalidateDashboardRouteCaches(ACCOUNT_A);
    expect(removed).toBe(2);

    await coalesceDashboardRoutePayload(overviewKey, overviewFetcher);
    await coalesceDashboardRoutePayload(executionKey, executionFetcher);
    expect(overviewFetcher).toHaveBeenCalledTimes(2);
    expect(executionFetcher).toHaveBeenCalledTimes(2);
  });

  it("invalidation is tenant-scoped: other accounts stay cached", async () => {
    const fetcherA = vi.fn(async () => "a");
    const fetcherB = vi.fn(async () => "b");

    await coalesceDashboardRoutePayload(executionRouteCacheKey(ACCOUNT_A), fetcherA);
    await coalesceDashboardRoutePayload(executionRouteCacheKey(ACCOUNT_B), fetcherB);

    invalidateDashboardRouteCaches(ACCOUNT_A);

    await coalesceDashboardRoutePayload(executionRouteCacheKey(ACCOUNT_A), fetcherA);
    await coalesceDashboardRoutePayload(executionRouteCacheKey(ACCOUNT_B), fetcherB);

    expect(fetcherA).toHaveBeenCalledTimes(2);
    expect(fetcherB).toHaveBeenCalledTimes(1);
  });

  it("a thrown error is never cached: the next call retries the fetcher", async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce("recovered");
    const key = overviewRouteCacheKey(ACCOUNT_A, "1W", "live");

    await expect(coalesceDashboardRoutePayload(key, fetcher)).rejects.toThrow(
      "upstream down"
    );
    await expect(coalesceDashboardRoutePayload(key, fetcher)).resolves.toBe(
      "recovered"
    );
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

  it("fresh window sits below the client's 30s tick; stale horizon bounds worst-case staleness", () => {
    expect(DASHBOARD_ROUTE_CACHE_FRESH_MS).toBeLessThan(30_000);
    expect(DASHBOARD_ROUTE_CACHE_FRESH_MS).toBeGreaterThanOrEqual(15_000);
    expect(DASHBOARD_ROUTE_CACHE_STALE_MS).toBe(5 * 60_000);
  });
});

describe("shared dashboard reads (ledger positions + current positions)", () => {
  beforeEach(() => {
    clearTtlCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("both routes' byte-identical ledger reads share one entry", async () => {
    const fetcher = vi.fn(async () => [{ fill_id: "f1" }]);

    // Execution route computes first; overview route follows on initial load.
    const fromExecution = await coalesceTenantLedgerPositions(
      ACCOUNT_A,
      fetcher
    );
    const fromOverview = await coalesceTenantLedgerPositions(ACCOUNT_A, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fromOverview).toBe(fromExecution);
  });

  it("both routes' current-position model reads share one entry", async () => {
    const fetcher = vi.fn(async () => ({ positions: [], warnings: [] }));

    const first = await coalesceCurrentWalletPositions(
      ACCOUNT_A,
      WALLET,
      fetcher
    );
    const second = await coalesceCurrentWalletPositions(
      ACCOUNT_A,
      // Address case-insensitivity: key lowercases the address.
      WALLET.toUpperCase().replace("0X", "0x"),
      fetcher
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("a stale shared read serves instantly and refreshes once in the background", async () => {
    vi.useFakeTimers();
    let generation = 0;
    const fetcher = vi.fn(async () => ({ generation: (generation += 1) }));

    const first = await coalesceTenantLedgerPositions(ACCOUNT_A, fetcher);
    vi.advanceTimersByTime(DASHBOARD_SHARED_READ_FRESH_MS + 1_000);

    const stale = await coalesceTenantLedgerPositions(ACCOUNT_A, fetcher);
    expect(stale).toBe(first);
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(
      coalesceTenantLedgerPositions(ACCOUNT_A, fetcher)
    ).resolves.toEqual({ generation: 2 });
  });

  it("refresh invalidation evicts the shared-read keys along with the payloads", async () => {
    const ledgerFetcher = vi.fn(async () => "ledger");
    const currentFetcher = vi.fn(async () => "current");

    await coalesceTenantLedgerPositions(ACCOUNT_A, ledgerFetcher);
    await coalesceCurrentWalletPositions(ACCOUNT_A, WALLET, currentFetcher);

    const removed = invalidateDashboardRouteCaches(ACCOUNT_A);
    expect(removed).toBe(2);

    await coalesceTenantLedgerPositions(ACCOUNT_A, ledgerFetcher);
    await coalesceCurrentWalletPositions(ACCOUNT_A, WALLET, currentFetcher);
    expect(ledgerFetcher).toHaveBeenCalledTimes(2);
    expect(currentFetcher).toHaveBeenCalledTimes(2);
  });

  it("shared-read keys are tenant-prefixed so tenant invalidation can never cross accounts", async () => {
    expect(tenantLedgerPositionsCacheKey(ACCOUNT_A)).toBe(
      `ledger-positions:${ACCOUNT_A}`
    );
    expect(currentWalletPositionsCacheKey(ACCOUNT_A, WALLET)).toBe(
      `current-positions:${ACCOUNT_A}:${WALLET.toLowerCase()}`
    );

    const fetcherA = vi.fn(async () => "a");
    const fetcherB = vi.fn(async () => "b");
    await coalesceTenantLedgerPositions(ACCOUNT_A, fetcherA);
    await coalesceTenantLedgerPositions(ACCOUNT_B, fetcherB);

    invalidateDashboardRouteCaches(ACCOUNT_A);

    await coalesceTenantLedgerPositions(ACCOUNT_A, fetcherA);
    await coalesceTenantLedgerPositions(ACCOUNT_B, fetcherB);
    expect(fetcherA).toHaveBeenCalledTimes(2);
    expect(fetcherB).toHaveBeenCalledTimes(1);
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

  it("balances TTL is meaningfully longer than the route-payload fresh window", () => {
    expect(WALLET_BALANCES_CACHE_TTL_MS).toBe(30_000);
    expect(WALLET_BALANCES_CACHE_TTL_MS).toBeGreaterThan(
      DASHBOARD_ROUTE_CACHE_FRESH_MS
    );
  });

  it("a warm successful read never re-hits RPC inside 30s", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => okBalances);

    const first = await coalesceWalletBalances(ACCOUNT_A, fetcher);
    vi.advanceTimersByTime(WALLET_BALANCES_CACHE_TTL_MS - 1_000);
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

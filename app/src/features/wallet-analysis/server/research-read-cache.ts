// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/research-read-cache`
 * Purpose: Serve-stale-while-revalidate wrappers for the four research reads
 *   (snapshot, copy-target benchmark, target overlap, trader comparison).
 *   Originally shipped as the INTERIM mitigation for 25-31s full-history
 *   aggregations (prod 2026-09-28, build 08cedd2); since
 *   task.research-rollup-read-models moved those reads onto
 *   `poly_trader_fill_rollups_daily`, these are cheap-hit caches over fast
 *   queries — kept because request coalescing + SWR still absorb refresh
 *   bursts for free.
 * Scope: Thin caching seam between routes/prewarm and the underlying services.
 *   Owns cache keys + freshness policy only; no SQL, no HTTP.
 * Invariants:
 *   - STALENESS_ACCEPTED: these are research aggregates over observed history —
 *     5min fresh / 60min serve-stale is acceptable by design and documented on
 *     each consuming route.
 *   - DEGRADED_NOT_PINNED: `{kind:"warn"}` slice results are served but never
 *     cached (`shouldCache`), so a transient DB failure is retried on the next
 *     request instead of being pinned for an hour. Per-wallet comparison
 *     results carrying a `wallet_budget_exceeded` warning follow the same rule
 *     (`comparisonWalletIsCacheable`) — a budget-degraded wallet must not be
 *     SWR-pinned by prewarm or a cold request; same pattern as
 *     BALANCES_DEGRADED_NOT_CACHED in dashboard-route-cache.ts.
 *   - KEYS_COVER_ALL_INPUTS: every input that changes the computed payload is
 *     in the key — benchmark includes the per-user comparison wallet, the
 *     comparison-wallet key is (wallet, interval). Labels are deliberately
 *     EXCLUDED: they are request-time presentation re-stamped at assembly
 *     (LABELS_ARE_PRESENTATION in trader-comparison-service), never an input
 *     to the compute.
 *   - COMPARISON_PER_WALLET_CACHE (fix/comparison-per-wallet-cache): the
 *     trader-comparison cache unit is ONE wallet's aggregate, keyed
 *     `research:comparison-wallet:{addr}:{interval}`. The old whole-response
 *     key (interval + ordered wallet+label list) meant every distinct
 *     user/label combination recomputed the two expensive fixed targets from
 *     scratch and the prewarm's key never matched a real page key. Now any
 *     user's page = 2 prewarmed targets + their own (small) wallet. The
 *     whole-response SWR layer is REMOVED, not layered under: assembly is
 *     O(3) object spreads, and a second cache tier would stack staleness
 *     windows and reintroduce the key-fragmentation this fix deletes.
 *     Invalidation: TTL only — observed-history aggregates, 5min staleness
 *     acceptable by design (STALENESS_ACCEPTED); no write path mutates the
 *     underlying facts synchronously, so there is nothing to evict on.
 *   - CHEAP_HIT_CACHE (task.research-rollup-read-models): the underlying
 *     services are rollup-backed and fast; this layer is retained for
 *     request coalescing + burst absorption, not as the latency fix. Safe to
 *     shrink TTLs or delete once candidate timings confirm sub-second reads.
 * Side-effects: none of its own (delegates to `coalesce.ts` module-scope Map).
 * Links: src/features/wallet-analysis/server/coalesce.ts,
 *   src/bootstrap/jobs/research-prewarm.job.ts, work/items/bug.5012
 * @public
 */

import type {
  PolyResearchTargetOverlapResponse,
  PolyResearchTraderComparisonResponse,
  PolyWalletOverviewInterval,
  WalletAnalysisBenchmark,
  WalletAnalysisSnapshot,
} from "@cogni/poly-node-contracts";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { serverEnv } from "@/shared/env/server-env";
import { coalesceSwr } from "./coalesce";
import { getBenchmarkSlice } from "./copy-target-benchmark-service";
import { getTargetOverlapSlice } from "./target-overlap-service";
import {
  assembleTraderComparison,
  computeTraderComparisonWallet,
  TRADER_COMPARISON_BUDGET_WARNING_CODE,
  type TraderComparisonInput,
  type TraderComparisonWalletResult,
} from "./trader-comparison-service";
import {
  getSnapshotSlice,
  type SliceResult,
} from "./wallet-analysis-service";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

/** Fresh window: a hit younger than this recomputes nothing. */
export const RESEARCH_READ_FRESH_MS = 5 * 60 * 1000;
/** Serve-stale horizon: hits up to this age serve instantly + refresh in background. */
export const RESEARCH_READ_STALE_MS = 60 * 60 * 1000;

const sliceIsOk = <T>(result: SliceResult<T>): boolean => result.kind === "ok";

export function snapshotCacheKey(addr: string): string {
  return `research:snapshot:${addr.toLowerCase()}`;
}

export function benchmarkCacheKey(
  addr: string,
  interval: PolyWalletOverviewInterval,
  comparisonWalletAddress: string | null | undefined
): string {
  return `research:benchmark:${addr.toLowerCase()}:${interval}:${
    comparisonWalletAddress?.toLowerCase() ?? "none"
  }`;
}

export function targetOverlapCacheKey(
  interval: PolyWalletOverviewInterval
): string {
  return `research:target-overlap:${interval}`;
}

export function comparisonWalletCacheKey(
  addr: string,
  interval: PolyWalletOverviewInterval
): string {
  // NO label component on purpose (LABELS_ARE_PRESENTATION): labels only
  // affect the response's `label` field and are re-stamped at assembly, so
  // every requester — and the prewarm job — shares one compute per
  // (wallet, interval).
  return `research:comparison-wallet:${addr.toLowerCase()}:${interval}`;
}

/**
 * SWR-cached `getSnapshotSlice`. Keyed per wallet only — the snapshot
 * aggregate has no interval input, so fragmenting the key by interval would
 * just multiply 26s cold computes.
 */
export async function getSnapshotSliceCached(
  db: Db,
  addr: string
): Promise<SliceResult<WalletAnalysisSnapshot>> {
  return coalesceSwr(snapshotCacheKey(addr), () => getSnapshotSlice(db, addr), {
    freshMs: RESEARCH_READ_FRESH_MS,
    staleMs: RESEARCH_READ_STALE_MS,
    shouldCache: sliceIsOk,
  });
}

/** SWR-cached `getBenchmarkSlice`, keyed per (wallet, interval, comparison wallet). */
export async function getBenchmarkSliceCached(
  db: Db,
  addr: string,
  interval: PolyWalletOverviewInterval,
  opts: { comparisonWalletAddress?: string | null } = {}
): Promise<SliceResult<WalletAnalysisBenchmark>> {
  return coalesceSwr(
    benchmarkCacheKey(addr, interval, opts.comparisonWalletAddress),
    () => getBenchmarkSlice(db, addr, interval, opts),
    {
      freshMs: RESEARCH_READ_FRESH_MS,
      staleMs: RESEARCH_READ_STALE_MS,
      shouldCache: sliceIsOk,
    }
  );
}

/** SWR-cached `getTargetOverlapSlice`, keyed per interval (wallet pair is fixed). */
export async function getTargetOverlapSliceCached(
  db: Db,
  interval: PolyWalletOverviewInterval
): Promise<PolyResearchTargetOverlapResponse> {
  return coalesceSwr(
    targetOverlapCacheKey(interval),
    () => getTargetOverlapSlice(db, interval),
    { freshMs: RESEARCH_READ_FRESH_MS, staleMs: RESEARCH_READ_STALE_MS }
  );
}

/**
 * DEGRADED_NOT_PINNED gate at the per-wallet layer (keeps the whole-response
 * rule from fix/comparison-flows-pushdown): cache a wallet's result only when
 * it beat the budget. A `wallet_budget_exceeded` result is still served
 * (assembled into the partial-failure-200) but evicted immediately, so the
 * next request retries that wallet instead of its degraded slot being pinned
 * fresh for 5min and served stale for an hour. Non-budget warnings (e.g.
 * `pnl_unavailable`) do not block caching — unchanged from the old layer.
 * Exported for unit tests.
 */
export function comparisonWalletIsCacheable(
  result: TraderComparisonWalletResult
): boolean {
  return result.warnings.every(
    (warning) => warning.code !== TRADER_COMPARISON_BUDGET_WARNING_CODE
  );
}

/**
 * SWR-cached per-wallet comparison aggregate, keyed per (wallet, interval) —
 * the COMPARISON_PER_WALLET_CACHE unit. Applies the env-tunable per-wallet
 * time budget (`POLY_RESEARCH_WALLET_BUDGET_MS`) so a slow wallet degrades to
 * a warning result instead of an edge 520; budget-degraded results are served
 * but never cached (`comparisonWalletIsCacheable`, DEGRADED_NOT_PINNED) — on
 * a background refresh the prior complete value is kept instead.
 */
export async function getComparisonWalletCached(
  db: Db,
  address: string,
  interval: PolyWalletOverviewInterval
): Promise<TraderComparisonWalletResult> {
  return coalesceSwr(
    comparisonWalletCacheKey(address, interval),
    () =>
      computeTraderComparisonWallet(db, address, interval, {
        perWalletBudgetMs: serverEnv().POLY_RESEARCH_WALLET_BUDGET_MS,
      }),
    {
      freshMs: RESEARCH_READ_FRESH_MS,
      staleMs: RESEARCH_READ_STALE_MS,
      shouldCache: comparisonWalletIsCacheable,
    }
  );
}

/**
 * The route's comparison read: fans out to the per-wallet SWR cache and
 * assembles the response (cheap — label re-stamp + warning merge). There is
 * deliberately NO whole-response cache in front of this
 * (COMPARISON_PER_WALLET_CACHE): concurrent identical page loads still
 * coalesce per wallet key, and the response `capturedAt` is the oldest
 * contributing wallet's compute time.
 */
export async function getTraderComparisonCached(
  db: Db,
  wallets: readonly TraderComparisonInput[],
  interval: PolyWalletOverviewInterval
): Promise<PolyResearchTraderComparisonResponse> {
  const inputs = wallets.slice(0, 3);
  const results = await Promise.all(
    inputs.map((wallet) =>
      getComparisonWalletCached(db, wallet.address, interval)
    )
  );
  return assembleTraderComparison(interval, inputs, results);
}

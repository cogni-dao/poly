// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/adapters/polymarket/polymarket.data-api.client`
 * Purpose: Client for the public Polymarket Data API + Gamma handle resolver — leaderboard, user activity / trades / positions / value, market holders + trades, username search.
 * Scope: HTTP fetch + Zod validation. Does not load env, does not manage credentials, does not place orders, does not implement `MarketProviderPort`.
 * Invariants: PACKAGES_NO_ENV, READ_ONLY, CONTRACT_IS_SOT, PROCESS_WIDE_RATE_GATE (the 429 cooldown and the in-flight cap are module-scoped on purpose — Polymarket limits per-IP and the app builds one client per consumer; both honour the caller's AbortSignal).
 * Side-effects: IO (HTTP fetch to https://data-api.polymarket.com and https://gamma-api.polymarket.com), mutates the module-scoped cooldown + in-flight counters
 * Links: work/items/task.0315.poly-copy-trade-prototype.md, work/items/task.0386.poly-agent-wallet-research-v0.md, docs/research/poly-copy-trading-wallets.md
 * @public
 */

import type { ZodIssue, ZodTypeAny, z } from "zod";
import {
  type ActivityEvent,
  ActivityEventsResponseSchema,
  type ActivityEventType,
  type GammaProfile,
  GammaPublicSearchResponseSchema,
  type MarketHolder,
  MarketHoldersResponseSchema,
  type MarketTrade,
  MarketTradesResponseSchema,
  type PolymarketLeaderboardEntry,
  type PolymarketLeaderboardOrderBy,
  PolymarketLeaderboardResponseSchema,
  type PolymarketLeaderboardTimePeriod,
  type PolymarketUserPosition,
  PolymarketUserPositionsResponseSchema,
  type PolymarketUserTrade,
  PolymarketUserTradesResponseSchema,
  UserValueResponseSchema,
} from "./polymarket.data-api.types.js";

/**
 * Thrown when a Data API response fails Zod validation at the client boundary.
 * Stable envelope so downstream agents can catch schema drift distinctly from HTTP failures.
 */
/**
 * PROCESS_WIDE_429_COOLDOWN (bug.5284) — module-scoped, deliberately NOT a
 * class field.
 *
 * Polymarket rate-limits by IP/account, so the budget is shared by the whole
 * PROCESS. But the app constructs SEVEN-PLUS independent
 * `PolymarketDataApiClient` instances (container, redeem-pipeline, trade
 * executor x2, wallet refresh route, redeem route, top-wallet-stats job…), so
 * per-instance state cannot see the limit the other six just tripped.
 *
 * Prod evidence: after the per-job breakers for wallet-watch (bug.5276) and
 * top-wallet-stats (bug.5283) shipped, `/trades` 429s continued from a THIRD
 * caller — `trader-observation` — because each job only throttles itself.
 * Measured 0.62/min across 2 components. Per-job fixes cannot converge; one
 * shared gate can.
 *
 * Fail-fast during cooldown is the point: the request would 429 anyway, so
 * skipping it costs the caller nothing and stops us spending a third party's
 * budget to be told "no" again. Every current caller already treats Data-API
 * errors as best-effort.
 */
let cooldownUntilMs = 0;

/**
 * PROCESS_WIDE_INFLIGHT_CAP (bug.5286) — the cooldown alone guards the wrong
 * moment, and prod proved it.
 *
 * Post-deploy 429 timestamps on 08cedd2 arrive in SAME-MILLISECOND clusters
 * separated by long gaps:
 *   18:43:19.656 / 18:43:19.666      (gap 0.0s)
 *   18:45:46.102 / .105 / .107       (gap 0.0s, 146s after the previous cluster)
 *   18:55:42.186 / .187 / .201       (gap 0.0s, 452s later)
 * `cooldown active` fired 17 times, so the gate works — but a cooldown is
 * check-then-act: the concurrent requests are ALREADY IN FLIGHT when the first
 * 429 returns, so the whole herd fails together before `cooldownUntilMs` is
 * ever set. The gate closes after the herd is through, and its 5s window has
 * long expired by the time the next cluster arrives 90-450s later.
 *
 * A cooldown bounds the TAIL. Only an in-flight cap bounds the HEAD. This
 * semaphore is process-wide for the same reason the cooldown is: Polymarket
 * limits per-IP, and the app builds 7+ independent client instances.
 *
 * Not a replacement for per-job concurrency (`pLimit`) — those bound ONE job's
 * fan-out; nothing bounded the SUM across jobs, which is what upstream sees.
 */
const MAX_INFLIGHT = 2;
let inFlight = 0;
const waiters: Array<() => void> = [];

/**
 * ABORTABLE_QUEUE_WAIT (bug.5297) — the queue must observe the caller's signal.
 *
 * bug.5286 added the cap but awaited the queue with a bare promise, so an
 * aborted caller stayed parked until some unrelated request released a slot,
 * and then issued its request anyway. Two consequences, both observed as
 * `wallet_loop` hangs: the abandoned trader-observation tick cannot settle
 * (`settled_after_abort:false`, `tick_ms` ~= timeout + grace), and we spend a
 * third party's budget on a result nobody will read. The whole point of
 * threading `signal` through every fetch (task.5015) is defeated if the
 * limiter in front of those fetches ignores it.
 */
async function acquireSlot(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (inFlight < MAX_INFLIGHT) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const grant = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => {
      const index = waiters.indexOf(grant);
      // Still queued -> give up our place. Already shifted out -> releaseSlot()
      // has handed us the slot synchronously, so we must take it; rejecting
      // here would leak that slot for the life of the process.
      if (index === -1) return;
      waiters.splice(index, 1);
      // Plain Error: `fetchJson` rewraps this with the pathname, and the raw
      // `signal.reason` never reaches a caller.
      reject(new Error("aborted while queued for a Data API slot"));
    };
    waiters.push(grant);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function releaseSlot(): void {
  // SLOT_TRANSFER (bug.5286): hand the slot straight to the next waiter rather
  // than decrementing and letting the waiter re-increment. The decrement-then-
  // resolve order left `inFlight` one below the true count until the waiter's
  // continuation ran, and a fresh caller arriving in that window saw room and
  // claimed a third slot — the cap bug.5286 exists to enforce, breached by its
  // own release path.
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  inFlight -= 1;
}

/**
 * Test seam — drive the semaphore directly. The release-to-waiter handoff race
 * (bug.5286) lasts one microtask and cannot be hit deterministically through
 * the public client surface, so the invariant is asserted at this layer.
 */
export const __polyDataApiSlotsForTests = {
  acquire: (signal?: AbortSignal): Promise<void> => acquireSlot(signal),
  release: (): void => releaseSlot(),
};

/** Test seam — observe saturation without exporting the mutable counters. */
export function __polyDataApiInflightForTests(): {
  inFlight: number;
  queued: number;
} {
  return { inFlight, queued: waiters.length };
}

/** Fallback when the 429 carries no usable `Retry-After`. */
const DEFAULT_429_COOLDOWN_MS = 5_000;
/** Ceiling, so a hostile or malformed `Retry-After` cannot wedge reads. */
const MAX_429_COOLDOWN_MS = 30_000;

/** Thrown instead of issuing a call while the shared cooldown is active. */
export class PolyDataApiRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(pathname: string, retryAfterMs: number) {
    super(
      `Polymarket Data API rate-limit cooldown active; skipped ${pathname} (retry in ${retryAfterMs}ms)`
    );
    this.name = "PolyDataApiRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse `Retry-After` (delta-seconds only; HTTP-date is not used by this API). */
export function parseRetryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_429_COOLDOWN_MS;
  const seconds = Number.parseInt(header.trim(), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_429_COOLDOWN_MS;
  return Math.min(seconds * 1000, MAX_429_COOLDOWN_MS);
}

/** Test seam — reset the process-wide cooldown between cases. */
export function __resetPolyDataApiCooldownForTests(): void {
  cooldownUntilMs = 0;
  inFlight = 0;
  // Resolve rather than drop: a parked waiter silently removed from the queue
  // would never settle, hanging whichever test left it there.
  while (waiters.length > 0) waiters.shift()?.();
}

export class PolyDataApiValidationError extends Error {
  readonly code = "VALIDATION_FAILED" as const;
  constructor(
    readonly endpoint: string,
    readonly issues: ZodIssue[]
  ) {
    super(
      `Polymarket Data API response validation failed (${endpoint}): ${issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`
    );
    this.name = "PolyDataApiValidationError";
  }
}

function parseResponse<S extends ZodTypeAny>(
  schema: S,
  json: unknown,
  endpoint: string
): z.output<S> {
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new PolyDataApiValidationError(endpoint, result.error.issues);
  }
  return result.data;
}

const DEFAULT_DATA_API_BASE_URL = "https://data-api.polymarket.com";
const DEFAULT_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

export interface PolymarketDataApiClientConfig {
  /** Data API base URL (default: https://data-api.polymarket.com) */
  baseUrl?: string;
  /**
   * Gamma API base URL (default: https://gamma-api.polymarket.com).
   * Only used by `resolveUsername` — Gamma has a different host than the Data API.
   */
  gammaBaseUrl?: string;
  /** Optional fetch implementation for tests (default: global fetch). */
  fetch?: typeof fetch;
  /**
   * Hard timeout per request in milliseconds (default 5000).
   * Protects downstream callers (dashboards, scheduler jobs) from upstream stalls —
   * empirically the API returns in <300ms, so 5s is generous but bounds the worst case.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** `/positions` page ceiling enforced by the API (verified 2026-05). */
const LIST_ALL_POSITIONS_PAGE_SIZE = 500;
/** Hard upper bound on `listAllUserPositions` pages — defends against a server
 * that always returns a full page. 50 × 500 = 25k rows; well above the largest
 * funder we have observed (~150). */
const LIST_ALL_POSITIONS_MAX_PAGES = 50;

export interface ListTopTradersParams {
  /** Rolling time window honored by the API. `ALL` is all-time. */
  timePeriod?: PolymarketLeaderboardTimePeriod;
  /** Sort metric (default: PNL). */
  orderBy?: PolymarketLeaderboardOrderBy;
  /** Max rows (API caps at 50, default: 10). */
  limit?: number;
}

export interface ListUserActivityParams {
  /** Rows per page (API caps at ~500). Default: 100. */
  limit?: number;
  /** Optional offset for pagination. */
  offset?: number;
  /** Only return trades at or after this unix-seconds timestamp. */
  sinceTs?: number;
  /** Cooperative cancellation — aborts the underlying fetch (task.5015). */
  signal?: AbortSignal | undefined;
}

export interface ListUserTradesParams {
  /** Rows per page. Default: 20. Polymarket's `/trades` cache appears to serve a stale page at limits >20 (verified 2026-05-01: limit=1000 was 2min behind limit=20 for an active trader). Callers needing deeper history should paginate or accept staleness. */
  limit?: number;
  /** Optional offset for pagination. */
  offset?: number;
  /** Only return trades at or after this unix-seconds timestamp. */
  sinceTs?: number;
  /** When true, only include fills where the user was the TAKER. Default: false (includes maker fills — required for position tracking). */
  takerOnly?: boolean;
  /** Cooperative cancellation — aborts the underlying fetch (task.5015). */
  signal?: AbortSignal | undefined;
}

export interface ListUserPositionsParams {
  /** Optional conditionId filter. */
  market?: string;
  /** Optional minimum position size (USDC). */
  sizeThreshold?: number;
  /** Optional position cap. */
  limit?: number;
  /** Optional offset for pagination. */
  offset?: number;
  /** Cooperative cancellation — aborts the underlying fetch (task.5015). */
  signal?: AbortSignal | undefined;
}

export interface ListActivityParams {
  /** Filter by event type (TRADE/SPLIT/MERGE/REDEEM/REWARD/CONVERSION). */
  type?: ActivityEventType;
  /** Filter by side when type=TRADE. */
  side?: "BUY" | "SELL";
  /** Unix-seconds lower bound (inclusive). */
  start?: number;
  /** Unix-seconds upper bound (inclusive). */
  end?: number;
  /** Rows per page (1-500). */
  limit?: number;
  /** Pagination offset. */
  offset?: number;
}

export interface GetValueParams {
  /** Optional conditionId filter to restrict valuation to a single market. */
  market?: string;
}

export interface GetHoldersParams {
  /** Max holders to return (1-100). */
  limit?: number;
}

export interface ListMarketTradesParams {
  /** When true, only include trades where the `proxyWallet` was the taker. */
  takerOnly?: boolean;
  /** Rows per page (1-500). */
  limit?: number;
  /** Pagination offset. */
  offset?: number;
}

export interface ResolveUsernameParams {
  /** Max profile matches to return (1-20). */
  limit?: number;
}

/**
 * Polymarket Data API client.
 *
 * Endpoints:
 * - `GET /v1/leaderboard?timePeriod=DAY|WEEK|MONTH|ALL&orderBy=PNL|VOL&limit=<n>`
 * - `GET /trades?user=<wallet>&limit=<n>`
 * - `GET /positions?user=<wallet>&limit=<n>`
 *
 * All endpoints are public — no auth required.
 * Verified against live data 2026-04-17 (see research doc).
 *
 * Note: `/trades` defaults `takerOnly=true` server-side, hiding maker-side
 * fills. `listUserTrades` always sends the param explicitly and defaults to
 * `false` so position-tracking callers (mirror, audit) see every CTF-balance
 * change.

 */
export class PolymarketDataApiClient {
  private readonly baseUrl: string;
  private readonly gammaBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config?: PolymarketDataApiClientConfig) {
    this.baseUrl = config?.baseUrl ?? DEFAULT_DATA_API_BASE_URL;
    this.gammaBaseUrl = config?.gammaBaseUrl ?? DEFAULT_GAMMA_BASE_URL;
    this.fetchImpl = config?.fetch ?? fetch;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listTopTraders(
    params?: ListTopTradersParams
  ): Promise<PolymarketLeaderboardEntry[]> {
    const url = new URL("/v1/leaderboard", this.baseUrl);
    url.searchParams.set("timePeriod", params?.timePeriod ?? "WEEK");
    url.searchParams.set("orderBy", params?.orderBy ?? "PNL");
    url.searchParams.set("limit", String(params?.limit ?? 10));

    const json = await this.fetchJson(url);
    return PolymarketLeaderboardResponseSchema.parse(json);
  }

  async listUserActivity(
    wallet: string,
    params?: ListUserActivityParams
  ): Promise<PolymarketUserTrade[]> {
    return this.listUserTrades(wallet, params);
  }

  async listUserTrades(
    wallet: string,
    params?: ListUserTradesParams
  ): Promise<PolymarketUserTrade[]> {
    assertWallet(wallet);
    const url = new URL("/trades", this.baseUrl);
    url.searchParams.set("user", wallet);
    url.searchParams.set("limit", String(params?.limit ?? 20));
    url.searchParams.set(
      "takerOnly",
      params?.takerOnly === true ? "true" : "false"
    );
    if (params?.offset !== undefined) {
      url.searchParams.set("offset", String(params.offset));
    }

    const json = await this.fetchJson(url, params?.signal);
    const trades = PolymarketUserTradesResponseSchema.parse(json);

    if (params?.sinceTs !== undefined) {
      const since = params.sinceTs;
      return trades.filter((t) => t.timestamp > since);
    }
    return trades;
  }

  async listUserPositions(
    wallet: string,
    params?: ListUserPositionsParams
  ): Promise<PolymarketUserPosition[]> {
    assertWallet(wallet);
    const url = new URL("/positions", this.baseUrl);
    url.searchParams.set("user", wallet);
    if (params?.market) url.searchParams.set("market", params.market);
    if (params?.sizeThreshold !== undefined) {
      url.searchParams.set("sizeThreshold", String(params.sizeThreshold));
    }
    if (params?.limit !== undefined) {
      url.searchParams.set("limit", String(params.limit));
    }
    if (params?.offset !== undefined) {
      url.searchParams.set("offset", String(params.offset));
    }

    const json = await this.fetchJson(url, params?.signal);
    return PolymarketUserPositionsResponseSchema.parse(json);
  }

  /**
   * Walk every page of `/positions` for `wallet` and return the concatenated
   * result. The single-call `listUserPositions` silently caps at ~100 rows
   * (Polymarket's default page); callers that need full enumeration (boot
   * backfill, recovery sweeps) must paginate or they will miss everything
   * past page 1 (bug.5027).
   *
   * Pages at `LIST_ALL_POSITIONS_PAGE_SIZE` (500, the API ceiling) and stops
   * when a page returns fewer rows than requested. Hard-bounded to
   * `LIST_ALL_POSITIONS_MAX_PAGES` to defend against a misbehaving server
   * that always returns full pages.
   *
   * Defaults `sizeThreshold: 0` so sub-dollar positions are included. The
   * Polymarket API silently omits them otherwise, which left winner positions
   * with `currentValue < ~$1` invisible to the redeem-diff input set — the
   * redeem pipeline never saw them and never enqueued. Callers that want the
   * stricter default (research/screening) override via `baseParams`.
   */
  async listAllUserPositions(
    wallet: string,
    baseParams?: Omit<ListUserPositionsParams, "limit" | "offset">
  ): Promise<PolymarketUserPosition[]> {
    const all: PolymarketUserPosition[] = [];
    for (let page = 0; page < LIST_ALL_POSITIONS_MAX_PAGES; page += 1) {
      const rows = await this.listUserPositions(wallet, {
        sizeThreshold: 0,
        ...baseParams,
        limit: LIST_ALL_POSITIONS_PAGE_SIZE,
        offset: page * LIST_ALL_POSITIONS_PAGE_SIZE,
      });
      all.push(...rows);
      if (rows.length < LIST_ALL_POSITIONS_PAGE_SIZE) return all;
    }
    return all;
  }

  /**
   * `GET /activity?user=<wallet>` — lifecycle events (TRADE/SPLIT/MERGE/REDEEM/...).
   * Distinct from `/trades`; do not delegate.
   */
  async listActivity(
    wallet: string,
    params?: ListActivityParams
  ): Promise<ActivityEvent[]> {
    assertWallet(wallet);
    const url = new URL("/activity", this.baseUrl);
    url.searchParams.set("user", wallet);
    if (params?.type) url.searchParams.set("type", params.type);
    if (params?.side) url.searchParams.set("side", params.side);
    if (params?.start !== undefined) {
      url.searchParams.set("start", String(params.start));
    }
    if (params?.end !== undefined) {
      url.searchParams.set("end", String(params.end));
    }
    if (params?.limit !== undefined) {
      url.searchParams.set("limit", String(params.limit));
    }
    if (params?.offset !== undefined) {
      url.searchParams.set("offset", String(params.offset));
    }

    const json = await this.fetchJson(url);
    return parseResponse(ActivityEventsResponseSchema, json, "/activity");
  }

  /**
   * `GET /value?user=<wallet>` — cheap wallet-value probe.
   * Returns the first entry; endpoint is `[{ user, value }]`.
   */
  async getValue(
    wallet: string,
    params?: GetValueParams
  ): Promise<{ user: string; value: number }> {
    assertWallet(wallet);
    const url = new URL("/value", this.baseUrl);
    url.searchParams.set("user", wallet);
    if (params?.market) url.searchParams.set("market", params.market);

    const json = await this.fetchJson(url);
    const entries = parseResponse(UserValueResponseSchema, json, "/value");
    const first = entries[0];
    if (!first) {
      return { user: wallet, value: 0 };
    }
    return { user: first.user, value: first.value };
  }

  /**
   * `GET /holders?market=<conditionId>` — current shareholders on a market.
   * Hidden-gem discovery input for wallet research.
   */
  async getHolders(
    market: string,
    params?: GetHoldersParams
  ): Promise<MarketHolder[]> {
    if (!market || typeof market !== "string") {
      throw new Error("getHolders: market (conditionId) is required");
    }
    const url = new URL("/holders", this.baseUrl);
    url.searchParams.set("market", market);
    if (params?.limit !== undefined) {
      url.searchParams.set("limit", String(params.limit));
    }

    const json = await this.fetchJson(url);
    return parseResponse(MarketHoldersResponseSchema, json, "/holders");
  }

  /**
   * `GET /trades?market=<conditionId>` — market-level trade stream.
   * Used for counterparty harvesting (NOT per-user history — see `listUserTrades`).
   */
  async listMarketTrades(
    market: string,
    params?: ListMarketTradesParams
  ): Promise<MarketTrade[]> {
    if (!market || typeof market !== "string") {
      throw new Error("listMarketTrades: market (conditionId) is required");
    }
    const url = new URL("/trades", this.baseUrl);
    url.searchParams.set("market", market);
    if (params?.takerOnly) url.searchParams.set("takerOnly", "true");
    if (params?.limit !== undefined) {
      url.searchParams.set("limit", String(params.limit));
    }
    if (params?.offset !== undefined) {
      url.searchParams.set("offset", String(params.offset));
    }

    const json = await this.fetchJson(url);
    return parseResponse(MarketTradesResponseSchema, json, "/trades?market=");
  }

  /**
   * Gamma `GET /public-search?q=<query>&profile=true` — handle → proxyWallet resolution.
   * Note: Gamma is a different host (`gamma-api.polymarket.com`) from the Data API.
   */
  async resolveUsername(
    query: string,
    params?: ResolveUsernameParams
  ): Promise<GammaProfile[]> {
    if (typeof query !== "string" || query.length < 2) {
      throw new Error("resolveUsername: query must be a string of ≥2 chars");
    }
    const url = new URL("/public-search", this.gammaBaseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("profile", "true");
    if (params?.limit !== undefined) {
      url.searchParams.set("limit", String(params.limit));
    }

    const json = await this.fetchJson(url);
    const parsed = parseResponse(
      GammaPublicSearchResponseSchema,
      json,
      "gamma:/public-search"
    );
    return parsed.profiles;
  }

  /**
   * `signal` (task.5015): optional caller-owned cancellation, combined with
   * the per-request timeout controller. Caller aborts (e.g. the trader
   * observation tick timing out) reject distinctly from timeouts so callers
   * can classify them.
   */
  private async fetchJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    // bug.5284 — refuse to add load while upstream is still rate-limiting us.
    const remainingMs = cooldownUntilMs - Date.now();
    if (remainingMs > 0) {
      throw new PolyDataApiRateLimitedError(url.pathname, remainingMs);
    }
    // bug.5286 — bound concurrent in-flight requests across the whole process,
    // so a burst cannot all reach upstream before the first 429 comes back.
    try {
      await acquireSlot(signal);
    } catch (err) {
      // Only an abort rejects here; surface it in the same shape as a
      // mid-flight caller abort so callers classify it identically.
      if (signal?.aborted) {
        throw new Error(
          `Polymarket Data API request aborted by caller while queued (${url.pathname})`
        );
      }
      throw err;
    }
    // Re-check after queueing: a request that waited for a slot may find the
    // cooldown opened by whichever request was ahead of it. This is the check
    // the pre-queue test cannot make, and it is where the herd gets stopped.
    const afterWaitMs = cooldownUntilMs - Date.now();
    if (afterWaitMs > 0) {
      releaseSlot();
      throw new PolyDataApiRateLimitedError(url.pathname, afterWaitMs);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    // ALREADY_ABORTED_IS_NOT_A_LISTENER_EVENT (bug.5297): `addEventListener` on
    // an already-aborted signal never fires, which would leave this request
    // running to the full `timeoutMs` on a signal nobody will re-fire. Reachable
    // deterministically: a caller granted its slot in the same turn its signal
    // aborts takes the slot (rejecting there would leak it) and arrives here
    // already aborted.
    if (signal?.aborted) controller.abort();
    try {
      const response = await this.fetchImpl(url.toString(), {
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 429) {
          // Open the shared gate for EVERY client in this process, not just
          // this instance — the limit is per-IP, so the others are about to
          // hit the same wall.
          const waitMs = parseRetryAfterMs(
            response.headers?.get?.("retry-after") ?? null
          );
          cooldownUntilMs = Date.now() + waitMs;
        }
        throw new Error(
          `Polymarket Data API error: ${response.status} ${response.statusText} (${url.pathname})`
        );
      }
      return await response.json();
    } catch (err) {
      if (signal?.aborted) {
        throw new Error(
          `Polymarket Data API request aborted by caller (${url.pathname})`
        );
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Polymarket Data API timeout after ${this.timeoutMs}ms (${url.pathname})`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
      releaseSlot();
    }
  }
}

function assertWallet(wallet: string): void {
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    throw new Error(`Invalid wallet address: ${wallet}`);
  }
}

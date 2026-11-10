// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/adapters/polymarket/polymarket.data-api.client`
 * Purpose: Client for the public Polymarket Data API v2 + Gamma handle resolver — leaderboard, user activity / trades / positions / value, market holders + trades, username search. v1 is retired upstream (410); every read here is `/v2/*`.
 * Scope: HTTP fetch + Zod validation. Does not load env, does not manage credentials, does not place orders, does not implement `MarketProviderPort`.
 * Invariants: PACKAGES_NO_ENV, READ_ONLY, CONTRACT_IS_SOT, PROCESS_WIDE_RATE_GATE (the 429 cooldown and the in-flight cap are module-scoped on purpose — Polymarket limits per-IP and the app builds one client per consumer; both honour the caller's AbortSignal).
 * Side-effects: IO (HTTP fetch to https://data-api.polymarket.com and https://gamma-api.polymarket.com), mutates the module-scoped cooldown + in-flight counters
 * Links: work/items/task.0315.poly-copy-trade-prototype.md, work/items/task.0386.poly-agent-wallet-research-v0.md, docs/research/poly-copy-trading-wallets.md
 * @public
 */

import type { ZodIssue, ZodTypeAny, z } from "zod";
import {
  type ActivityEvent,
  type ActivityEventType,
  type DataApiPage,
  type GammaProfile,
  GammaPublicSearchResponseSchema,
  GammaTokenMarketsResponseSchema,
  type MarketHolder,
  type PolymarketLeaderboardEntry,
  type PolymarketLeaderboardOrderBy,
  type PolymarketLeaderboardTimePeriod,
  type PolymarketUserPosition,
  PolymarketUserPositionSchema,
  type PolymarketUserTrade,
} from "./polymarket.data-api.types.js";
import {
  PolymarketActivityV2ResponseSchema,
  type PolymarketActivityV2,
  PolymarketDataApiStatusV2Schema,
  type PolymarketDataApiStatusV2,
  PolymarketHoldersV2ResponseSchema,
  PolymarketLeaderboardV2ResponseSchema,
  PolymarketPagedRowsV2Schema,
  PolymarketPositionIdentityV2Schema,
  PolymarketTradeIdentityV2Schema,
  type PolymarketTradeV2,
  PolymarketTradeV2Schema,
  type PolymarketUserPositionV2,
  PolymarketUserPositionV2Schema,
  PolymarketValueV2ResponseSchema,
} from "./polymarket.data-api-v2.types.js";

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
  readonly status = 429;
  readonly retryable = false;
  readonly retryAfterMs: number;
  constructor(pathname: string, retryAfterMs: number, message?: string) {
    super(
      message ??
        `Polymarket Data API rate-limit cooldown active; skipped ${pathname} (retry in ${retryAfterMs}ms)`
    );
    this.name = "PolyDataApiRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Additive classification; consumers choose policy, this client never retries. */
export class PolyDataApiRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = "PolyDataApiRequestError";
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

/** One row dropped by per-row validation (never an identity failure). */
export interface PolyDataApiRowRejection {
  endpoint: string;
  /** `path: message` of the first zod issue. */
  reason: string;
  /** Running process-wide total of rejected rows. */
  totalRejected: number;
}

let rejectedRowsTotal = 0;
let rowRejectionSink: ((rejection: PolyDataApiRowRejection) => void) | undefined;

/** Install the process-wide sink (the app logs a counted warn). */
export function setPolyDataApiRowRejectionSink(
  sink: ((rejection: PolyDataApiRowRejection) => void) | undefined
): void {
  rowRejectionSink = sink;
}

/**
 * Validate a cursor-paged envelope row by row. A row failing `identity`
 * (token / condition / wallet / outcome_index) fails the whole page closed; a
 * row failing only on other fields is dropped, counted and reported, so one
 * dust row with an odd number cannot blind a tenant.
 */
function parsePagedRows<S extends ZodTypeAny>(
  rowSchema: S,
  identity: ZodTypeAny,
  json: unknown,
  endpoint: string
): {
  data: Array<z.output<S>>;
  pagination: z.output<typeof PolymarketPagedRowsV2Schema>["pagination"];
} {
  const envelope = parseResponse(PolymarketPagedRowsV2Schema, json, endpoint);
  const data: Array<z.output<S>> = [];
  for (const row of envelope.data) {
    const parsed = rowSchema.safeParse(row);
    if (parsed.success) {
      data.push(parsed.data);
      continue;
    }
    const idResult = identity.safeParse(row);
    if (!idResult.success) {
      throw new PolyDataApiValidationError(endpoint, idResult.error.issues);
    }
    rejectedRowsTotal += 1;
    const issue = parsed.error.issues[0];
    rowRejectionSink?.({
      endpoint,
      reason: `${issue?.path.join(".") || "<root>"}: ${issue?.message ?? "invalid"}`,
      totalRejected: rejectedRowsTotal,
    });
  }
  return { data, pagination: envelope.pagination };
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

/** Exact, unambiguous Gamma identity for one CLOB token. */
export interface PolymarketTokenMetadata {
  conditionId: string;
  outcome: string;
  endDate: string | null;
  title: string | null;
  slug: string | null;
}

const DEFAULT_TIMEOUT_MS = 5000;

const POSITIONS_V2_CONDITION_CHUNK_SIZE = 20;
const POSITIONS_V2_MAX_CURSOR_PAGES = 100;
const POSITIONS_V2_PAGE_SIZE = 1000;
const CONDITION_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface ListTopTradersParams {
  /** Rolling time window honored by the API. `ALL` is all-time. */
  timePeriod?: PolymarketLeaderboardTimePeriod;
  /** Sort metric (default: PNL). */
  orderBy?: PolymarketLeaderboardOrderBy;
  /** Max rows of the first page (default: 10, API ceiling 1000). */
  limit?: number;
}

export interface ListUserTradesParams {
  /** Rows per page (default 20, API ceiling 1000). */
  limit?: number;
  /**
   * Max cursor pages to read (default 1). The walk also ends when the feed is
   * exhausted; `sinceTs` bounds the window server-side.
   */
  maxPages?: number;
  /** Only return trades strictly after this unix-seconds timestamp (also sent as the window `start`). */
  sinceTs?: number;
  /** When true, only include fills where the user was the TAKER. Default: false (includes maker fills — required for position tracking). */
  takerOnly?: boolean;
  /** Cooperative cancellation — aborts the underlying fetch (task.5015). */
  signal?: AbortSignal | undefined;
}

export interface ListUserPositionsParams {
  /** Optional exact conditionId filter. */
  market?: string;
  /** Minimum CURRENT holding in shares. Omitted: the API's 0.1 dust floor. */
  sizeThreshold?: number;
  /**
   * Minimum current value in USDC (`filter_type=CASH`); wins over
   * `sizeThreshold`. A positive floor returns only value-bearing rows, which
   * keeps a 39k-row book to a few hundred rows.
   */
  minValueUsdc?: number;
  /** Rows per first page (API ceiling 1000). Ignored once `cursor` is set. */
  limit?: number;
  /** Opaque `nextCursor` from the previous page. Re-send every other filter unchanged. */
  cursor?: string;
  /** Cooperative cancellation — aborts the underlying fetch (task.5015). */
  signal?: AbortSignal | undefined;
}

export interface ListUserPositionsV2Params {
  /** Exact condition cohort. The client deduplicates and chunks at 20. */
  conditions: readonly string[];
  /** Include user-archived rows. Defaults true for OPEN and false for CLOSED. */
  includeArchived?: boolean;
  /** Historical recovery opts into CLOSED; existing target readers remain OPEN. */
  status?: "OPEN" | "CLOSED";
  /** Aggregate request ceiling across all chunks and cursor pages. */
  maxRequests?: number;
  signal?: AbortSignal | undefined;
}

export interface PolymarketPositionsV2Walk {
  positions: PolymarketUserPositionV2[];
  requestCount: number;
}

export type PolyDataApiPositionsV2FailureReason =
  | "incomplete"
  | "malformed"
  | "request_budget";

/** Stable failure for a semantically invalid or incomplete V2 cursor walk. */
export class PolyDataApiPositionsV2Error extends Error {
  readonly code = "INVALID_V2_POSITIONS_WALK" as const;
  constructor(
    message: string,
    readonly reason: PolyDataApiPositionsV2FailureReason = "malformed"
  ) {
    super(`Polymarket Data API V2 positions walk rejected: ${message}`);
    this.name = "PolyDataApiPositionsV2Error";
  }
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
  /** Rows per first page (API ceiling 1000). Ignored once `cursor` is set. */
  limit?: number;
  /** Opaque `nextCursor` from the previous page. Re-send every other filter unchanged. */
  cursor?: string;
  signal?: AbortSignal | undefined;
}

export interface GetValueParams {
  /** Optional exact conditionId filter to restrict valuation to a single market. */
  market?: string;
}

export interface GetHoldersParams {
  /** Max holders per outcome token (API ceiling 1000). */
  limit?: number;
}

export interface ListMarketTradesParams {
  /** Default true (each fill once, on its taker side); false includes maker rows. */
  takerOnly?: boolean;
  /** Rows per first page (API ceiling 1000). Ignored once `cursor` is set. */
  limit?: number;
  /** Opaque `nextCursor` from the previous page. Re-send every other filter unchanged. */
  cursor?: string;
}

export interface ResolveUsernameParams {
  /** Max profile matches to return (1-20). */
  limit?: number;
}

/**
 * Polymarket Data API v2 client. Every read maps the snake_case `/v2/*` wire
 * rows onto the camelCase domain types at this boundary.
 *
 * Endpoints: `/v2/leaderboard`, `/v2/trades`, `/v2/positions`, `/v2/activity`,
 * `/v2/value`, `/v2/holders`, `/v2/status`.
 *
 * All endpoints are public — no auth required. Pagination is cursor-only
 * (`pagination.next_cursor`); an `offset` param is a 400 upstream.
 *
 * Note: `/v2/trades` defaults `taker_only=true` server-side, hiding maker-side
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
    const url = v2Url(this.baseUrl, "/v2/leaderboard", {
      time_period: (params?.timePeriod ?? "WEEK").toLowerCase(),
      sort_by: (params?.orderBy ?? "PNL") === "VOL" ? "VOLUME" : "PNL",
      limit: params?.limit ?? 10,
    });
    const response = parseResponse(
      PolymarketLeaderboardV2ResponseSchema,
      await this.fetchJson(url),
      "/v2/leaderboard"
    );
    return response.data.map((row) => ({
      rank: String(row.rank),
      proxyWallet: row.user_id,
      userName: row.user_name ?? "",
      xUsername: row.x_username ?? "",
      verifiedBadge: row.verified ?? false,
      vol: row.volume,
      pnl: row.pnl,
      profileImage: row.profile_image ?? "",
    }));
  }

  /** Data API's own serving/ingestion freshness evidence. */
  async getStatusV2(params?: {
    signal?: AbortSignal | undefined;
  }): Promise<PolymarketDataApiStatusV2> {
    const url = new URL("/v2/status", this.baseUrl);
    const json = await this.fetchJson(url, params?.signal);
    return parseResponse(
      PolymarketDataApiStatusV2Schema,
      json,
      "/v2/status"
    ).data;
  }

  /**
   * `GET /v2/trades?user=<wallet>` — the wallet's trade feed, newest first,
   * walked by cursor for up to `maxPages` pages.
   */
  async listUserTrades(
    wallet: string,
    params?: ListUserTradesParams
  ): Promise<PolymarketUserTrade[]> {
    assertWallet(wallet);
    const maxPages = Math.max(1, params?.maxPages ?? 1);
    const since = params?.sinceTs;
    const trades: PolymarketUserTrade[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      params?.signal?.throwIfAborted();
      // Cursor pages keep only the seek anchor: resend every filter each page.
      const url = v2Url(this.baseUrl, "/v2/trades", {
        user: wallet,
        taker_only: params?.takerOnly === true,
        start: since,
        ...pageWindow(cursor, params?.limit ?? 20),
      });
      const response = parsePagedRows(
        PolymarketTradeV2Schema,
        PolymarketTradeIdentityV2Schema,
        await this.fetchJson(url, params?.signal),
        "/v2/trades"
      );
      trades.push(...response.data.map(toUserTrade));
      const next = response.pagination.next_cursor;
      if (next === null) break;
      cursor = next;
    }
    return since === undefined
      ? trades
      : trades.filter((trade) => trade.timestamp > since);
  }

  /**
   * One cursor page of `GET /v2/positions?user=<wallet>`. Full enumeration is
   * `listAllUserPositions`; this is for callers that budget each request.
   */
  async listUserPositions(
    wallet: string,
    params?: ListUserPositionsParams
  ): Promise<DataApiPage<PolymarketUserPosition>> {
    assertWallet(wallet);
    const url = v2Url(this.baseUrl, "/v2/positions", {
      user: wallet,
      condition: params?.market?.toLowerCase(),
      filter_type: params?.minValueUsdc === undefined ? "TOKENS" : "CASH",
      filter_amount: params?.minValueUsdc ?? params?.sizeThreshold,
      include_archived: true,
      ...pageWindow(params?.cursor, params?.limit),
    });
    const response = parsePagedRows(
      PolymarketUserPositionV2Schema,
      PolymarketPositionIdentityV2Schema,
      await this.fetchJson(url, params?.signal),
      "/v2/positions"
    );
    return {
      rows: response.data.map(normalizeV2Position),
      nextCursor: response.pagination.next_cursor,
    };
  }

  /**
   * Read a condition-scoped V2 position cohort. Any duplicate, out-of-scope,
   * malformed, or incomplete cursor walk rejects the whole call.
   */
  async listUserPositionsV2(
    wallet: string,
    params: ListUserPositionsV2Params
  ): Promise<PolymarketUserPosition[]> {
    const walk = await this.listUserPositionsV2Raw(wallet, params);
    return walk.positions.map(normalizeV2Position);
  }

  /** Cursor-complete raw rows for an exact condition cohort. */
  async listUserPositionsV2Raw(
    wallet: string,
    params: ListUserPositionsV2Params
  ): Promise<PolymarketPositionsV2Walk> {
    const status = params.status ?? "OPEN";
    return this.walkUserPositionsV2(wallet, {
      conditions: params.conditions,
      status,
      includeArchived: params.includeArchived ?? status !== "CLOSED",
      filterType: "TOKENS",
      filterAmount: 0,
      maxRequests: params.maxRequests ?? POSITIONS_V2_MAX_CURSOR_PAGES,
      signal: params.signal,
    });
  }

  /**
   * Cheap positive-value discovery for complete target-book hydration.
   * The returned cohort is structurally OPEN and never treats endDate as a
   * lifecycle signal.
   */
  async listPositiveOpenUserPositionsV2(
    wallet: string,
    params?: { signal?: AbortSignal | undefined }
  ): Promise<PolymarketPositionsV2Walk> {
    const walk = await this.walkUserPositionsV2(wallet, {
      filterType: "CASH",
      // One atomic USDC unit; written as a decimal (not 1e-7) because the
      // upstream query parser is not documented to accept exponent notation.
      filterAmount: 0.000001,
      includeArchived: false,
      maxRequests: 5,
      signal: params?.signal,
    });
    return {
      positions: walk.positions.filter(
        (row) =>
          row.status === "OPEN" &&
          row.redeemable !== true &&
          row.current_value > 0
      ),
      requestCount: walk.requestCount,
    };
  }

  /**
   * Every value-bearing position (`current_value > 0`, OPEN incl. redeemable)
   * in one cursor walk. Prefer this to `listAllUserPositions` on hot paths:
   * dust and worthless rows (tens of thousands on a whale target) are filtered
   * server-side.
   */
  async listPositiveValueUserPositions(
    wallet: string,
    params?: { signal?: AbortSignal | undefined }
  ): Promise<PolymarketUserPosition[]> {
    const walk = await this.walkUserPositionsV2(wallet, {
      filterType: "CASH",
      // One atomic USDC unit, as a decimal (see listPositiveOpenUserPositionsV2).
      filterAmount: 0.000001,
      includeArchived: true,
      maxRequests: 10,
      signal: params?.signal,
    });
    return walk.positions.map(normalizeV2Position);
  }

  /**
   * Cursor-complete enumeration of every position (OPEN incl. redeemable,
   * archived included, dust included).
   */
  async listAllUserPositions(
    wallet: string,
    params?: { signal?: AbortSignal | undefined }
  ): Promise<PolymarketUserPosition[]> {
    const walk = await this.walkUserPositionsV2(wallet, {
      filterType: "TOKENS",
      filterAmount: 0,
      includeArchived: true,
      maxRequests: POSITIONS_V2_MAX_CURSOR_PAGES,
      signal: params?.signal,
    });
    return walk.positions.map(normalizeV2Position);
  }

  private async walkUserPositionsV2(
    wallet: string,
    params: {
      conditions?: readonly string[];
      status?: "OPEN" | "CLOSED";
      filterType: "CASH" | "TOKENS";
      filterAmount: number;
      includeArchived: boolean;
      maxRequests: number;
      signal?: AbortSignal | undefined;
    }
  ): Promise<PolymarketPositionsV2Walk> {
    assertWallet(wallet);
    if (params.status === "CLOSED" && params.includeArchived) {
      throw new PolyDataApiPositionsV2Error(
        "includeArchived is unsupported for CLOSED positions"
      );
    }
    if (!Number.isInteger(params.maxRequests) || params.maxRequests <= 0) {
      throw new PolyDataApiPositionsV2Error(
        "request budget must be a positive integer",
        "request_budget"
      );
    }
    const conditions = params.conditions
      ? [...new Set(params.conditions.map((value) => value.toLowerCase()))]
      : null;
    if (conditions?.length === 0) {
      throw new PolyDataApiPositionsV2Error("at least one condition is required");
    }
    const malformedCondition = conditions?.find(
      (condition) => !CONDITION_ID_PATTERN.test(condition)
    );
    if (malformedCondition) {
      throw new PolyDataApiPositionsV2Error(
        `invalid condition id ${malformedCondition}`
      );
    }

    const raw = new Map<string, PolymarketUserPositionV2>();
    let requestCount = 0;
    const chunks = conditions
      ? Array.from(
          {
            length: Math.ceil(
              conditions.length / POSITIONS_V2_CONDITION_CHUNK_SIZE
            ),
          },
          (_, index) =>
            conditions.slice(
              index * POSITIONS_V2_CONDITION_CHUNK_SIZE,
              (index + 1) * POSITIONS_V2_CONDITION_CHUNK_SIZE
            )
        )
      : [null];
    for (const chunk of chunks) {
      const chunkSet = chunk ? new Set(chunk) : null;
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let complete = false;
      for (let page = 0; page < POSITIONS_V2_MAX_CURSOR_PAGES; page += 1) {
        params.signal?.throwIfAborted();
        if (requestCount >= params.maxRequests) {
          throw new PolyDataApiPositionsV2Error(
            `request budget ${params.maxRequests} exhausted before cursor completion`,
            "request_budget"
          );
        }
        const url = new URL("/v2/positions", this.baseUrl);
        url.searchParams.set("user", wallet);
        // Cursor pages do not retain the filter server-side; resend every time.
        if (chunk) url.searchParams.set("condition", chunk.join(","));
        url.searchParams.set("status", params.status ?? "OPEN");
        url.searchParams.set(
          "include_archived",
          params.includeArchived ? "true" : "false"
        );
        url.searchParams.set("filter_type", params.filterType);
        url.searchParams.set("filter_amount", String(params.filterAmount));
        if (cursor === null) {
          url.searchParams.set("limit", String(POSITIONS_V2_PAGE_SIZE));
        } else {
          url.searchParams.set("cursor", cursor);
        }

        const response = parsePagedRows(
          PolymarketUserPositionV2Schema,
          PolymarketPositionIdentityV2Schema,
          await this.fetchJson(url, params.signal),
          "/v2/positions"
        );
        requestCount += 1;
        for (const row of response.data) {
          // The documented OPEN result set includes settled-but-unredeemed
          // winners, whose rows echo REDEEMABLE. CLOSED can never belong to
          // this walk; reject it rather than silently publishing stale facts.
          if ((params.status === "CLOSED" && row.status !== "CLOSED") ||
            (params.status !== "CLOSED" && row.status !== "OPEN" && row.status !== "REDEEMABLE")) {
            throw new PolyDataApiPositionsV2Error(
              `response status ${row.status} was outside the requested ${params.status ?? "OPEN"} cohort`
            );
          }
          if (!params.includeArchived && row.archived === true) {
            throw new PolyDataApiPositionsV2Error(
              `response returned archived token ${row.token_id} outside the active cohort`
            );
          }
          const conditionId = row.condition_id.toLowerCase();
          if (chunkSet && !chunkSet.has(conditionId)) {
            throw new PolyDataApiPositionsV2Error(
              `response condition ${row.condition_id} was outside the requested cohort`
            );
          }
          if (row.proxy_wallet.toLowerCase() !== wallet.toLowerCase()) {
            throw new PolyDataApiPositionsV2Error(
              `response wallet ${row.proxy_wallet} did not match the requested wallet`
            );
          }
          // Keyset paging over a moving sort can return a row twice; the
          // later read is fresher, so last wins.
          raw.set(`${conditionId}\u0000${row.token_id}`, row);
        }

        const nextCursor = response.pagination.next_cursor;
        if (nextCursor === null) {
          complete = true;
          break;
        }
        if (seenCursors.has(nextCursor)) {
          throw new PolyDataApiPositionsV2Error("cursor cycle detected");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      if (!complete) {
        throw new PolyDataApiPositionsV2Error(
          `cursor walk exceeded ${POSITIONS_V2_MAX_CURSOR_PAGES} pages`,
          "incomplete"
        );
      }
    }
    return { positions: [...raw.values()], requestCount };
  }

  /** Bounded exact-condition native history; no cursor or render-path side effects. */
  async listConditionActivityV2(wallet: string, params: {
    conditionId: string; start: number; end: number; maxRequests: number;
    signal?: AbortSignal | undefined;
  }): Promise<{ activity: PolymarketActivityV2[]; requestCount: number }> {
    assertWallet(wallet);
    if (!CONDITION_ID_PATTERN.test(params.conditionId) || !Number.isInteger(params.maxRequests) ||
      params.maxRequests < 1 || params.maxRequests > 5 || !Number.isFinite(params.start) ||
      !Number.isFinite(params.end) || params.start < 0 || params.end < params.start) {
      throw new PolyDataApiPositionsV2Error("invalid bounded activity cohort");
    }
    const activity: PolymarketActivityV2[] = [];
    const priorPages = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < params.maxRequests; page += 1) {
      params.signal?.throwIfAborted();
      const url = new URL("/v2/activity", this.baseUrl);
      url.searchParams.set("user", wallet);
      url.searchParams.set("condition", params.conditionId);
      url.searchParams.set("start", String(params.start));
      url.searchParams.set("end", String(params.end));
      url.searchParams.set("limit", "1000");
      url.searchParams.set("exclude_deposits_withdrawals", "false");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = parseResponse(PolymarketActivityV2ResponseSchema,
        await this.fetchJson(url, params.signal), "/v2/activity");
      for (const row of response.data) {
        if (row.proxy_wallet.toLowerCase() !== wallet.toLowerCase() ||
          row.condition_id.toLowerCase() !== params.conditionId.toLowerCase() ||
          row.timestamp < params.start || row.timestamp > params.end) {
          throw new PolyDataApiPositionsV2Error("activity outside requested wallet/condition/window");
        }
      }
      // Identical anonymous records may be distinct matches within one page,
      // but overlapping pages must never multiply them into economic facts.
      for (const row of response.data) {
        if (priorPages.has(JSON.stringify(row))) throw new PolyDataApiPositionsV2Error("overlapping activity pages");
      }
      for (const row of response.data) priorPages.add(JSON.stringify(row));
      activity.push(...response.data);
      const next = response.pagination.next_cursor;
      if (next === null) return { activity, requestCount: page + 1 };
      if (cursors.has(next)) throw new PolyDataApiPositionsV2Error("activity cursor cycle");
      cursors.add(next);
      cursor = next;
    }
    throw new PolyDataApiPositionsV2Error("activity request budget exhausted", "request_budget");
  }

  /**
   * One cursor page of `GET /v2/activity?user=<wallet>` — lifecycle events
   * (TRADE/SPLIT/MERGE/REDEEM/...). Distinct from `/v2/trades`.
   */
  async listActivity(
    wallet: string,
    params?: ListActivityParams
  ): Promise<DataApiPage<ActivityEvent>> {
    assertWallet(wallet);
    const url = v2Url(this.baseUrl, "/v2/activity", {
      user: wallet,
      type: params?.type,
      side: params?.side,
      start: params?.start,
      end: params?.end,
      ...pageWindow(params?.cursor, params?.limit),
    });
    const response = parseResponse(
      PolymarketActivityV2ResponseSchema,
      await this.fetchJson(url, params?.signal),
      "/v2/activity"
    );
    return {
      rows: response.data.map(toActivityEvent),
      nextCursor: response.pagination.next_cursor,
    };
  }

  /**
   * `GET /v2/value?user=<wallet>` — cheap wallet-value probe. A documented
   * miss (`data: null`) is a wallet with no priced holdings: value 0.
   */
  async getValue(
    wallet: string,
    params?: GetValueParams
  ): Promise<{ user: string; value: number }> {
    assertWallet(wallet);
    const url = v2Url(this.baseUrl, "/v2/value", {
      user: wallet,
      condition: params?.market ? assertCondition(params.market) : undefined,
    });
    const response = parseResponse(
      PolymarketValueV2ResponseSchema,
      await this.fetchJson(url),
      "/v2/value"
    );
    return response.data
      ? { user: response.data.proxy_wallet, value: response.data.value }
      : { user: wallet, value: 0 };
  }

  /**
   * `GET /v2/holders?condition=<conditionId>` — current shareholders of every
   * outcome token of a market, flattened. Hidden-gem discovery input.
   */
  async getHolders(
    market: string,
    params?: GetHoldersParams
  ): Promise<MarketHolder[]> {
    const url = v2Url(this.baseUrl, "/v2/holders", {
      condition: assertCondition(market),
      limit: params?.limit,
    });
    const response = parseResponse(
      PolymarketHoldersV2ResponseSchema,
      await this.fetchJson(url),
      "/v2/holders"
    );
    return response.data.flatMap((group) =>
      group.holders.map((holder) => ({
        proxyWallet: holder.proxy_wallet,
        asset: holder.token_id,
        outcomeIndex: holder.outcome_index,
        amount: holder.amount,
        name: holder.name ?? null,
        pseudonym: holder.pseudonym ?? null,
        displayUsernamePublic: holder.display_username_public ?? false,
      }))
    );
  }

  /**
   * One cursor page of `GET /v2/trades?condition=<conditionId>` — market-level
   * trade stream. Used for counterparty harvesting (NOT per-user history — see
   * `listUserTrades`).
   */
  async listMarketTrades(
    market: string,
    params?: ListMarketTradesParams
  ): Promise<DataApiPage<PolymarketUserTrade>> {
    const url = v2Url(this.baseUrl, "/v2/trades", {
      condition: assertCondition(market),
      taker_only: params?.takerOnly !== false,
      ...pageWindow(params?.cursor, params?.limit ?? 100),
    });
    const response = parsePagedRows(
      PolymarketTradeV2Schema,
      PolymarketTradeIdentityV2Schema,
      await this.fetchJson(url),
      "/v2/trades?condition="
    );
    return {
      rows: response.data.map(toUserTrade),
      nextCursor: response.pagination.next_cursor,
    };
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
   * Resolve one CLOB token to its market leg through Gamma's exact token
   * filter. Returns null unless exactly one market contains the token exactly
   * once and its token/outcome arrays align.
   *
   * This deliberately does not use the Data API's process-wide 429 cooldown:
   * it is the bounded recovery path when `/positions` itself is delayed or
   * rate-limited. Callers are responsible for coalescing and caching.
   */
  async resolveTokenMetadata(
    tokenId: string
  ): Promise<PolymarketTokenMetadata | null> {
    if (!/^\d+$/.test(tokenId)) {
      throw new Error("resolveTokenMetadata: tokenId must be decimal digits");
    }
    const url = new URL("/markets", this.gammaBaseUrl);
    url.searchParams.set("clob_token_ids", tokenId);
    url.searchParams.set("limit", "2");

    const json = await this.fetchGammaJson(url);
    const markets = parseResponse(
      GammaTokenMarketsResponseSchema,
      json,
      "gamma:/markets?clob_token_ids"
    );
    if (markets.length !== 1) return null;
    const matches: PolymarketTokenMetadata[] = [];
    for (const market of markets) {
      const tokenIds = parseGammaStringArray(market.clobTokenIds);
      const outcomes = parseGammaStringArray(market.outcomes);
      if (!tokenIds || !outcomes || tokenIds.length !== outcomes.length) {
        continue;
      }
      const indexes = tokenIds.flatMap((candidate, index) =>
        candidate === tokenId ? [index] : []
      );
      if (indexes.length !== 1) continue;
      const outcome = outcomes[indexes[0] ?? -1]?.trim();
      if (!outcome || !CONDITION_ID_PATTERN.test(market.conditionId)) continue;
      matches.push({
        conditionId: market.conditionId,
        outcome,
        endDate: nonemptyStringOrNull(market.endDate),
        title: nonemptyStringOrNull(market.question),
        slug: nonemptyStringOrNull(market.slug),
      });
    }
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  private async fetchGammaJson(url: URL): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url.toString(), {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Polymarket Gamma API error: ${response.status} ${response.statusText} (${url.pathname})`
        );
      }
      return await response.json();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Polymarket Gamma API timeout after ${this.timeoutMs}ms (${url.pathname})`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `signal` (task.5015): optional caller-owned cancellation, combined with
   * the per-request timeout controller. Caller aborts (e.g. the trader
   * observation tick timing out) reject distinctly from timeouts so callers
   * can classify them.
   */
  private async fetchJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const remainingMs = cooldownUntilMs - Date.now();
    if (remainingMs > 0) {
      throw new PolyDataApiRateLimitedError(url.pathname, remainingMs);
    }
    // One deadline includes process-wide admission, transport and body decode.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onCallerAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (signal?.aborted) onCallerAbort();
    let acquired = false;
    try {
      try {
        await acquireSlot(controller.signal);
        acquired = true;
      } catch (err) {
        if (signal?.aborted) {
          throw new PolyDataApiRequestError(
            `Polymarket Data API request aborted by caller while queued (${url.pathname})`,
            false
          );
        }
        throw err;
      }
      const afterWaitMs = cooldownUntilMs - Date.now();
      if (afterWaitMs > 0) {
        throw new PolyDataApiRateLimitedError(url.pathname, afterWaitMs);
      }
      controller.signal.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw err;
        throw new PolyDataApiRequestError(
          err instanceof Error ? err.message : String(err),
          true
        );
      }
      if (!response.ok) {
        const message = `Polymarket Data API error: ${response.status} ${response.statusText} (${url.pathname})`;
        if (response.status === 429) {
          const waitMs = parseRetryAfterMs(
            response.headers?.get?.("retry-after") ?? null
          );
          cooldownUntilMs = Date.now() + waitMs;
          throw new PolyDataApiRateLimitedError(url.pathname, waitMs, message);
        }
        throw new PolyDataApiRequestError(
          message,
          response.status === 408 || response.status >= 500,
          response.status
        );
      }
      // Invalid JSON is semantic and deliberately remains SyntaxError.
      const json: unknown = await response.json();
      controller.signal.throwIfAborted();
      return json;
    } catch (err) {
      if (signal?.aborted) {
        if (err instanceof PolyDataApiRequestError && !err.retryable) throw err;
        throw new PolyDataApiRequestError(
          `Polymarket Data API request aborted by caller (${url.pathname})`,
          false
        );
      }
      if (controller.signal.aborted) {
        throw new PolyDataApiRequestError(
          `Polymarket Data API timeout after ${this.timeoutMs}ms (${url.pathname})`,
          true
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
      // A caller abort never releases admission until actual IO settles.
      if (acquired) releaseSlot();
    }
  }
}

function parseGammaStringArray(value: string | string[]): string[] | null {
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === "string") ? value : null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function nonemptyStringOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

function normalizeV2Position(
  row: PolymarketUserPositionV2
): PolymarketUserPosition {
  return PolymarketUserPositionSchema.parse({
    ...row,
    proxyWallet: row.proxy_wallet,
    asset: row.token_id,
    conditionId: row.condition_id.toLowerCase(),
    size: row.current_size,
    avgPrice: row.avg_price,
    initialValue: row.entry_cost_usdc,
    // `total_cost_usdc` = entry cost + entry fees: the gross opening cash.
    grossInitialValue: row.total_cost_usdc,
    entryFeesUsdc: row.entry_fees_usdc,
    currentValue: row.current_value,
    cashPnl: row.unrealized_pnl,
    percentPnl: row.percent_pnl,
    totalBought: row.total_size,
    realizedPnl: row.realized_pnl,
    percentRealizedPnl: row.percent_realized_pnl,
    curPrice: row.current_price,
    redeemable: row.redeemable ?? row.status === "REDEEMABLE",
    mergeable: row.mergeable,
    title: row.title ?? "",
    slug: row.slug,
    icon: row.icon,
    eventId: row.event_id,
    eventSlug: row.event_slug,
    outcome: row.outcome,
    outcomeIndex: row.outcome_index,
    oppositeOutcome: row.opposite_outcome,
    oppositeAsset: row.opposite_token_id ?? null,
    endDate: row.end_date,
    negativeRisk: row.negative_risk,
  });
}

function toUserTrade(row: PolymarketTradeV2): PolymarketUserTrade {
  return {
    proxyWallet: row.proxy_wallet,
    side: row.side,
    asset: row.token_id,
    conditionId: row.condition_id.toLowerCase(),
    size: row.size,
    price: row.price,
    timestamp: row.timestamp,
    title: row.title ?? "",
    slug: row.slug ?? "",
    eventSlug: row.event_slug ?? "",
    icon: row.icon ?? "",
    outcome: row.outcome,
    outcomeIndex: row.outcome_index,
    transactionHash: row.transaction_hash,
  };
}

function toActivityEvent(row: PolymarketActivityV2): ActivityEvent {
  return {
    proxyWallet: row.proxy_wallet,
    type: row.type,
    timestamp: row.timestamp,
    conditionId: row.condition_id.toLowerCase(),
    asset: row.token_id ?? null,
    side: row.side === "BUY" || row.side === "SELL" ? row.side : null,
    size: row.size,
    usdcSize: row.usdc_size,
    price: row.price ?? null,
    outcome: row.outcome ?? null,
    title: row.title ?? null,
    slug: row.slug ?? null,
    eventSlug: row.event_slug ?? null,
    transactionHash: row.transaction_hash,
  };
}

/**
 * `limit` only applies to the first page; once a cursor exists it carries its
 * own size (the API ignores `limit` then), so it is not re-sent.
 */
function pageWindow(
  cursor: string | undefined,
  limit: number | undefined
): { cursor?: string; limit?: number | undefined } {
  return cursor === undefined ? { limit } : { cursor };
}

type QueryValue = string | number | boolean | undefined;

function v2Url(
  baseUrl: string,
  pathname: string,
  query: Record<string, QueryValue>
): URL {
  const url = new URL(pathname, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function assertCondition(conditionId: string): string {
  if (!CONDITION_ID_PATTERN.test(conditionId)) {
    throw new Error(`Invalid condition id: ${conditionId}`);
  }
  return conditionId.toLowerCase();
}

function assertWallet(wallet: string): void {
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    throw new Error(`Invalid wallet address: ${wallet}`);
  }
}

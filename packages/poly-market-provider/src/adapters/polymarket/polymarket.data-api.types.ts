// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/adapters/polymarket/polymarket.data-api.types`
 * Purpose: Domain types for the Polymarket Data API v2 reads (leaderboard, trades, positions, activity, holders) plus Gamma public-search / token-market schemas.
 * Scope: Pure type definitions; wire (snake_case) schemas live in `polymarket.data-api-v2.types.ts`. Does not contain I/O or runtime logic.
 * Invariants: PACKAGES_NO_ENV.
 * Side-effects: none
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/research/poly-copy-trading-wallets.md
 * @public
 */

import { z } from "zod";

/**
 * Leaderboard time window. The client lower-cases it onto `time_period` of
 * `GET /v2/leaderboard`.
 */
export const PolymarketLeaderboardTimePeriodSchema = z.enum([
  "DAY",
  "WEEK",
  "MONTH",
  "ALL",
]);
export type PolymarketLeaderboardTimePeriod = z.infer<
  typeof PolymarketLeaderboardTimePeriodSchema
>;

/** Leaderboard sort metric (`PNL` | `VOL`; the client maps VOL -> `VOLUME`). */
export const PolymarketLeaderboardOrderBySchema = z.enum(["PNL", "VOL"]);
export type PolymarketLeaderboardOrderBy = z.infer<
  typeof PolymarketLeaderboardOrderBySchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Domain rows. The client maps the snake_case `/v2/*` wire rows
// (`polymarket.data-api-v2.types.ts`) onto these camelCase types at the adapter
// boundary, so consumers never see wire shapes. Identity fields (`asset`,
// `conditionId`, `outcomeIndex`) are always exact and required: a wire row that
// lacks one is rejected by the wire schema, never defaulted here.
// ─────────────────────────────────────────────────────────────────────────────

/** One `GET /v2/leaderboard` row. `rank` is kept as a string for consumers. */
export type PolymarketLeaderboardEntry = {
  rank: string;
  proxyWallet: string;
  userName: string;
  xUsername: string;
  verifiedBadge: boolean;
  vol: number;
  pnl: number;
  profileImage: string;
};

/** One `GET /v2/trades` row (user feed or market feed). */
export type PolymarketUserTrade = {
  proxyWallet: string;
  side: "BUY" | "SELL";
  /** Exact CLOB token id (`token_id` on the wire). */
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  eventSlug: string;
  icon: string;
  outcome: string;
  outcomeIndex: number;
  transactionHash: string;
};

/**
 * Position row (`GET /v2/positions`), mapped onto the legacy camelCase names.
 * `.passthrough()` keeps the raw snake_case wire fields next to the mapped ones
 * because persisted `raw` metadata reads both spellings.
 */
export const PolymarketUserPositionSchema = z
  .object({
    proxyWallet: z.string(),
    asset: z.string().min(1),
    conditionId: z.string().min(1),
    size: z.coerce.number(),
    avgPrice: z.coerce.number(),
    initialValue: z.coerce.number(),
    /** Gross opening cash observed by Data API; used only for strict fill corroboration. */
    grossInitialValue: z.coerce.number().optional(),
    /** Position-level entry fees. Undefined when the upstream response omits them. */
    entryFeesUsdc: z.coerce.number().optional(),
    currentValue: z.coerce.number(),
    cashPnl: z.coerce.number(),
    percentPnl: z.coerce.number(),
    totalBought: z.coerce.number().optional().default(0),
    realizedPnl: z.coerce.number(),
    percentRealizedPnl: z.coerce.number().optional().default(0),
    curPrice: z.coerce.number(),
    redeemable: z.boolean().default(false),
    mergeable: z.boolean().default(false),
    title: z.string().optional().default(""),
    slug: z.string().optional().nullable().default(""),
    icon: z.string().optional().nullable().default(""),
    eventId: z.string().optional().nullable().default(""),
    eventSlug: z.string().optional().nullable().default(""),
    outcome: z.string().optional().default(""),
    /** Exact wire value; a row without `outcome_index` never reaches here. */
    outcomeIndex: z.number().int().nonnegative(),
    oppositeOutcome: z.string().optional().nullable().default(""),
    /** `null` when the wire row carries no opposite token — never `""`. */
    oppositeAsset: z.string().nullable(),
    endDate: z.string().optional().nullable().default(""),
    negativeRisk: z.boolean().optional().default(false),
  })
  .passthrough();
export type PolymarketUserPosition = z.infer<
  typeof PolymarketUserPositionSchema
>;

/**
 * Lifecycle event type filter on `GET /v2/activity` (the API accepts more
 * values; these are the ones the research tools expose).
 */
export const ActivityEventTypeSchema = z.enum([
  "TRADE",
  "SPLIT",
  "MERGE",
  "REDEEM",
  "REWARD",
  "CONVERSION",
]);
export type ActivityEventType = z.infer<typeof ActivityEventTypeSchema>;

/** One `GET /v2/activity` row. Non-trade rows carry no token / side / price. */
export type ActivityEvent = {
  proxyWallet: string;
  type: string;
  timestamp: number;
  conditionId: string;
  asset: string | null;
  side: "BUY" | "SELL" | null;
  size: number;
  usdcSize: number;
  price: number | null;
  outcome: string | null;
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  transactionHash: string;
};

/** One holder of one outcome token (`GET /v2/holders`, flattened across tokens). */
export type MarketHolder = {
  proxyWallet: string;
  /** Exact CLOB token id this balance is held in. */
  asset: string;
  outcomeIndex: number;
  amount: number;
  name: string | null;
  pseudonym: string | null;
  /** False when the holder opted out of showing `name` publicly. */
  displayUsernamePublic: boolean;
};

/** A cursor-paged read: `nextCursor === null` means the feed is exhausted. */
export type DataApiPage<T> = {
  rows: T[];
  nextCursor: string | null;
};

/**
 * Gamma `/public-search?profile=true` — handle → proxyWallet resolution.
 * Gamma has a different host (`gamma-api.polymarket.com`) than the Data API.
 */
export const GammaProfileSchema = z
  .object({
    name: z.string().optional().nullable().default(""),
    pseudonym: z.string().optional().nullable().default(""),
    displayUsername: z.string().optional().nullable().default(""),
    proxyWallet: z.string(),
    profileImage: z.string().optional().nullable().default(""),
    bio: z.string().optional().nullable().default(""),
  })
  .passthrough();
export type GammaProfile = z.infer<typeof GammaProfileSchema>;

/**
 * Gamma `/public-search` top-level response — we only care about `profiles`.
 */
export const GammaPublicSearchResponseSchema = z
  .object({
    profiles: z.array(GammaProfileSchema).optional().default([]),
  })
  .passthrough();

/**
 * Gamma `GET /markets?clob_token_ids=<tokenId>` identity fields.
 * Gamma encodes both token ids and outcomes as JSON strings on the wire.
 */
export const GammaTokenMarketSchema = z
  .object({
    conditionId: z.string(),
    question: z.string().optional().nullable().default(""),
    slug: z.string().optional().nullable().default(""),
    endDate: z.string().optional().nullable().default(""),
    outcomes: z.string().or(z.array(z.string())),
    clobTokenIds: z.string().or(z.array(z.string())),
  })
  .passthrough();

export const GammaTokenMarketsResponseSchema = z.array(GammaTokenMarketSchema);

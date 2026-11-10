// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Strict wire schemas for the Polymarket Data API v2 reads (positions, trades, activity, holders, leaderboard, value). */
import { z } from "zod";

/**
 * Row lifecycle values emitted by `/v2/positions`.
 *
 * `status=OPEN` is a superset: settled-but-unredeemed winners are returned as
 * `REDEEMABLE`. `REDEEMABLE_LOST` and `MERGEABLE` are query filters, not row
 * statuses; accepting them here would hide an upstream contract change.
 */
export const PolymarketPositionStatusV2Schema = z.enum([
  "OPEN",
  "REDEEMABLE",
  "CLOSED",
]);

export const PolymarketUserPositionV2Schema = z
  .object({
    archived: z.boolean().optional(),
    avg_price: z.number().finite().nonnegative(),
    condition_id: z.string().min(1),
    current_price: z.number().finite().nonnegative(),
    current_size: z.number().finite().nonnegative(),
    current_value: z.number().finite().nonnegative(),
    end_date: z.string().nullable().optional(),
    entry_cost_usdc: z.number().finite().nonnegative(),
    entry_fees_usdc: z.number().finite().nonnegative().optional(),
    event_id: z.string().nullable().optional(),
    event_slug: z.string().nullable().optional(),
    first_entry_at: z.number().finite().nonnegative().nullable().optional(),
    icon: z.string().nullable().optional(),
    last_event_at: z.number().finite().nonnegative().nullable().optional(),
    mergeable: z.boolean().optional(),
    name: z.string().nullable().optional(),
    negative_risk: z.boolean().optional(),
    opposite_outcome: z.string().nullable().optional(),
    opposite_token_id: z.string().nullable().optional(),
    outcome: z.string().optional(),
    outcome_index: z.number().int().nonnegative(),
    percent_pnl: z.number().finite(),
    percent_realized_pnl: z.number().finite(),
    profile_image: z.string().nullable().optional(),
    proxy_wallet: z.string().min(1),
    realized_pnl: z.number().finite(),
    redeemable: z.boolean().optional(),
    slug: z.string().nullable().optional(),
    status: PolymarketPositionStatusV2Schema,
    title: z.string().nullable().optional(),
    token_id: z.string().min(1),
    total_cost_usdc: z.number().finite().nonnegative(),
    total_pnl: z.number().finite(),
    total_size: z.number().finite().nonnegative(),
    unrealized_pnl: z.number().finite(),
    verified: z.boolean().optional(),
  })
  .passthrough();
export type PolymarketUserPositionV2 = z.infer<
  typeof PolymarketUserPositionV2Schema
>;

export const PolymarketPositionsV2PaginationSchema = z
  .object({
    has_more: z.boolean(),
    limit: z.number().int().nonnegative().max(1000),
    offset: z.number().int().nonnegative(),
    next_cursor: z.string().min(1).nullable(),
  })
  .superRefine((pagination, context) => {
    if (pagination.has_more !== (pagination.next_cursor !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "has_more must agree with next_cursor",
        path: ["next_cursor"],
      });
    }
  });

export const PolymarketUserPositionsV2ResponseSchema = z.object({
  data: z.array(PolymarketUserPositionV2Schema),
  pagination: PolymarketPositionsV2PaginationSchema,
});
export type PolymarketUserPositionsV2Response = z.infer<
  typeof PolymarketUserPositionsV2ResponseSchema
>;

export const PolymarketDataApiStatusV2Schema = z.object({
  data: z.object({
    computed_at: z.string().min(1),
    age_seconds: z.number().int().nonnegative(),
    serving: z.object({
      lag_seconds: z.number().int().nonnegative().nullable().optional(),
      worst: z.string().nullable().optional(),
      mechanisms: z.array(
        z.object({
          name: z.string().min(1),
          age_seconds: z.number().int().nonnegative(),
          blocks_behind: z.number().int().nonnegative().nullable().optional(),
        })
      ),
    }),
    ingestion: z.object({
      cursors: z.number().int().nonnegative(),
      network: z.string().nullable().optional(),
      chain_id: z.number().int(),
      max_synced_block: z.number().int().nonnegative().nullable().optional(),
    }),
  }),
});
export type PolymarketDataApiStatusV2 = z.infer<
  typeof PolymarketDataApiStatusV2Schema
>["data"];

/** Native source amounts are retained without multiplying rounded price. */
export const PolymarketActivityV2Schema = z.object({
  proxy_wallet: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
  condition_id: z.string(),
  type: z.string().min(1),
  token_id: z.string().nullable().optional(),
  transaction_hash: z.string().min(1),
  size: z.number().finite().nonnegative(),
  usdc_size: z.number().finite().nonnegative(),
  price: z.number().finite().nonnegative().nullable().optional(),
  side: z.enum(["BUY", "SELL", ""]).nullable().optional(),
  outcome: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  event_slug: z.string().nullable().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  trade_id: z.union([z.string(), z.number()]).optional(),
  log_index: z.number().int().nonnegative().optional(),
}).passthrough().superRefine((row, context) => {
  if (row.type === "TRADE" && (row.side !== "BUY" && row.side !== "SELL" || !row.token_id || !/^[0-9]+$/.test(row.token_id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "TRADE requires an exact token and BUY/SELL side" });
  }
});
export type PolymarketActivityV2 = z.infer<typeof PolymarketActivityV2Schema>;
export const PolymarketActivityV2ResponseSchema = z.object({
  data: z.array(PolymarketActivityV2Schema).max(1000),
  pagination: PolymarketPositionsV2PaginationSchema,
});

const TOKEN_ID_PATTERN = /^[0-9]+$/;

/**
 * One `/v2/trades` row (user feed and condition feed share the shape).
 * Identity is exact: a row without `token_id`, `condition_id` or
 * `outcome_index` fails validation; nothing is inferred from position or index.
 */
export const PolymarketTradeV2Schema = z
  .object({
    proxy_wallet: z.string().min(1),
    side: z.enum(["BUY", "SELL"]),
    token_id: z.string().regex(TOKEN_ID_PATTERN),
    condition_id: z.string().min(1),
    size: z.number().finite().nonnegative(),
    price: z.number().finite().nonnegative(),
    timestamp: z.number().int().nonnegative(),
    transaction_hash: z.string(),
    outcome: z.string().min(1),
    outcome_index: z.number().int().nonnegative(),
    title: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    event_slug: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
  })
  .passthrough();
export type PolymarketTradeV2 = z.infer<typeof PolymarketTradeV2Schema>;
export const PolymarketTradesV2ResponseSchema = z.object({
  data: z.array(PolymarketTradeV2Schema),
  pagination: PolymarketPositionsV2PaginationSchema,
});

/** `/v2/holders`: one group per outcome token, each with its holders. */
export const PolymarketHoldersV2ResponseSchema = z.object({
  data: z.array(
    z
      .object({
      token_id: z.string().regex(TOKEN_ID_PATTERN),
      holders: z.array(
        z
          .object({
            proxy_wallet: z.string().min(1),
            token_id: z.string().regex(TOKEN_ID_PATTERN),
            outcome_index: z.number().int().nonnegative(),
            amount: z.number().finite().nonnegative(),
            name: z.string().nullable().optional(),
            pseudonym: z.string().nullable().optional(),
            display_username_public: z.boolean().optional(),
          })
          .passthrough()
      ),
    })
    .superRefine((group, context) => {
      // Exact identity: a holder row is never re-keyed onto another token.
      if (group.holders.some((holder) => holder.token_id !== group.token_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "holder token_id must equal its group token_id",
          path: ["holders"],
        });
      }
    })
  ),
});

/** `/v2/leaderboard` board page (`user=` single-wallet lookups are not used). */
export const PolymarketLeaderboardV2ResponseSchema = z.object({
  data: z.array(
    z
      .object({
        rank: z.number().int().positive(),
        user_id: z.string().min(1),
        pnl: z.number().finite(),
        volume: z.number().finite(),
        user_name: z.string().nullable().optional(),
        x_username: z.string().nullable().optional(),
        profile_image: z.string().nullable().optional(),
        verified: z.boolean().optional(),
      })
      .passthrough()
  ),
});

/** `/v2/value`: `data` is `null` for a documented miss. */
export const PolymarketValueV2ResponseSchema = z.object({
  data: z
    .object({
      proxy_wallet: z.string().min(1),
      value: z.number().finite().nonnegative(),
    })
    .passthrough()
    .nullable(),
});

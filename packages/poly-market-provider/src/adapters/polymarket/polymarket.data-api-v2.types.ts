// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Strict schemas for condition-scoped Polymarket Data API V2 positions. */
import { z } from "zod";

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
    outcome_index: z.number().int().nonnegative().optional(),
    percent_pnl: z.number().finite(),
    percent_realized_pnl: z.number().finite(),
    profile_image: z.string().nullable().optional(),
    proxy_wallet: z.string().min(1),
    realized_pnl: z.number().finite(),
    redeemable: z.boolean().optional(),
    slug: z.string().nullable().optional(),
    status: z.literal("OPEN"),
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

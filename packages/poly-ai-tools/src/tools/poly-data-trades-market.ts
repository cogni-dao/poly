// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-ai-tools/tools/poly-data-trades-market`
 * Purpose: AI tool — list market-level trades (all wallets) via `GET /trades?market=`.
 * Scope: Read-only. Used for counterparty harvesting (NOT per-user history). Does not place trades, does not load env.
 * Invariants: TOOL_ID_NAMESPACED, EFFECT_READ_ONLY, PAGINATION_CONSISTENT, NO_LANGCHAIN_IMPORT.
 * Side-effects: IO (capability)
 * Links: work/items/task.0386.poly-agent-wallet-research-v0.md
 * @public
 */

import { z } from "zod";

import type { PolyDataCapability } from "../capabilities/poly-data";
import type { BoundTool, ToolContract, ToolImplementation } from "@cogni/ai-tools";

export const PolyDataTradesMarketInputSchema = z.object({
  market: z
    .string()
    .min(1)
    .describe("Market conditionId (hex) — NOT the slug or CTF tokenId."),
  takerOnly: z
    .boolean()
    .optional()
    .describe(
      "Default false: include maker-side rows too. True: each fill once, on its taker side."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Rows per first page (1-1000, default 100)."),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Opaque `nextCursor` from the previous page; re-send every other argument unchanged."
    ),
});
export type PolyDataTradesMarketInput = z.infer<
  typeof PolyDataTradesMarketInputSchema
>;

const MarketTradeEntrySchema = z.object({
  proxyWallet: z.string(),
  side: z.enum(["BUY", "SELL"]),
  asset: z.string(),
  size: z.number(),
  price: z.number(),
  timestamp: z.number(),
  outcome: z.string(),
});

export const PolyDataTradesMarketOutputSchema = z.object({
  market: z.string(),
  trades: z.array(MarketTradeEntrySchema),
  count: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type PolyDataTradesMarketOutput = z.infer<
  typeof PolyDataTradesMarketOutputSchema
>;
export type PolyDataTradesMarketRedacted = PolyDataTradesMarketOutput;

export const POLY_DATA_TRADES_MARKET_NAME =
  "core__poly_data_trades_market" as const;

export const polyDataTradesMarketContract: ToolContract<
  typeof POLY_DATA_TRADES_MARKET_NAME,
  PolyDataTradesMarketInput,
  PolyDataTradesMarketOutput,
  PolyDataTradesMarketRedacted
> = {
  name: POLY_DATA_TRADES_MARKET_NAME,
  description:
    "List recent trades on a Polymarket market across ALL wallets (not a single user's history). " +
    "Use for counterparty harvesting — every trade row exposes the trading wallet, surfacing " +
    "wallets that traded the market. Paired with `core__poly_data_holders` to discover active " +
    "participants. `market` is the conditionId (hex).",
  effect: "read_only",
  inputSchema: PolyDataTradesMarketInputSchema,
  outputSchema: PolyDataTradesMarketOutputSchema,
  redact: (out) => out,
  allowlist: ["market", "trades", "count", "hasMore", "nextCursor"] as const,
};

export interface PolyDataTradesMarketDeps {
  polyDataCapability: PolyDataCapability;
}

export function createPolyDataTradesMarketImplementation(
  deps: PolyDataTradesMarketDeps
): ToolImplementation<PolyDataTradesMarketInput, PolyDataTradesMarketOutput> {
  return {
    execute: async (input) =>
      deps.polyDataCapability.listMarketTrades({
        market: input.market,
        takerOnly: input.takerOnly ?? false,
        limit: input.limit ?? 100,
        ...(input.cursor !== undefined && { cursor: input.cursor }),
      }),
  };
}

export const polyDataTradesMarketStubImplementation: ToolImplementation<
  PolyDataTradesMarketInput,
  PolyDataTradesMarketOutput
> = {
  execute: async (input) => ({
    market: input.market,
    trades: [],
    count: 0,
    hasMore: false,
    nextCursor: null,
  }),
};

export const polyDataTradesMarketBoundTool: BoundTool<
  typeof POLY_DATA_TRADES_MARKET_NAME,
  PolyDataTradesMarketInput,
  PolyDataTradesMarketOutput,
  PolyDataTradesMarketRedacted
> = {
  contract: polyDataTradesMarketContract,
  implementation: polyDataTradesMarketStubImplementation,
};

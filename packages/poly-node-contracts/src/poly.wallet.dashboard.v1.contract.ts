// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** One coherent, DB-only wallet-dashboard snapshot for the signed-in tenant. */
import { z } from "zod";
import {
  PolyWalletExecutionOutputSchema,
  WalletExecutionMarketGroupSchema,
  WalletExecutionPositionSchema,
} from "./poly.wallet.execution.v1.contract";
import {
  PolyWalletOverviewIntervalSchema,
  polyWalletOverviewOperation,
} from "./poly.wallet.overview.v1.contract";

export const WalletDashboardFactStatusSchema = z.enum([
  "fresh",
  "stale",
  "partial",
  "unavailable",
]);
export const WalletDashboardFactSourceSchema = z.enum([
  "wallet_connection",
  "polygon_balance_snapshot",
  "data_api_current_positions",
  "user_pnl_snapshot",
  "local_ledger",
  "composite",
]);
export const WalletDashboardWarningComponentSchema = z.enum([
  "wallet",
  "cash",
  "orders",
  "positions",
  "history",
  "pnl",
  "activity",
  "markets",
]);

export const WalletDashboardFactMetaSchema = z.object({
  status: WalletDashboardFactStatusSchema,
  source: WalletDashboardFactSourceSchema,
  observedAt: z.string().nullable(),
  ageMs: z.number().int().nonnegative().nullable(),
  complete: z.boolean(),
});

export const WalletDashboardWarningSchema = z.object({
  component: WalletDashboardWarningComponentSchema,
  code: z.string(),
  message: z.string(),
});

export const PolyWalletDashboardOutputSchema = z.object({
  snapshotId: z.string().uuid(),
  capturedAt: z.string(),
  interval: PolyWalletOverviewIntervalSchema,
  overview: polyWalletOverviewOperation.output,
  execution: PolyWalletExecutionOutputSchema.extend({
    closed_position_count: z.number().int().nonnegative().nullable(),
    live_position_count: z.number().int().nonnegative().nullable(),
    live_positions: z.array(WalletExecutionPositionSchema).max(500),
    closed_positions: z.array(WalletExecutionPositionSchema).max(30),
    market_groups: z.array(WalletExecutionMarketGroupSchema).max(200),
  }),
  facts: z.object({
    wallet: WalletDashboardFactMetaSchema,
    cash: WalletDashboardFactMetaSchema,
    orders: WalletDashboardFactMetaSchema.extend({
      authority: z.literal("provisional_local_ledger"),
    }),
    positions: WalletDashboardFactMetaSchema.extend({
      actionsAllowed: z.boolean(),
      previewLimit: z.literal(500),
    }),
    history: WalletDashboardFactMetaSchema.extend({
      authority: z.literal("provisional_local_ledger"),
      previewLimit: z.literal(30),
    }),
    pnl: WalletDashboardFactMetaSchema,
    activity: WalletDashboardFactMetaSchema,
    markets: WalletDashboardFactMetaSchema,
    total: WalletDashboardFactMetaSchema,
  }),
  warnings: z.array(WalletDashboardWarningSchema),
});

export const polyWalletDashboardOperation = {
  id: "poly.wallet.dashboard.v1",
  summary: "Read one coherent tenant wallet dashboard snapshot",
  input: z.object({
    interval: PolyWalletOverviewIntervalSchema.optional().default("1W"),
  }),
  output: PolyWalletDashboardOutputSchema,
} as const;

export type PolyWalletDashboardOutput = z.infer<
  typeof PolyWalletDashboardOutputSchema
>;
export type WalletDashboardFactMeta = z.infer<
  typeof WalletDashboardFactMetaSchema
>;
export type WalletDashboardWarning = z.infer<
  typeof WalletDashboardWarningSchema
>;

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

export const WalletDashboardComparisonCoverageReasonSchema = z.enum([
  "comparison_missing",
  "preview_truncated",
  "source_unavailable",
  "source_incomplete",
  "identity_ambiguous",
]);
export type WalletDashboardComparisonCoverageReason = z.infer<
  typeof WalletDashboardComparisonCoverageReasonSchema
>;

/**
 * Full-population comparison coverage for one dashboard delta histogram.
 * `eligible`/`comparable`/`dropped` are exact SQL counts over the full saved
 * inventory. `sampled` is the number of finite deltas present in the bounded
 * response that feeds the histogram. Unavailable sources use null counts,
 * never fabricated zeroes. Multiple reasons may coexist.
 */
export const WalletDashboardComparisonCoverageLeafSchema = z
  .object({
    eligible: z.number().int().nonnegative().nullable(),
    comparable: z.number().int().nonnegative().nullable(),
    dropped: z.number().int().nonnegative().nullable(),
    sampled: z.number().int().nonnegative().nullable(),
    complete: z.boolean(),
    reasons: z
      .array(WalletDashboardComparisonCoverageReasonSchema)
      .max(5)
      .refine((reasons) => new Set(reasons).size === reasons.length, {
        message: "comparison coverage reasons must be unique",
      }),
  })
  .superRefine((value, context) => {
    const counts = [
      value.eligible,
      value.comparable,
      value.dropped,
      value.sampled,
    ];
    const allNull = counts.every((count) => count === null);
    const allPresent = counts.every((count) => count !== null);
    if (!allNull && !allPresent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "comparison coverage counts must be all null or all present",
      });
      return;
    }
    if (allNull) {
      if (
        value.complete ||
        !value.reasons.includes("source_unavailable")
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "unavailable comparison coverage must be incomplete and state source_unavailable",
        });
      }
      return;
    }
    if (value.reasons.includes("source_unavailable")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "available comparison coverage cannot state source_unavailable",
      });
    }
    const eligible = value.eligible ?? 0;
    const comparable = value.comparable ?? 0;
    const dropped = value.dropped ?? 0;
    const sampled = value.sampled ?? 0;
    if (eligible !== comparable + dropped) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "eligible must equal comparable plus dropped",
      });
    }
    if (sampled > comparable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sampled cannot exceed comparable",
      });
    }
    const shouldBeComplete =
      dropped === 0 && sampled === comparable && value.reasons.length === 0;
    if (value.complete !== shouldBeComplete) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "complete requires zero dropped rows, a complete sample, and no reasons",
      });
    }
  });
export type WalletDashboardComparisonCoverageLeaf = z.infer<
  typeof WalletDashboardComparisonCoverageLeafSchema
>;

const WalletDashboardComparisonCoverageByStatusSchema = z.object({
  live: WalletDashboardComparisonCoverageLeafSchema,
  closed: WalletDashboardComparisonCoverageLeafSchema,
});

export const WalletDashboardComparisonCoverageSchema = z.object({
  markets: WalletDashboardComparisonCoverageByStatusSchema,
  positions: WalletDashboardComparisonCoverageByStatusSchema,
  positionClassifications: z
    .array(
      z.object({
        conditionId: z.string(),
        tokenId: z.string(),
        status: z.enum(["live", "closed"]),
        result: z.enum([
          "comparable",
          "no_target_position",
          "exact_token_missing",
          "target_entry_unavailable",
          "local_entry_unavailable",
          "identity_ambiguous",
          "status_mismatch",
        ]),
      })
    )
    .max(530),
});
export type WalletDashboardComparisonCoverage = z.infer<
  typeof WalletDashboardComparisonCoverageSchema
>;

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
    comparisonCoverage: WalletDashboardComparisonCoverageSchema,
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

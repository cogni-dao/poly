// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/shared/env.server.research-budget`
 * Purpose: Pin the POLY_RESEARCH_WALLET_BUDGET_MS env-schema default to the
 *   service-side DEFAULT_TRADER_COMPARISON_WALLET_BUDGET_MS. Every production
 *   caller routes the budget through `serverEnv()`, so a schema default that
 *   drifts from the code default silently shadows it — exactly how #99's 8s
 *   budget never took effect in prod (the schema still defaulted to 25s and
 *   the worst wallet burned 25.7s per interval, fix/comparison-flows-pushdown).
 * Scope: Unit — parses the single schema field; no process.env mutation.
 * Invariants under test: env default === code default === 8_000.
 * Side-effects: none.
 * Links: src/shared/env/server-env.ts,
 *        src/features/wallet-analysis/server/trader-comparison-service.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_TRADER_COMPARISON_WALLET_BUDGET_MS } from "@/features/wallet-analysis/server/trader-comparison-service";
import { serverSchema } from "@/shared/env/server-env";

describe("POLY_RESEARCH_WALLET_BUDGET_MS default", () => {
  it("env-schema default equals the service default so prod runs the intended budget", () => {
    expect(
      serverSchema.shape.POLY_RESEARCH_WALLET_BUDGET_MS.parse(undefined)
    ).toBe(DEFAULT_TRADER_COMPARISON_WALLET_BUDGET_MS);
  });

  it("the shared default is 8s (returns a pool slot before the 15s boot-SLO probe)", () => {
    expect(DEFAULT_TRADER_COMPARISON_WALLET_BUDGET_MS).toBe(8_000);
  });

  it("explicit env values still override the default", () => {
    expect(
      serverSchema.shape.POLY_RESEARCH_WALLET_BUDGET_MS.parse("25000")
    ).toBe(25_000);
  });
});

describe("POLY_RESEARCH_PREWARM_BUDGET_MS default (fix/prewarm-budget-split)", () => {
  it("background-lane default is 45s so prewarm/heal computes complete un-degraded", () => {
    expect(
      serverSchema.shape.POLY_RESEARCH_PREWARM_BUDGET_MS.parse(undefined)
    ).toBe(45_000);
  });

  it("background default exceeds the request default — a background budget at or below the request budget recreates the self-defeating never-cached loop (prod 4ceff2e1)", () => {
    expect(
      serverSchema.shape.POLY_RESEARCH_PREWARM_BUDGET_MS.parse(undefined)
    ).toBeGreaterThan(
      serverSchema.shape.POLY_RESEARCH_WALLET_BUDGET_MS.parse(undefined)
    );
  });

  it("explicit env values still override the default", () => {
    expect(
      serverSchema.shape.POLY_RESEARCH_PREWARM_BUDGET_MS.parse("60000")
    ).toBe(60_000);
  });
});

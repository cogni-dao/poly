// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  POLY_COPY_TRADE_INVESTIGATION_EVIDENCE_MAX_LIMIT,
  PolyResearchCopyTradeInvestigationEvidenceQuerySchema,
  PolyResearchCopyTradeInvestigationQuerySchema,
  PolyResearchCopyTradeInvestigationResponseSchema,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";

const ACCOUNT = "20000000-0000-4000-b000-000000000001";

describe("poly copy-trade investigation contract", () => {
  it("accepts the production ledger market key at the API boundary", () => {
    expect(
      PolyResearchCopyTradeInvestigationQuerySchema.safeParse({
        billing_account_id: ACCOUNT,
        condition_id: "prediction-market:polymarket:0xcondition",
        mode: "paper",
      }).success
    ).toBe(true);
  });

  it("compares timestamp instants rather than offset-bearing strings", () => {
    expect(
      PolyResearchCopyTradeInvestigationQuerySchema.safeParse({
        billing_account_id: ACCOUNT,
        condition_id: "condition-a",
        mode: "paper",
        since: "2026-10-04T01:00:00+02:00",
        until: "2026-10-03T23:30:00Z",
      }).success
    ).toBe(true);
    expect(
      PolyResearchCopyTradeInvestigationQuerySchema.safeParse({
        billing_account_id: ACCOUNT,
        condition_id: "condition-a",
        mode: "paper",
        since: "2026-10-04T01:00:00Z",
        until: "2026-10-04T02:00:00+02:00",
      }).success
    ).toBe(false);
  });

  it("hard-caps evidence pages and requires the frozen captured_at", () => {
    expect(
      PolyResearchCopyTradeInvestigationEvidenceQuerySchema.safeParse({
        billing_account_id: ACCOUNT,
        condition_id: "condition-a",
        mode: "paper",
        kind: "fills",
        captured_at: "2026-10-04T00:00:00Z",
        limit: POLY_COPY_TRADE_INVESTIGATION_EVIDENCE_MAX_LIMIT,
      }).success
    ).toBe(true);
    expect(
      PolyResearchCopyTradeInvestigationEvidenceQuerySchema.safeParse({
        billing_account_id: ACCOUNT,
        condition_id: "condition-a",
        mode: "paper",
        kind: "fills",
        limit: POLY_COPY_TRADE_INVESTIGATION_EVIDENCE_MAX_LIMIT + 1,
      }).success
    ).toBe(false);
  });

  it("requires at least one account-association source and explicit completeness", () => {
    const base = {
      billing_account_id: ACCOUNT,
      condition_id: "condition-a",
      mode: "paper" as const,
      since: null,
      until: null,
      captured_at: "2026-10-04T00:00:00.000Z",
      association_sources: ["fill" as const],
      market: {
        condition_id: "condition-a",
        event_title: null,
        event_slug: null,
        market_title: "A market",
        market_slug: "a-market",
        end_date: null,
        metadata_fetched_at: "2026-10-04T00:00:00.000Z",
        outcomes: [],
      },
      account_position: {
        source: "mirror_execution_ledger" as const,
        legs: [],
        truncated: false,
      },
      targets: [],
      aggregates: {
        fills: {
          count: 0,
          placed_count: 0,
          pending_count: 0,
          open_count: 0,
          filled_count: 0,
          partial_count: 0,
          canceled_count: 0,
          error_count: 0,
          first_observed_at: null,
          last_observed_at: null,
        },
        decisions: {
          count: 0,
          placed_count: 0,
          skipped_count: 0,
          error_count: 0,
          first_decided_at: null,
          last_decided_at: null,
          top_reasons: [],
        },
      },
      completeness: {
        complete: false,
        account_position_truncated: false,
        targets_truncated: false,
        facts: [
          {
            source: "mirror_ledger" as const,
            status: "missing" as const,
            observed_at: null,
            complete: false,
          },
        ],
      },
    };
    expect(PolyResearchCopyTradeInvestigationResponseSchema.safeParse(base).success).toBe(true);
    expect(
      PolyResearchCopyTradeInvestigationResponseSchema.safeParse({
        ...base,
        association_sources: [],
      }).success
    ).toBe(false);
  });
});

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/tests/unit/app/dashboard/mirror-attempts-error-summary`
 * Purpose: Pin FAILURES_ARE_THE_POINT (bug.5279) — the ledger's adapter message must
 *          reduce to the CLOB's own words, not adapter boilerplate.
 * Scope: Pure function. No rendering, no network.
 * Side-effects: none
 * Links: app/src/app/(app)/dashboard/_components/MirrorAttemptsCard.tsx
 * @internal
 */

import type { PolyCopyTradeOrderRow } from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";

import {
  marketLabel,
  summarizeLedgerError,
} from "@/app/(app)/dashboard/_components/MirrorAttemptsCard";

const row = {
  market_id:
    "prediction-market:polymarket:0x8f9a4ff725d4f23ac1eea6c611a21193a629de0a6af74f8a28c08fef37908183",
  market_title: null,
} as PolyCopyTradeOrderRow;

describe("summarizeLedgerError (bug.5279)", () => {
  it("extracts the CLOB's own words from the real production message", () => {
    // Verbatim shape from prod once bug.5267 stopped discarding the body. If this
    // regresses, the dashboard shows adapter boilerplate and the operator is back
    // to querying Loki to learn that Polymarket geo-blocked us.
    const real =
      "PolymarketClobAdapter.placeOrder: CLOB rejected order (error_code=unknown, " +
      'response_keys=[error,status], reason="unknown", ' +
      'clob_error="Trading restricted in your region, please refer to available regions")';
    expect(summarizeLedgerError(real)).toBe(
      "Trading restricted in your region, please refer to available regions",
    );
  });

  it("falls back to reason when clob_error is absent", () => {
    expect(
      summarizeLedgerError(
        'CLOB rejected order (error_code=insufficient_balance, reason="insufficient_balance")',
      ),
    ).toBe("insufficient_balance");
  });

  it("passes through a plain message and truncates a flood", () => {
    expect(summarizeLedgerError("boom")).toBe("boom");
    const long = summarizeLedgerError("x".repeat(500));
    expect(long).toHaveLength(161); // 160 chars + ellipsis
  });

  it("returns null for no error so filled rows render blank", () => {
    expect(summarizeLedgerError(null)).toBeNull();
  });

  it("renders the canonical title and never falls back to outcome 0/1", () => {
    expect(
      marketLabel({ ...row, market_title: "Will the canonical market win?" }),
    ).toBe("Will the canonical market win?");
    expect(marketLabel({ ...row, market_title: "0", outcome: "0" })).toBe(
      "Market 0x8f9a4ff7…",
    );
  });
});

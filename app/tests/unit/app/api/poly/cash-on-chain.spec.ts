// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/poly/cash-on-chain.spec`
 * Purpose: Unit tests for `sumCashOnChain` — the null-safe USDC.e + pUSD cash
 *   combiner behind the wallet overview route.
 * Scope: Pure function tests. No HTTP, no DB, no RPC.
 * Invariants: pUSD is summed (pUSD-collateral bug regression guard); a single
 *   null leg never zeros a funded wallet; both-null degrades to null.
 * Side-effects: none
 * Links: src/app/api/v1/poly/wallet/_lib/cash-on-chain.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import {
  sumCashOnChain,
  sumWalletTotal,
} from "@/app/api/v1/poly/wallet/_lib/cash-on-chain";

describe("sumCashOnChain", () => {
  it("sums both cash legs when both read successfully", () => {
    expect(sumCashOnChain(10, 1132.4)).toBe(1142.4);
  });

  it("counts pUSD as spendable collateral when USDC.e is zero (the bug)", () => {
    // Real user wallet: USDC.e 0, pUSD $1,132.40. Must NOT report empty.
    expect(sumCashOnChain(0, 1132.4)).toBe(1132.4);
  });

  it("returns the pUSD balance when the USDC.e read failed (null)", () => {
    // A single failed leg must never zero out a funded wallet.
    expect(sumCashOnChain(null, 1132.4)).toBe(1132.4);
  });

  it("returns the USDC.e balance when the pUSD read failed (null)", () => {
    expect(sumCashOnChain(50, null)).toBe(50);
  });

  it("returns null only when neither leg read successfully", () => {
    expect(sumCashOnChain(null, null)).toBeNull();
  });

  it("returns 0 (not null) when both legs read as an empty wallet", () => {
    expect(sumCashOnChain(0, 0)).toBe(0);
  });
});

describe("sumWalletTotal", () => {
  it("withholds Total when positions are unknown", () => {
    // Cash remains independently visible as Available. Calling this cash-only
    // subtotal "Total" would under-report a wallet that holds positions.
    expect(sumWalletTotal(1132.4, null)).toBeNull();
  });

  it("adds marked-to-market positions to cash when both are known", () => {
    expect(sumWalletTotal(1132.4, 50)).toBe(1182.4);
  });

  it("returns 0 for a read-and-known-empty wallet", () => {
    expect(sumWalletTotal(0, 0)).toBe(0);
  });

  it("returns positions-only value when cash is zero", () => {
    expect(sumWalletTotal(0, 50)).toBe(50);
  });

  it("returns null whenever either half of the inventory is unknown", () => {
    expect(sumWalletTotal(null, 50)).toBeNull();
    expect(sumWalletTotal(50, null)).toBeNull();
    expect(sumWalletTotal(null, null)).toBeNull();
  });
});

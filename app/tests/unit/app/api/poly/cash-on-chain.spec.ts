// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/poly/cash-on-chain.spec`
 * Purpose: Unit tests for `sumCashOnChain` — the null-safe USDC.e + native USDC
 *   + pUSD cash combiner behind the wallet overview route.
 * Scope: Pure function tests. No HTTP, no DB, no RPC.
 * Invariants: pUSD is summed (pUSD-collateral bug regression guard); native
 *   USDC is summed (bug.5026 regression guard); a single null leg never zeros a
 *   funded wallet; all-null degrades to null.
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

  // bug.5026: native USDC is a third accepted deposit source. Omitting it
  // reported a native-USDC-funded wallet as empty (pUSD-bug shape).
  it("counts native USDC as spendable cash when USDC.e and pUSD are zero (bug.5026)", () => {
    // Real user wallet: native-USDC deposit only. Must NOT report empty.
    expect(sumCashOnChain(0, 0, 500)).toBe(500);
  });

  it("returns native USDC when the other two legs failed to read (null)", () => {
    // A single successful native-USDC leg must fund the wallet even when the
    // USDC.e and pUSD reads are null.
    expect(sumCashOnChain(null, null, 500)).toBe(500);
  });

  it("sums all three cash legs when all read successfully", () => {
    expect(sumCashOnChain(10, 1132.4, 500)).toBe(1642.4);
  });

  it("returns null only when ALL three legs read as null (RPC down)", () => {
    expect(sumCashOnChain(null, null, null)).toBeNull();
  });

  it("stays backward-compatible: native USDC defaults to absent (null)", () => {
    // Two-arg callers (pre-bug.5026) behave exactly as before.
    expect(sumCashOnChain(50, 100)).toBe(150);
    expect(sumCashOnChain(null, null)).toBeNull();
  });
});

describe("sumWalletTotal", () => {
  it("returns cash when positions are unknown (null) — the funded-wallet-shows-empty bug", () => {
    // Real user wallet: $1,132.40 cash, no cached positions (not a tracked
    // trader). usdc_total MUST be the cash, not null → dashboard is not "empty".
    expect(sumWalletTotal(1132.4, null)).toBe(1132.4);
  });

  it("adds marked-to-market positions to cash when both are known", () => {
    expect(sumWalletTotal(1132.4, 50)).toBe(1182.4);
  });

  it("returns 0 (not null) for a read-but-empty wallet with no positions", () => {
    expect(sumWalletTotal(0, null)).toBe(0);
  });

  it("returns positions-only value when cash is zero", () => {
    expect(sumWalletTotal(0, 50)).toBe(50);
  });

  it("returns null only when cash could not be read (RPC down)", () => {
    expect(sumWalletTotal(null, 50)).toBeNull();
    expect(sumWalletTotal(null, null)).toBeNull();
  });
});

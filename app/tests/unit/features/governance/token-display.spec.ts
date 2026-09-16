// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/token-display`
 * Purpose: Verifies governance token formatting stays exact and respects ERC20 decimals.
 * Scope: Pure unit tests only.
 * Invariants: No Number conversion of base-unit amounts; visible fractions are capped at four digits.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";

import { formatTokenAmount } from "@/features/governance/lib/token-display";

describe("formatTokenAmount", () => {
  it("formats 18-decimal token balances without losing a large whole value", () => {
    expect(formatTokenAmount(20_000n * 10n ** 18n, 18)).toBe(
      "20,000 tokens"
    );
  });

  it("uses the on-chain decimals and trims display precision", () => {
    expect(formatTokenAmount(1_234_567n, 6)).toBe("1.2345 tokens");
  });

  it("falls back to 18 decimals for an invalid decimals response", () => {
    expect(formatTokenAmount(10n ** 18n, -1)).toBe("1 tokens");
  });
});

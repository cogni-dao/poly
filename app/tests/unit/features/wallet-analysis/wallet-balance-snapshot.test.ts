// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { classifyWalletBalanceStatus } from "@/features/wallet-analysis/server/wallet-balance-snapshot-service";

describe("classifyWalletBalanceStatus", () => {
  it("treats fresh numeric zeroes as complete data", () => {
    expect(
      classifyWalletBalanceStatus({ usdcE: 0, pusd: 0, pol: 0, errors: [] })
    ).toBe("ok");
  });

  it("distinguishes one failed leg from total unavailability", () => {
    expect(
      classifyWalletBalanceStatus({
        usdcE: null,
        pusd: 3.78,
        pol: 0.2,
        errors: ["usdce_rpc unavailable"],
      })
    ).toBe("partial");
    expect(
      classifyWalletBalanceStatus({
        usdcE: null,
        pusd: null,
        pol: null,
        errors: ["polygon rpc unavailable"],
      })
    ).toBe("error");
  });
});

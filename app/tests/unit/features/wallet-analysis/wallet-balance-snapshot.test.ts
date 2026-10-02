// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  classifyWalletBalanceStatus,
  refreshWalletBalanceFacts,
} from "@/features/wallet-analysis/server/wallet-balance-snapshot-service";

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

describe("refreshWalletBalanceFacts", () => {
  it("caps concurrency at three and isolates one tenant failure", async () => {
    const wallets = Array.from({ length: 7 }, (_, index) => ({
      billingAccountId: `account-${index}`,
      address: `0x${index.toString(16).padStart(40, "0")}` as `0x${string}`,
    }));
    let active = 0;
    let maxActive = 0;
    const persisted: string[] = [];
    const result = await refreshWalletBalanceFacts({
      wallets,
      concurrency: 3,
      read: async (billingAccountId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        if (billingAccountId === "account-2") throw new Error("rpc failed");
        const wallet = wallets.find(
          (candidate) => candidate.billingAccountId === billingAccountId
        );
        return {
          address: wallet?.address ?? wallets[0]!.address,
          usdcE: 0,
          pusd: 1,
          pol: 0.1,
          errors: [],
        };
      },
      persist: async (fact) => {
        persisted.push(fact.billingAccountId);
      },
    });

    expect(maxActive).toBeLessThanOrEqual(3);
    expect(result).toEqual({ succeeded: 6, failed: 1 });
    expect(persisted).toHaveLength(6);
    expect(persisted).toContain("account-6");
  });
});

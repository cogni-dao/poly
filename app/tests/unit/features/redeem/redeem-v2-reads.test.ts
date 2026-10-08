// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Redemption discovery must use cursor-complete Data API V2 reads. */
import { describe, expect, it, vi } from "vitest";

import { runRedeemCatchup } from "@/features/redeem/redeem-catchup";
import { runRedeemDiffTick } from "@/features/redeem/redeem-diff";
import { resolveRedeemCandidatesForCondition } from "@/features/redeem/resolve-redeem-decision";

const FUNDER = "0x1111111111111111111111111111111111111111" as const;
const CONDITION = `0x${"12".repeat(32)}` as `0x${string}`;

function v2OnlyClient() {
  return {
    listUserPositions: vi.fn(() => {
      throw new Error("legacy v1 read must not run");
    }),
    listAllUserPositions: vi.fn(() => {
      throw new Error("legacy v1 walk must not run");
    }),
    listUserPositionsV2: vi.fn(async () => []),
    listAllUserPositionsV2: vi.fn(async () => []),
  };
}

describe("redemption Data API reads", () => {
  it("uses a condition-scoped V2 read for classification", async () => {
    const dataApiClient = v2OnlyClient();

    await expect(
      resolveRedeemCandidatesForCondition({
        funderAddress: FUNDER,
        conditionId: CONDITION,
        publicClient: { multicall: vi.fn() } as never,
        dataApiClient: dataApiClient as never,
      })
    ).resolves.toEqual([]);

    expect(dataApiClient.listUserPositionsV2).toHaveBeenCalledWith(FUNDER, {
      conditions: [CONDITION],
    });
    expect(dataApiClient.listUserPositions).not.toHaveBeenCalled();
  });

  it("uses an unscoped cursor-complete V2 walk for the periodic diff", async () => {
    const dataApiClient = v2OnlyClient();
    await runRedeemDiffTick({
      dataApiClient: dataApiClient as never,
      funderAddress: FUNDER,
      redeemJobs: {
        listKnownConditionsForFunder: vi.fn(async () => []),
      } as never,
      subscriber: { enqueueForCondition: vi.fn() } as never,
      log: { info: vi.fn() } as never,
    });

    expect(dataApiClient.listAllUserPositionsV2).toHaveBeenCalledWith(FUNDER);
    expect(dataApiClient.listAllUserPositions).not.toHaveBeenCalled();
  });

  it("uses one unscoped V2 walk per condition-resolution catch-up chunk", async () => {
    const dataApiClient = v2OnlyClient();
    const enqueueForCondition = vi.fn(async () => undefined);
    const getLastProcessedBlock = vi.fn(async (cursor: string) =>
      cursor === "ctf_resolution" ? 0n : 1n
    );
    await runRedeemCatchup({
      dataApiClient: dataApiClient as never,
      funderAddress: FUNDER,
      initialFromBlock: 0n,
      publicClient: {
        getBlockNumber: vi.fn(async () => 1n),
        getLogs: vi.fn(async () => [
          { removed: false, topics: ["0xtopic", CONDITION] },
        ]),
      } as never,
      redeemJobs: {
        getLastProcessedBlock,
        setLastProcessedBlock: vi.fn(async () => undefined),
      } as never,
      subscriber: { enqueueForCondition } as never,
      orderLedger: {} as never,
      billingAccountId: "billing-1",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(dataApiClient.listAllUserPositionsV2).toHaveBeenCalledWith(FUNDER);
    expect(dataApiClient.listAllUserPositions).not.toHaveBeenCalled();
    expect(enqueueForCondition).toHaveBeenCalledWith(CONDITION, []);
  });
});

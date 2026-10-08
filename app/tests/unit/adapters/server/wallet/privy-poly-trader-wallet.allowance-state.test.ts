// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { isVerifiedPusdAllowanceState } from "@/adapters/server/wallet";

const FUNDER = "0x2222222222222222222222222222222222222222" as const;
const MAX_UINT256 =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

function verifiedState() {
  return {
    kind: "polymarket_pusd_buy_allowances_v1",
    chainId: 137,
    funderAddress: FUNDER,
    tokenAddress: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
    verifiedAt: "2026-10-08T10:09:00.000Z",
    spenders: [
      {
        address: "0xE111180000d2663C0091e4f400237545B87B996B",
        allowanceAtomic: MAX_UINT256,
      },
      {
        address: "0xe2222d279d744050d28e00520010520000310F59",
        allowanceAtomic: MAX_UINT256,
      },
      {
        address: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
        allowanceAtomic: MAX_UINT256,
      },
    ],
  };
}

describe("isVerifiedPusdAllowanceState", () => {
  it("accepts only a post-verified snapshot covering every BUY spender", () => {
    expect(isVerifiedPusdAllowanceState(verifiedState(), FUNDER)).toBe(true);
  });

  it("invalidates a timestamp-era row that never recorded on-chain evidence", () => {
    expect(isVerifiedPusdAllowanceState(null, FUNDER)).toBe(false);
    expect(
      isVerifiedPusdAllowanceState({ approved: true, checkedAt: "old" }, FUNDER)
    ).toBe(false);
  });

  it("fails closed instead of throwing on malformed persisted JSON", () => {
    expect(
      isVerifiedPusdAllowanceState(
        { ...verifiedState(), funderAddress: 137 },
        FUNDER
      )
    ).toBe(false);
  });

  it("invalidates the production state with zero legacy adapter allowance", () => {
    const state = verifiedState();
    state.spenders[2] = {
      ...state.spenders[2],
      allowanceAtomic: "0",
    };

    expect(isVerifiedPusdAllowanceState(state, FUNDER)).toBe(false);
  });
});

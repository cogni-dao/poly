// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/tests/polymarket-exchange`
 * Purpose: Pin the `OrderFilled` ABI signature to the deployed contract's keccak topic0 so any drift in the ABI string fails CI before producing another silent-zero-events outage (bug.5049).
 * Scope: Pure — no RPC. Computes keccak from the parsed ABI and asserts equality with the captured on-chain topic0.
 * Invariants: keccak256(eventSignature(polymarketExchangeOrderFilledAbi)) === POLY_ORDERFILLED_TOPIC0.
 * Side-effects: none
 * Links: src/adapters/polymarket/polymarket.exchange.ts, work/items/bug.5049
 * @internal
 */

import { describe, expect, it } from "vitest";
import { getAbiItem, keccak256, stringToBytes, toEventSelector } from "viem";

import {
  POLY_ORDERFILLED_TOPIC0,
  POLY_ORDERFILLED_TOPIC0_COMPUTED,
  polymarketExchangeOrderFilledAbi,
} from "../src/adapters/polymarket/polymarket.exchange.js";

describe("polymarketExchangeOrderFilledAbi", () => {
  it("keccak256 of the parsed ABI's event signature equals the on-chain topic0", () => {
    // bug.5049 regression: an earlier ABI string had only 8 fields with the
    // 4th as uint256 instead of uint8; its keccak hash did NOT match the
    // deployed contract's topic0, so viem's RPC topic filter rejected every
    // OrderFilled event. This test would have caught that before merge.
    const item = getAbiItem({
      abi: polymarketExchangeOrderFilledAbi,
      name: "OrderFilled",
    });
    expect(item).toBeDefined();
    const topic = toEventSelector(item!);
    expect(topic).toBe(POLY_ORDERFILLED_TOPIC0);
  });

  it("module-level computed constant matches the pinned topic0", () => {
    expect(POLY_ORDERFILLED_TOPIC0_COMPUTED).toBe(POLY_ORDERFILLED_TOPIC0);
  });

  it("matches the on-chain topic0 from real swisstony tx 0x622ee0… (Polygon mainnet)", () => {
    // The constant is the topic0 captured from this exact production trade.
    // If anyone changes POLY_ORDERFILLED_TOPIC0, this test forces a fresh
    // capture from a real Polygon receipt rather than a silent edit.
    const observed = keccak256(
      stringToBytes(
        "OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)"
      )
    );
    expect(observed).toBe(POLY_ORDERFILLED_TOPIC0);
  });
});

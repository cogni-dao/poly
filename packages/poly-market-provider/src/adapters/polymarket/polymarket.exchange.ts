// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/adapters/polymarket/exchange`
 * Purpose: Polymarket CTF Exchange V2 + NegRisk Exchange V2 read surface on Polygon — pinned mainnet contract addresses + `OrderFilled` event ABI. Consumed by the chain-driven wallet-watch source (task.5043) to receive target-fill notifications in ~2s instead of the ~5min Data-API drain.
 * Scope: Constants + ABI fragments only. No client, no signer, no transaction submission. Sibling to `polymarket.ctf.ts` (which holds the ConditionalTokens redeem surface).
 * Invariants:
 *   - POLYGON_MAINNET_V2_ONLY — addresses pinned to chain id 137, V2 contracts only.
 *   - ORDERFILLED_SHAPE_PINNED — keccak256 of the event signature MUST equal `POLY_ORDERFILLED_TOPIC0` (verified against the deployed contracts via `eth_getTransactionReceipt` + openchain.xyz lookup). If parseAbi here drifts from the deployed shape, the RPC-layer topic filter matches zero events and the chain wallet-watch source goes silent — bug.5049.
 *   - SIDE_IS_ENUM_FROM_PARAMS_MAKER — the `side` field is the Side enum (0=BUY, 1=SELL) for whichever party occupies the `maker` slot of the `OrderFilledParams` struct, NOT a global match direction. The contract emits one event per party per match, so filtering on `maker = target_wallet` catches every target trade and `side` is target's order side directly.
 * Side-effects: none (pure constants + parseAbi)
 * Links: docs/spec/poly-tenant-and-collateral.md (V2 cutover), work/items/bug.5049, https://sourcify.dev/server/files/any/137/0xE111180000d2663C0091e4f400237545B87B996B
 * @public
 */

import { keccak256, parseAbi, stringToBytes } from "viem";

/** Polymarket CTF Exchange V2 — regular (non-neg-risk) markets on Polygon. */
export const POLYGON_POLYMARKET_EXCHANGE_V2 =
  "0xE111180000d2663C0091e4f400237545B87B996B" as const;

/** Polymarket NegRisk CTF Exchange V2 — multi-outcome (event) markets on Polygon. */
export const POLYGON_POLYMARKET_NEG_RISK_EXCHANGE_V2 =
  "0xe2222d279d744050d28e00520010520000310F59" as const;

/**
 * Canonical `keccak256` of the deployed `OrderFilled` event signature on both
 * V2 exchange contracts. Observed on-chain (e.g. tx
 * `0x622ee0123a0dc9ca3f79c6d6638de7c1ffeebdae03f0a3f1a5fa091816e16c9f`) and
 * cross-checked at openchain.xyz. The unit test in this package pins
 * `keccak256(parseAbiItem(...).signature)` to this constant so any ABI drift
 * fails CI before producing another silent-zero-events outage (bug.5049).
 */
export const POLY_ORDERFILLED_TOPIC0 =
  "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee" as const;

/**
 * `OrderFilled` event — emitted by both V2 exchange contracts on every match.
 * Per the deployed contract source (Sourcify partial match):
 *
 *   event OrderFilled(
 *     bytes32 indexed orderHash,
 *     address indexed maker,
 *     address indexed taker,
 *     Side    side,                 // uint8 enum: 0=BUY, 1=SELL — maker's side
 *     uint256 tokenId,              // single CTF outcome tokenId (other side is implicit USDC)
 *     uint256 makerAmountFilled,    // 6-dec integer
 *     uint256 takerAmountFilled,    // 6-dec integer
 *     uint256 fee,                  // 6-dec integer, in maker-out token
 *     bytes32 builder,              // EIP-712 relayer/builder hash, often zero
 *     bytes32 metadata              // EIP-712 metadata hash, often zero
 *   );
 *
 * Two events fire per match (one per party): one with maker=A,taker=B and
 * one with maker=B,taker=<exchange-contract-self> from `_emitTakerFilledEvents`.
 * Consumers should filter on `maker = target_wallet` and read `side` directly.
 */
export const polymarketExchangeOrderFilledAbi = parseAbi([
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee, bytes32 builder, bytes32 metadata)",
]);

/**
 * @internal Computed at module load so tests can assert the ABI string and
 * deployed topic0 stay in sync. Equal to `POLY_ORDERFILLED_TOPIC0` when
 * `polymarketExchangeOrderFilledAbi` is correctly aligned with the deployed
 * contracts.
 */
export const POLY_ORDERFILLED_TOPIC0_COMPUTED = keccak256(
  stringToBytes(
    "OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)"
  )
);

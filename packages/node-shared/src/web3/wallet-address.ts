// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/node-shared/web3/wallet-address`
 * Purpose: The one canonical key for a wallet: its lowercase hex address.
 * Scope: Pure string normalization. EIP-55 casing is an input checksum the caller verifies (SIWE does) before calling this; it is never stored or compared.
 * Invariants: ONE_WALLET_ONE_KEY (identity-keys-no-overload): `user_bindings` wallet rows, the admin check, claimant resolution and the payout guard all key a wallet by this value.
 * Side-effects: none
 * @public
 */

/** The canonical wallet key: lowercase. */
export function normalizeWalletAddress(address: string): string {
  return address.trim().toLowerCase();
}

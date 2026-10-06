// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/funder-only-identity`
 * Purpose: Amendment 2 — a connection with no `funder_address` is unprovisioned,
 *   never the Privy signer EOA.
 * Scope: The two read paths that used to `COALESCE(funder_address, address)`.
 *   The adapter-side chokepoint is covered by its own suite.
 * Invariants: an absent funder reads as `no_wallet` / `address: null`; it never
 *   yields a usable-looking address and never yields the signer.
 * Side-effects: none
 * Links: docs/porting/poly-parity-contract.md (Amendment 2)
 */

import { describe, expect, it } from "vitest";
import { readWalletBalanceFact } from "@/features/wallet-analysis/server/wallet-balance-snapshot-service";

const FUNDER = "0x8ca45685c5827f7acfdd890214180c4ea9d0bf58";
const SIGNER = "0x1111111111111111111111111111111111111111";

/** Minimal drizzle-shaped stub: the chain ends at `.limit()` returning rows. */
function dbReturning(rows: unknown[]) {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: async () => rows,
  };
  return { select: () => chain } as never;
}

describe("Amendment 2 — wallet balance fact resolves funder only", () => {
  it("reads no_wallet when the connection has no funder address", async () => {
    // The row EXISTS — this is the pre-0066 connection whose deposit wallet was
    // never created. Before Amendment 2 it fell through as `missing` at a null
    // address, i.e. a wallet that reads as real but has nowhere to be.
    const read = await readWalletBalanceFact(
      dbReturning([{ address: null, snapshot: null }]),
      "account-1"
    );
    expect(read).toEqual({ kind: "no_wallet" });
  });

  it("never substitutes the signer address for an absent funder", async () => {
    const read = await readWalletBalanceFact(
      dbReturning([{ address: null, snapshot: null }]),
      "account-1"
    );
    expect(JSON.stringify(read)).not.toContain(SIGNER);
  });

  it("still reports a provisioned funder whose snapshot has not landed", async () => {
    const read = await readWalletBalanceFact(
      dbReturning([{ address: FUNDER, snapshot: null }]),
      "account-1"
    );
    expect(read).toEqual({ kind: "missing", address: FUNDER });
  });
});

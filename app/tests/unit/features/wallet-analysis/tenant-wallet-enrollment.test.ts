// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/tenant-wallet-enrollment`
 * Purpose: Prove OBSERVE_THE_FUNDER — `syncActiveTenantWallets` enrolls the
 *          address that actually holds Polymarket positions (`funder_address`)
 *          rather than the Privy signer EOA (`address`).
 * Scope: Unit test over a thenable-chain fake db that records the rows handed
 *        to `.values()`. No SQL executes; what is under test is *which value*
 *        the enrollment writes, which the recorded payload proves exactly.
 * Invariants:
 *   - FUNDER_WINS: `funder_address` present → it is the enrolled wallet, and
 *     the signer EOA is never enrolled.
 *   - PRE_V2_FALLBACK: `funder_address` null → `address` is enrolled, so
 *     connections minted before the V2 split keep working.
 *   - DEDUPED: two connections resolving to one funder enroll one row.
 * Side-effects: none
 * Links: src/features/wallet-analysis/server/trader-observation-service.ts,
 *        src/adapters/server/wallet/privy-poly-trader-wallet.adapter.ts
 * @public
 */

import { describe, expect, it } from "vitest";
import { syncActiveTenantWallets } from "@/features/wallet-analysis/server/trader-observation-service";

type Connection = { address: string; funderAddress: string | null };

const SIGNER = `0x${"d9".repeat(20)}`;
const FUNDER = `0x${"8c".repeat(20)}`;
const LEGACY = `0x${"3d".repeat(20)}`;

/**
 * Thenable-chain fake db: selects resolve the seeded connection rows, and
 * every `.values()` payload is recorded so the test can assert the enrolled
 * wallet addresses.
 */
function createFakeDb(connections: readonly Connection[]) {
  const insertedValues: Array<Array<{ walletAddress: string }>> = [];
  const makeChain = (kind: "select" | "insert" | "update") => {
    // biome-ignore lint/suspicious/noExplicitAny: duck-typed drizzle chain
    const chain: any = {};
    for (const method of [
      "from",
      "where",
      "orderBy",
      "limit",
      "onConflictDoNothing",
      "onConflictDoUpdate",
      "set",
      "returning",
    ]) {
      chain[method] = () => chain;
    }
    chain.values = (rows: Array<{ walletAddress: string }>) => {
      insertedValues.push(rows);
      return chain;
    };
    // biome-ignore lint/suspicious/noThenProperty: fake drizzle chain must be thenable to emulate awaitable query builders
    chain.then = (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (err: unknown) => unknown
    ) =>
      Promise.resolve(kind === "select" ? connections : []).then(
        onFulfilled,
        onRejected
      );
    return chain;
  };
  const db = {
    select: () => makeChain("select"),
    insert: () => makeChain("insert"),
    update: () => makeChain("update"),
  };
  return { db: db as never, insertedValues };
}

function enrolledAddresses(
  insertedValues: Array<Array<{ walletAddress: string }>>
): string[] {
  return insertedValues.flat().map((row) => row.walletAddress);
}

describe("syncActiveTenantWallets — OBSERVE_THE_FUNDER", () => {
  it("enrolls the funder, not the signer EOA, for a V2 connection", async () => {
    const { db, insertedValues } = createFakeDb([
      { address: SIGNER, funderAddress: FUNDER },
    ]);

    await syncActiveTenantWallets(db);

    // The funder is the wallet every dashboard/research read resolves via
    // `getAddress()` (`funder_address ?? address`); enrolling the signer left
    // the position read model with no row and blanked the dashboard.
    expect(enrolledAddresses(insertedValues)).toEqual([FUNDER.toLowerCase()]);
    expect(enrolledAddresses(insertedValues)).not.toContain(
      SIGNER.toLowerCase()
    );
  });

  it("falls back to the signer address when no funder is set", async () => {
    const { db, insertedValues } = createFakeDb([
      { address: LEGACY, funderAddress: null },
    ]);

    await syncActiveTenantWallets(db);

    expect(enrolledAddresses(insertedValues)).toEqual([LEGACY.toLowerCase()]);
  });

  it("enrolls one row when two connections resolve to the same funder", async () => {
    const { db, insertedValues } = createFakeDb([
      { address: SIGNER, funderAddress: FUNDER },
      { address: LEGACY, funderAddress: FUNDER },
    ]);

    await syncActiveTenantWallets(db);

    expect(enrolledAddresses(insertedValues)).toEqual([FUNDER.toLowerCase()]);
  });

  it("writes nothing when there are no active connections", async () => {
    const { db, insertedValues } = createFakeDb([]);

    await syncActiveTenantWallets(db);

    expect(insertedValues).toEqual([]);
  });
});

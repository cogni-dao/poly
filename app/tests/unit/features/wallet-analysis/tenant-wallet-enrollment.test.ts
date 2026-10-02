// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/tenant-wallet-enrollment`
 * Purpose: Prove OBSERVE_WHAT_THE_EXECUTOR_SIGNS_FROM — `syncActiveTenantWallets`
 *          enrolls exactly the addresses the injected port reader returns, and
 *          derives nothing itself.
 * Scope: Unit test over a thenable-chain fake db that records the rows handed
 *        to `.values()`. No SQL executes; what is under test is *which*
 *        addresses the enrollment writes, which the recorded payload proves.
 *        The address *resolution* is the adapter's and is proven there.
 * Invariants:
 *   - PORT_IS_THE_SOURCE: whatever the reader returns is what gets enrolled —
 *     no local re-derivation from `poly_wallet_connections`.
 *   - RETIRES_THE_REST: addresses absent from the reader are swept by
 *     `disableMissingTenantWallets`, which is how stale signer-EOA rows go.
 *   - EMPTY_IS_NOT_A_WIPE_SKIP: zero active tenants still runs the sweep.
 * Side-effects: none
 * Links: src/features/wallet-analysis/server/trader-observation-service.ts,
 *        packages/poly-wallet/src/port/poly-trader-wallet.port.ts
 * @public
 */

import { describe, expect, it } from "vitest";
import { syncActiveTenantWallets } from "@/features/wallet-analysis/server/trader-observation-service";

const FUNDER_A = `0x${"8c".repeat(20)}`.toLowerCase();
const FUNDER_B = `0x${"3d".repeat(20)}`.toLowerCase();

/**
 * Thenable-chain fake db: records every `.values()` payload (the enrollment
 * upsert) and every `.set()` payload (the disable sweep) so the test can
 * assert both halves of the sync.
 */
function createFakeDb() {
  const insertedValues: Array<Array<{ walletAddress: string }>> = [];
  const updateSets: unknown[] = [];
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
      "returning",
    ]) {
      chain[method] = () => chain;
    }
    chain.values = (rows: Array<{ walletAddress: string }>) => {
      insertedValues.push(rows);
      return chain;
    };
    chain.set = (payload: unknown) => {
      if (kind === "update") updateSets.push(payload);
      return chain;
    };
    // biome-ignore lint/suspicious/noThenProperty: fake drizzle chain must be thenable to emulate awaitable query builders
    chain.then = (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (err: unknown) => unknown
    ) => Promise.resolve([]).then(onFulfilled, onRejected);
    return chain;
  };
  const db = {
    select: () => makeChain("select"),
    insert: () => makeChain("insert"),
    update: () => makeChain("update"),
  };
  return { db: db as never, insertedValues, updateSets };
}

const enrolled = (
  insertedValues: Array<Array<{ walletAddress: string }>>
): string[] => insertedValues.flat().map((row) => row.walletAddress);

describe("syncActiveTenantWallets — OBSERVE_WHAT_THE_EXECUTOR_SIGNS_FROM", () => {
  it("enrolls exactly what the port reader returns", async () => {
    const { db, insertedValues } = createFakeDb();

    await syncActiveTenantWallets(db, async () => [FUNDER_A, FUNDER_B]);

    expect(enrolled(insertedValues)).toEqual([FUNDER_A, FUNDER_B]);
  });

  it("marks every enrolled wallet active for research", async () => {
    const { db, insertedValues } = createFakeDb();

    await syncActiveTenantWallets(db, async () => [FUNDER_A]);

    // A row that exists but is `active_for_research = false` is invisible to
    // `readCurrentWalletPositionModel`, which is the same blank dashboard.
    expect(insertedValues.flat()[0]).toMatchObject({
      walletAddress: FUNDER_A,
      kind: "cogni_wallet",
      activeForResearch: true,
      disabledAt: null,
    });
  });

  it("runs the retire sweep and enrolls nothing when no tenant is active", async () => {
    const { db, insertedValues, updateSets } = createFakeDb();

    await syncActiveTenantWallets(db, async () => []);

    expect(insertedValues).toEqual([]);
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toMatchObject({ activeForResearch: false });
  });

  it("retires wallets the reader no longer lists", async () => {
    const { db, updateSets } = createFakeDb();

    await syncActiveTenantWallets(db, async () => [FUNDER_A]);

    // The sweep is what removes a pre-V2 signer-EOA row once the funder has
    // taken its place.
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toMatchObject({ activeForResearch: false });
  });
});

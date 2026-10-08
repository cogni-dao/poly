// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/paper-account-kind.int.test`
 * Purpose: Prove migration 0082 — the `kind` discriminator on
 *   `poly_wallet_connections` — widens the table for paper accounts without
 *   weakening one live-row guarantee, and that `provisionPaperAccount` writes
 *   a usable account through the app role under RLS.
 * Scope: Real Postgres, both the service role (constraint matrix) and the app
 *   role (RLS + the provisioning path). No HTTP, no Privy, no chain.
 * Invariants:
 *   - LIVE_ROW_CUSTODY_COMPLETE — the three custody columns became nullable
 *     for paper, so the only thing standing between a live row and missing
 *     custody is the new CHECK. If that CHECK is ever dropped the table
 *     silently accepts a live wallet that cannot sign, which would surface as
 *     a runtime `aeadDecrypt(null)` throw deep in the signing path rather than
 *     as a write failure. Asserting the rejection is the whole point of this
 *     file.
 *   - ONE_ACTIVE_ROW_PER_KIND — the partial unique index moved from
 *     (billing_account_id) to (billing_account_id, kind). Both halves matter:
 *     a tenant MAY hold one live + one paper row, and MAY NOT hold two of
 *     either.
 *   - PAPER_SEED_DECLARED — a paper row without a seed, or a live row carrying
 *     one, is a fabricated value and must not be storable.
 *   - GRANT_OR_NOTHING — `authorizeIntent` fail-closes on a missing grant, so
 *     a paper connection written without one is a soft-bricked account.
 *   - TENANT_ISOLATED — a paper row is exactly as isolated as a live one;
 *     `kind` is not an RLS key and must not become an escape hatch.
 * Side-effects: IO (testcontainers Postgres)
 * Links: migrations/0082_poly_paper_accounts.sql, docs/spec/capability-plane.md
 * @internal
 */

import { randomUUID } from "node:crypto";
import { toUserId, userActor } from "@cogni/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/adapters/server/db/client";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import {
  derivePaperAccountAddress,
  provisionPaperAccount,
} from "@/features/paper-accounts";
import {
  billingAccounts,
  polyWalletConnections,
  polyWalletGrants,
  users,
} from "@/shared/db/schema";

type Tenant = { userId: string; billingAccountId: string; name: string };

function tenant(name: string): Tenant {
  return { userId: randomUUID(), billingAccountId: randomUUID(), name };
}

/** A random, correctly-shaped EVM address. */
function address(): `0x${string}` {
  const hex = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
  return `0x${hex.slice(0, 40)}` as `0x${string}`;
}

/** A complete live row — every custody column populated, as pre-0082. */
function liveRow(owner: Tenant, overrides: Record<string, unknown> = {}) {
  return {
    billingAccountId: owner.billingAccountId,
    createdByUserId: owner.userId,
    privyWalletId: `privy-${randomUUID()}`,
    address: address(),
    clobApiKeyCiphertext: Buffer.from("ciphertext"),
    encryptionKeyId: "test-key",
    custodialConsentAcceptedAt: new Date("2026-10-01T00:00:00.000Z"),
    custodialConsentActorKind: "user",
    custodialConsentActorId: owner.userId,
    ...overrides,
  };
}

describe("paper accounts as a connection kind (migration 0082)", () => {
  let db: Database;
  const legacy = tenant("Pre-0082 live tenant");
  const paperOnly = tenant("Paper-only tenant");
  const both = tenant("Live + paper tenant");
  const rejects = tenant("Constraint-matrix tenant");
  const isolatedA = tenant("Isolation tenant A");
  const isolatedB = tenant("Isolation tenant B");

  const tenants = [legacy, paperOnly, both, rejects, isolatedA, isolatedB];

  beforeAll(async () => {
    db = getAppDb();
    const seedDb = getSeedDb();

    await seedDb.insert(users).values(
      tenants.map((entry) => ({
        id: entry.userId,
        name: entry.name,
        walletAddress: address(),
      }))
    );
    await seedDb.insert(billingAccounts).values(
      tenants.map((entry) => ({
        id: entry.billingAccountId,
        ownerUserId: entry.userId,
        balanceCredits: 0n,
      }))
    );
  });

  describe("existing live rows keep working", () => {
    it("(a) accepts a complete live row and defaults it to kind='privy_live'", async () => {
      const seedDb = getSeedDb();
      // Note the insert deliberately does NOT mention `kind`. Every row
      // written before 0082 — and every test fixture in this repo — omits it,
      // so the column DEFAULT is what keeps them valid.
      const [row] = await seedDb
        .insert(polyWalletConnections)
        .values(liveRow(legacy))
        .returning({
          id: polyWalletConnections.id,
          kind: polyWalletConnections.kind,
          paperSeedUsdc: polyWalletConnections.paperSeedUsdc,
        });

      expect(row?.kind).toBe("privy_live");
      expect(row?.paperSeedUsdc).toBeNull();
    });
  });

  describe("the constraint matrix", () => {
    it("(b) accepts a paper row with NULL Privy/AEAD columns", async () => {
      const seedDb = getSeedDb();
      const paperAddress = derivePaperAccountAddress(
        paperOnly.billingAccountId
      );
      const [row] = await seedDb
        .insert(polyWalletConnections)
        .values({
          billingAccountId: paperOnly.billingAccountId,
          createdByUserId: paperOnly.userId,
          kind: "paper",
          privyWalletId: null,
          clobApiKeyCiphertext: null,
          encryptionKeyId: null,
          address: paperAddress,
          funderAddress: paperAddress,
          paperSeedUsdc: "1000.00000000",
          custodialConsentAcceptedAt: new Date("2026-10-07T00:00:00.000Z"),
          custodialConsentActorKind: "user",
          custodialConsentActorId: paperOnly.userId,
          tradingApprovalsReadyAt: new Date("2026-10-07T00:00:00.000Z"),
        })
        .returning({
          id: polyWalletConnections.id,
          kind: polyWalletConnections.kind,
          privyWalletId: polyWalletConnections.privyWalletId,
          clobApiKeyCiphertext: polyWalletConnections.clobApiKeyCiphertext,
          encryptionKeyId: polyWalletConnections.encryptionKeyId,
          paperSeedUsdc: polyWalletConnections.paperSeedUsdc,
        });

      expect(row?.kind).toBe("paper");
      expect(row?.privyWalletId).toBeNull();
      expect(row?.clobApiKeyCiphertext).toBeNull();
      expect(row?.encryptionKeyId).toBeNull();
      expect(row?.paperSeedUsdc).toBe("1000.00000000");
    });

    it("(c) REJECTS a live row with NULL Privy/AEAD columns", async () => {
      const seedDb = getSeedDb();
      // Each of the three columns is checked independently: a single combined
      // CHECK could be satisfied by any one of them and still let the other
      // two through, so assert all three one at a time.
      const nullings = [
        { privyWalletId: null },
        { clobApiKeyCiphertext: null },
        { encryptionKeyId: null },
      ] as const;

      for (const nulled of nullings) {
        await expect(
          seedDb
            .insert(polyWalletConnections)
            .values(liveRow(rejects, { kind: "privy_live", ...nulled }))
        ).rejects.toThrow(
          /poly_wallet_connections_live_requires_custody|violates check constraint/i
        );
      }
    });

    it("rejects an unknown kind", async () => {
      const seedDb = getSeedDb();
      await expect(
        seedDb
          .insert(polyWalletConnections)
          .values(liveRow(rejects, { kind: "margin" }))
      ).rejects.toThrow(
        /poly_wallet_connections_kind_check|violates check constraint/i
      );
    });

    it("rejects a paper row with no declared seed", async () => {
      const seedDb = getSeedDb();
      const addr = address();
      await expect(
        seedDb.insert(polyWalletConnections).values({
          billingAccountId: rejects.billingAccountId,
          createdByUserId: rejects.userId,
          kind: "paper",
          privyWalletId: null,
          clobApiKeyCiphertext: null,
          encryptionKeyId: null,
          address: addr,
          funderAddress: addr,
          // PAPER_SEED_DECLARED: omitted on purpose.
          custodialConsentAcceptedAt: new Date(),
          custodialConsentActorKind: "user",
          custodialConsentActorId: rejects.userId,
        })
      ).rejects.toThrow(
        /poly_wallet_connections_paper_seed_usdc|violates check constraint/i
      );
    });

    it("rejects a live row that carries a simulated seed", async () => {
      const seedDb = getSeedDb();
      await expect(
        seedDb
          .insert(polyWalletConnections)
          .values(liveRow(rejects, { paperSeedUsdc: "500.00000000" }))
      ).rejects.toThrow(
        /poly_wallet_connections_paper_seed_usdc|violates check constraint/i
      );
    });
  });

  describe("one active row per (tenant, kind)", () => {
    it("(d) lets one account hold a live AND a paper row at once", async () => {
      const seedDb = getSeedDb();
      const paperAddress = derivePaperAccountAddress(both.billingAccountId);

      await seedDb.insert(polyWalletConnections).values(liveRow(both));
      await seedDb.insert(polyWalletConnections).values({
        billingAccountId: both.billingAccountId,
        createdByUserId: both.userId,
        kind: "paper",
        privyWalletId: null,
        clobApiKeyCiphertext: null,
        encryptionKeyId: null,
        address: paperAddress,
        funderAddress: paperAddress,
        paperSeedUsdc: "250.00000000",
        custodialConsentAcceptedAt: new Date(),
        custodialConsentActorKind: "user",
        custodialConsentActorId: both.userId,
        tradingApprovalsReadyAt: new Date(),
      });

      const rows = await seedDb
        .select({ kind: polyWalletConnections.kind })
        .from(polyWalletConnections)
        .where(
          eq(polyWalletConnections.billingAccountId, both.billingAccountId)
        );

      expect(rows.map((r) => r.kind).sort()).toEqual(["paper", "privy_live"]);
    });

    it("still refuses a SECOND active row of the same kind", async () => {
      const seedDb = getSeedDb();
      // `both` already has an active live row from the previous test. The
      // index widened to (billing_account_id, kind) — it did not go away.
      await expect(
        seedDb.insert(polyWalletConnections).values(liveRow(both))
      ).rejects.toThrow(
        /poly_wallet_connections_tenant_active_idx|duplicate key value/i
      );
    });
  });

  describe("provisionPaperAccount through the app role", () => {
    it("writes the connection and its grant in one transaction", async () => {
      const result = await withTenantScope(
        db,
        userActor(toUserId(isolatedA.userId)),
        (tx) =>
          provisionPaperAccount(tx, {
            billingAccountId: isolatedA.billingAccountId,
            createdByUserId: isolatedA.userId,
            actorKind: "user",
            actorId: isolatedA.userId,
            seedUsdc: 500,
            defaultGrant: { perOrderUsdcCap: 5, dailyUsdcCap: 50 },
          })
      );

      expect(result.created).toBe(true);
      expect(result.address).toBe(
        derivePaperAccountAddress(isolatedA.billingAccountId)
      );
      expect(result.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(result.seedUsdc).toBe("500.00000000");

      const seedDb = getSeedDb();
      const [row] = await seedDb
        .select({
          kind: polyWalletConnections.kind,
          funderAddress: polyWalletConnections.funderAddress,
          paperSeedUsdc: polyWalletConnections.paperSeedUsdc,
          tradingApprovalsReadyAt:
            polyWalletConnections.tradingApprovalsReadyAt,
        })
        .from(polyWalletConnections)
        .where(eq(polyWalletConnections.id, result.connectionId));

      expect(row?.kind).toBe("paper");
      // readWalletBalanceFact keys off funder_address alone and reads a NULL
      // there as `no_wallet`, so the paper row must populate it.
      expect(row?.funderAddress).toBe(result.address);
      expect(row?.paperSeedUsdc).toBe("500.00000000");
      // APPROVALS_PRESTAMPED — authorizeIntent fail-closes on NULL.
      expect(row?.tradingApprovalsReadyAt).not.toBeNull();

      // GRANT_OR_NOTHING
      const grants = await seedDb
        .select({
          scopes: polyWalletGrants.scopes,
          perOrderUsdcCap: polyWalletGrants.perOrderUsdcCap,
          dailyUsdcCap: polyWalletGrants.dailyUsdcCap,
        })
        .from(polyWalletGrants)
        .where(eq(polyWalletGrants.walletConnectionId, result.connectionId));

      expect(grants).toHaveLength(1);
      expect(grants[0]?.scopes).toEqual(["poly:trade:buy", "poly:trade:sell"]);
      expect(grants[0]?.perOrderUsdcCap).toBe("5.00");
      expect(grants[0]?.dailyUsdcCap).toBe("50.00");
    });

    it("is idempotent and never re-seeds an account that may have traded", async () => {
      const result = await withTenantScope(
        db,
        userActor(toUserId(isolatedA.userId)),
        (tx) =>
          provisionPaperAccount(tx, {
            billingAccountId: isolatedA.billingAccountId,
            createdByUserId: isolatedA.userId,
            actorKind: "user",
            actorId: isolatedA.userId,
            // A different seed on the re-hit MUST NOT overwrite the original.
            seedUsdc: 999,
            defaultGrant: { perOrderUsdcCap: 1, dailyUsdcCap: 2 },
          })
      );

      expect(result.created).toBe(false);
      expect(result.seedUsdc).toBe("500.00000000");

      const seedDb = getSeedDb();
      const rows = await seedDb
        .select({ id: polyWalletConnections.id })
        .from(polyWalletConnections)
        .where(
          and(
            eq(
              polyWalletConnections.billingAccountId,
              isolatedA.billingAccountId
            ),
            eq(polyWalletConnections.kind, "paper")
          )
        );
      expect(rows).toHaveLength(1);
    });
  });

  describe("tenant isolation", () => {
    it("a paper row is as isolated as a live one", async () => {
      await withTenantScope(db, userActor(toUserId(isolatedB.userId)), (tx) =>
        provisionPaperAccount(tx, {
          billingAccountId: isolatedB.billingAccountId,
          createdByUserId: isolatedB.userId,
          actorKind: "user",
          actorId: isolatedB.userId,
          seedUsdc: 10,
          defaultGrant: { perOrderUsdcCap: 1, dailyUsdcCap: 2 },
        })
      );

      const visibleTo = async (owner: Tenant) =>
        withTenantScope(db, userActor(toUserId(owner.userId)), async (tx) => {
          const rows = await tx
            .select({
              billingAccountId: polyWalletConnections.billingAccountId,
            })
            .from(polyWalletConnections)
            .where(eq(polyWalletConnections.kind, "paper"));
          return rows.map((r) => r.billingAccountId);
        });

      expect(await visibleTo(isolatedA)).toEqual([isolatedA.billingAccountId]);
      expect(await visibleTo(isolatedB)).toEqual([isolatedB.billingAccountId]);
    });

    it("refuses to write a paper row onto another tenant's account", async () => {
      await expect(
        withTenantScope(db, userActor(toUserId(isolatedB.userId)), (tx) =>
          provisionPaperAccount(tx, {
            // Lying about the tenant: the RLS WITH CHECK clause is the
            // backstop under the route's server-side tenant resolution.
            // `legacy` holds no paper row, so the only constraint that can
            // fire here is RLS — a victim that already had one could fail on
            // the unique index instead and the test would pass for the wrong
            // reason.
            billingAccountId: legacy.billingAccountId,
            createdByUserId: isolatedB.userId,
            actorKind: "user",
            actorId: isolatedB.userId,
            seedUsdc: 10,
            defaultGrant: { perOrderUsdcCap: 1, dailyUsdcCap: 2 },
          })
        )
      ).rejects.toThrow(/row-level security|violates row-level/i);
    });
  });

  describe("live-path readers ignore paper rows", () => {
    it("the live partial index and the kind filter agree on `both`", async () => {
      // Guards the LIVE_ROWS_ONLY predicate the Privy adapter relies on: a
      // kind-filtered per-tenant read must resolve exactly one row even for a
      // tenant holding both kinds, otherwise `.limit(1)` is a coin flip and
      // decryptCreds can receive a NULL ciphertext.
      const seedDb = getSeedDb();
      const rows = await seedDb
        .select({
          id: polyWalletConnections.id,
          privyWalletId: polyWalletConnections.privyWalletId,
          ciphertext: polyWalletConnections.clobApiKeyCiphertext,
        })
        .from(polyWalletConnections)
        .where(
          and(
            eq(polyWalletConnections.billingAccountId, both.billingAccountId),
            eq(polyWalletConnections.kind, "privy_live"),
            sql`${polyWalletConnections.revokedAt} IS NULL`
          )
        );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.privyWalletId).not.toBeNull();
      expect(rows[0]?.ciphertext).not.toBeNull();
    });
  });
});

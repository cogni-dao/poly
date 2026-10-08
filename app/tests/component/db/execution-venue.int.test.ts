// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/execution-venue.int.test`
 * Purpose: Prove, against real Postgres, the three SQL-shaped claims that make
 *   execution mode a property of the account:
 *     1. the venue resolver reads `poly_wallet_connections.kind` and applies
 *        LIVE_WINS_DISPATCH / NO_DEFAULT_VENUE,
 *     2. the paper venue authorizes against the paper account's OWN grant row
 *        (and denies when that row is gone),
 *     3. `listAllActive` returns ONE row per target even when an account holds
 *        both a live and a paper connection — the fan-out the deleted INNER
 *        joins produced, which would have started N mirror polls per target.
 * Scope: Real Postgres via testcontainers. Service role for fixtures and the
 *   cross-tenant enumerator; no HTTP, no Privy, no chain, no sidecar.
 * Invariants:
 *   - LIVE_WINS_DISPATCH, NO_DEFAULT_VENUE (execution-venue.ts)
 *   - PAPER_ROWS_ONLY, FAIL_CLOSED (paper-venue.ts)
 *   - ONE_ROW_PER_TARGET, ACTIVATION_IS_KIND_AGNOSTIC (target-source.ts)
 * Side-effects: IO (testcontainers Postgres)
 * Links: migrations/0081_poly_paper_accounts.sql, docs/spec/capability-plane.md
 * @internal
 */

import { randomUUID } from "node:crypto";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { beforeAll, describe, expect, it } from "vitest";

import { getAppDb } from "@/adapters/server/db/client";
import { dbTargetSource } from "@/features/copy-trade/target-source";
import {
  createExecutionVenueResolver,
  createPaperVenue,
  derivePaperAccountAddress,
  ExecutionVenueUnresolvedError,
  PaperAccountUnavailableError,
} from "@/features/paper-accounts";
import {
  billingAccounts,
  polyCopyTradeTargets,
  polyWalletConnections,
  polyWalletGrants,
  users,
} from "@/shared/db/schema";

type Tenant = { userId: string; billingAccountId: string; name: string };

function tenant(name: string): Tenant {
  return { userId: randomUUID(), billingAccountId: randomUUID(), name };
}

function address(): `0x${string}` {
  const hex = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
  return `0x${hex.slice(0, 40)}` as `0x${string}`;
}

/** Cast once — the feature slice declares the postgres-js generic shape. */
function asPgDb(db: unknown): PostgresJsDatabase<Record<string, unknown>> {
  return db as PostgresJsDatabase<Record<string, unknown>>;
}

const BUY = {
  side: "BUY" as const,
  usdcAmount: 1,
  marketConditionId: "0xcondition",
};

describe("execution venue + paper authorization (account-resolved mode)", () => {
  const liveOnly = tenant("Live-only tenant");
  const paperOnly = tenant("Paper-only tenant");
  const both = tenant("Live + paper tenant");
  const unprovisioned = tenant("No-connection tenant");
  /**
   * Paper tenant reserved for the enumerator assertion. `paperOnly`'s grant is
   * deliberately revoked by a test above, so asserting enumeration on it would
   * couple two unrelated claims through fixture order.
   */
  const paperEnumerated = tenant("Paper tenant (enumerator)");
  const tenants = [
    liveOnly,
    paperOnly,
    both,
    unprovisioned,
    paperEnumerated,
  ];

  beforeAll(async () => {
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

    const live = (owner: Tenant) => ({
      billingAccountId: owner.billingAccountId,
      createdByUserId: owner.userId,
      kind: "privy_live" as const,
      privyWalletId: `privy-${randomUUID()}`,
      address: address(),
      clobApiKeyCiphertext: Buffer.from("ciphertext"),
      encryptionKeyId: "test-key",
      custodialConsentAcceptedAt: new Date("2026-10-01T00:00:00.000Z"),
      custodialConsentActorKind: "user" as const,
      custodialConsentActorId: owner.userId,
      tradingApprovalsReadyAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    const paper = (owner: Tenant) => {
      const paperAddress = derivePaperAccountAddress(owner.billingAccountId);
      return {
        billingAccountId: owner.billingAccountId,
        createdByUserId: owner.userId,
        kind: "paper" as const,
        address: paperAddress,
        funderAddress: paperAddress,
        paperSeedUsdc: "1000.00000000",
        custodialConsentAcceptedAt: new Date("2026-10-01T00:00:00.000Z"),
        custodialConsentActorKind: "user" as const,
        custodialConsentActorId: owner.userId,
        tradingApprovalsReadyAt: new Date("2026-10-01T00:00:00.000Z"),
      };
    };

    const connections = await seedDb
      .insert(polyWalletConnections)
      .values([
        live(liveOnly),
        paper(paperOnly),
        live(both),
        paper(both),
        paper(paperEnumerated),
      ])
      .returning({
        id: polyWalletConnections.id,
        billingAccountId: polyWalletConnections.billingAccountId,
        kind: polyWalletConnections.kind,
        createdByUserId: polyWalletConnections.createdByUserId,
      });

    // Every connection gets a grant — GRANT_OR_NOTHING for both kinds.
    await seedDb.insert(polyWalletGrants).values(
      connections.map((connection) => ({
        billingAccountId: connection.billingAccountId,
        walletConnectionId: connection.id,
        createdByUserId: connection.createdByUserId,
        scopes: ["poly:trade:buy", "poly:trade:sell"],
        perOrderUsdcCap: "5.00",
        dailyUsdcCap: "50.00",
        hourlyFillsCap: 100,
        expiresAt: null,
      }))
    );

    // One target per tenant, including the tenant with no connection at all.
    await seedDb.insert(polyCopyTradeTargets).values(
      tenants.map((entry) => ({
        billingAccountId: entry.billingAccountId,
        createdByUserId: entry.userId,
        targetWallet: address(),
      }))
    );
  });

  describe("the venue resolver", () => {
    it("reads the kind: live-only → live, paper-only → paper", async () => {
      const resolve = createExecutionVenueResolver({
        db: asPgDb(getSeedDb()),
      });
      expect(await resolve(liveOnly.billingAccountId)).toBe("live");
      expect(await resolve(paperOnly.billingAccountId)).toBe("paper");
    });

    it("LIVE_WINS_DISPATCH when a tenant holds both kinds", async () => {
      const resolve = createExecutionVenueResolver({
        db: asPgDb(getSeedDb()),
      });
      expect(await resolve(both.billingAccountId)).toBe("live");
    });

    it("NO_DEFAULT_VENUE — an account with no connection throws", async () => {
      const resolve = createExecutionVenueResolver({
        db: asPgDb(getSeedDb()),
      });
      const err = await resolve(unprovisioned.billingAccountId).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ExecutionVenueUnresolvedError);
      expect((err as ExecutionVenueUnresolvedError).reason).toBe(
        "no_connection"
      );
    });

    it("ignores a revoked connection", async () => {
      const seedDb = getSeedDb();
      const revoker = tenant("Revoked-connection tenant");
      await seedDb.insert(users).values({
        id: revoker.userId,
        name: revoker.name,
        walletAddress: address(),
      });
      await seedDb.insert(billingAccounts).values({
        id: revoker.billingAccountId,
        ownerUserId: revoker.userId,
        balanceCredits: 0n,
      });
      const paperAddress = derivePaperAccountAddress(revoker.billingAccountId);
      await seedDb.insert(polyWalletConnections).values({
        billingAccountId: revoker.billingAccountId,
        createdByUserId: revoker.userId,
        kind: "paper",
        address: paperAddress,
        funderAddress: paperAddress,
        paperSeedUsdc: "10.00000000",
        custodialConsentAcceptedAt: new Date("2026-10-01T00:00:00.000Z"),
        custodialConsentActorKind: "user",
        custodialConsentActorId: revoker.userId,
        revokedAt: new Date("2026-10-02T00:00:00.000Z"),
      });

      const resolve = createExecutionVenueResolver({
        db: asPgDb(seedDb),
      });
      await expect(resolve(revoker.billingAccountId)).rejects.toBeInstanceOf(
        ExecutionVenueUnresolvedError
      );
    });
  });

  describe("the paper venue", () => {
    it("resolves the paper account's own synthetic address and seed", async () => {
      const venue = createPaperVenue({ db: asPgDb(getSeedDb()) });
      const identity = await venue.resolveAccount(paperOnly.billingAccountId);
      expect(identity.funderAddress).toBe(
        derivePaperAccountAddress(paperOnly.billingAccountId)
      );
      expect(Number(identity.seedUsdc)).toBe(1000);
      // NOT the zero address the pre-0081 paper executor used.
      expect(identity.funderAddress).not.toBe(
        "0x0000000000000000000000000000000000000000"
      );
    });

    it("PAPER_ROWS_ONLY — a live-only tenant has no paper account", async () => {
      const venue = createPaperVenue({ db: asPgDb(getSeedDb()) });
      await expect(
        venue.resolveAccount(liveOnly.billingAccountId)
      ).rejects.toBeInstanceOf(PaperAccountUnavailableError);
    });

    it("authorizes a paper intent against the paper grant", async () => {
      const venue = createPaperVenue({ db: asPgDb(getSeedDb()) });
      const decision = await venue.authorizeIntent(
        paperOnly.billingAccountId,
        BUY
      );
      expect(decision.ok).toBe(true);
    });

    it("enforces the paper grant's per-order cap", async () => {
      const venue = createPaperVenue({ db: asPgDb(getSeedDb()) });
      const decision = await venue.authorizeIntent(paperOnly.billingAccountId, {
        ...BUY,
        usdcAmount: 5.01,
      });
      expect(decision).toEqual({
        ok: false,
        reason: "cap_exceeded_per_order",
      });
    });

    it("picks the PAPER grant even when the tenant also holds a live one", async () => {
      const seedDb = getSeedDb();
      const [paperConnection] = await seedDb
        .select({ id: polyWalletConnections.id })
        .from(polyWalletConnections)
        .where(
          and(
            eq(polyWalletConnections.billingAccountId, both.billingAccountId),
            eq(polyWalletConnections.kind, "paper"),
            isNull(polyWalletConnections.revokedAt)
          )
        );
      expect(paperConnection).toBeDefined();

      // Tighten ONLY the paper grant. If the authorizer read the live row's
      // grant, this would still authorize.
      await seedDb
        .update(polyWalletGrants)
        .set({ perOrderUsdcCap: "0.50" })
        .where(
          eq(polyWalletGrants.walletConnectionId, paperConnection?.id ?? "")
        );

      const venue = createPaperVenue({ db: asPgDb(seedDb) });
      const decision = await venue.authorizeIntent(both.billingAccountId, BUY);
      expect(decision).toEqual({
        ok: false,
        reason: "cap_exceeded_per_order",
      });
    });

    it("FAIL_CLOSED — a revoked grant denies", async () => {
      const seedDb = getSeedDb();
      await seedDb
        .update(polyWalletGrants)
        .set({ revokedAt: new Date("2026-10-03T00:00:00.000Z") })
        .where(eq(polyWalletGrants.billingAccountId, paperOnly.billingAccountId));

      const venue = createPaperVenue({ db: asPgDb(seedDb) });
      const decision = await venue.authorizeIntent(
        paperOnly.billingAccountId,
        BUY
      );
      expect(decision).toEqual({ ok: false, reason: "no_active_grant" });
    });
  });

  describe("the mirror enumerator", () => {
    it("enumerates both kinds, exactly once per target, and skips the unprovisioned tenant", async () => {
      const source = dbTargetSource({
        appDb: asPgDb(getAppDb()),
        serviceDb: asPgDb(getSeedDb()),
      });
      const rows = await source.listAllActive();

      const countFor = (entry: Tenant) =>
        rows.filter((row) => row.billingAccountId === entry.billingAccountId)
          .length;

      expect(countFor(liveOnly)).toBe(1);
      // ACTIVATION_IS_KIND_AGNOSTIC: a paper account activates its target on
      // the same rule a live one does. Under the deleted `paperEnforced`
      // branch this worked only by dropping the joins for EVERY tenant.
      expect(countFor(paperEnumerated)).toBe(1);
      // ONE_ROW_PER_TARGET: two active connections, still one enumerated target.
      expect(countFor(both)).toBe(1);
      // No connection at all → not enumerated.
      expect(countFor(unprovisioned)).toBe(0);
    });
  });
});

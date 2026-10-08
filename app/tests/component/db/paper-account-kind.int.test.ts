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

/**
 * SQLSTATEs this file asserts on. Codes are part of the Postgres wire contract
 * and never change; the human-readable message text is not and does change.
 */
const PG_CHECK_VIOLATION = "23514";
const PG_UNIQUE_VIOLATION = "23505";
/** RLS rejects a WITH CHECK failure as insufficient_privilege, not as a constraint. */
const PG_INSUFFICIENT_PRIVILEGE = "42501";

/** Every link in an error's `cause` chain, innermost last, cycle-safe. */
function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * Pull the real Postgres error facts out of whatever the driver stack wrapped
 * them in.
 *
 * Drizzle raises a `DrizzleQueryError` whose `message` is its own
 * `"Failed query: insert into ... params: ..."` text — the Postgres message
 * ("violates check constraint ...", "duplicate key value ...", "violates
 * row-level security policy") is NOT in `.message`, it is on the wrapped
 * cause. Asserting with `rejects.toThrow(/some text/)` therefore tests the
 * driver's formatting rather than the database's behavior: it fails even
 * though the DDL worked, and worse, a future wrapper change could make it
 * pass for a rejection that came from somewhere else entirely.
 *
 * `code` + `constraint_name` come straight off the PG error fields, so they
 * are stable across driver and wrapper versions.
 */
function pgErrorFacts(err: unknown): { code: string; constraint: string | null } {
  for (const link of causeChain(err)) {
    const fields = link as Record<string, unknown>;
    const code = fields.code;
    // SQLSTATE is always exactly five alphanumerics; this also skips Node's
    // string `code`s (ECONNREFUSED and friends).
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      // postgres-js copies the PG field verbatim as `constraint_name`;
      // node-postgres calls it `constraint`. Accept either.
      const constraint =
        typeof fields.constraint_name === "string"
          ? fields.constraint_name
          : typeof fields.constraint === "string"
            ? fields.constraint
            : null;
      return { code, constraint };
    }
  }
  throw new Error(
    `expected a Postgres error in the cause chain, found none. Chain: ${causeChain(
      err
    )
      .map((link) => (link instanceof Error ? link.message : String(link)))
      .join(" <- ")}`
  );
}

/**
 * Assert a write is rejected BY POSTGRES for a specific, named reason.
 *
 * Deliberately not `rejects.toThrow`: a write that unexpectedly SUCCEEDS is
 * the dangerous outcome here (it means a constraint is missing), so that case
 * gets its own explicit failure rather than being reported as a message
 * mismatch.
 */
async function expectPgViolation(
  write: () => Promise<unknown>,
  expected: { code: string; constraint?: string }
): Promise<void> {
  let thrown: unknown;
  let succeeded = false;
  try {
    await write();
    succeeded = true;
  } catch (err) {
    thrown = err;
  }

  expect(
    succeeded,
    "expected Postgres to reject this write, but it was accepted — a constraint is missing"
  ).toBe(false);

  const facts = pgErrorFacts(thrown);
  expect(facts.code).toBe(expected.code);
  if (expected.constraint !== undefined) {
    expect(facts.constraint).toBe(expected.constraint);
  }
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
        await expectPgViolation(
          () =>
            seedDb
              .insert(polyWalletConnections)
              .values(liveRow(rejects, { kind: "privy_live", ...nulled })),
          {
            code: PG_CHECK_VIOLATION,
            constraint: "poly_wallet_connections_live_requires_custody",
          }
        );
      }
    });

    it("rejects an unknown kind", async () => {
      const seedDb = getSeedDb();
      await expectPgViolation(
        () =>
          seedDb
            .insert(polyWalletConnections)
            .values(liveRow(rejects, { kind: "margin" })),
        {
          code: PG_CHECK_VIOLATION,
          constraint: "poly_wallet_connections_kind_check",
        }
      );
    });

    it("rejects a paper row with no declared seed", async () => {
      const seedDb = getSeedDb();
      const addr = address();
      await expectPgViolation(
        () =>
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
          }),
        {
          code: PG_CHECK_VIOLATION,
          constraint: "poly_wallet_connections_paper_seed_usdc",
        }
      );
    });

    it("rejects a live row that carries a simulated seed", async () => {
      const seedDb = getSeedDb();
      await expectPgViolation(
        () =>
          seedDb
            .insert(polyWalletConnections)
            .values(liveRow(rejects, { paperSeedUsdc: "500.00000000" })),
        {
          code: PG_CHECK_VIOLATION,
          constraint: "poly_wallet_connections_paper_seed_usdc",
        }
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
      await expectPgViolation(
        () => seedDb.insert(polyWalletConnections).values(liveRow(both)),
        {
          code: PG_UNIQUE_VIOLATION,
          // Postgres reports the offending unique INDEX in the constraint
          // field, which is what pins the (billing_account_id, kind) shape.
          constraint: "poly_wallet_connections_tenant_active_idx",
        }
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
      await expectPgViolation(
        () =>
          withTenantScope(db, userActor(toUserId(isolatedB.userId)), (tx) =>
            provisionPaperAccount(tx, {
              // Lying about the tenant: the RLS WITH CHECK clause is the
              // backstop under the route's server-side tenant resolution.
              // `legacy` holds no paper row, so the only thing that can fire
              // here is RLS — a victim that already had one could fail on the
              // unique index instead and the test would pass for the wrong
              // reason.
              billingAccountId: legacy.billingAccountId,
              createdByUserId: isolatedB.userId,
              actorKind: "user",
              actorId: isolatedB.userId,
              seedUsdc: 10,
              defaultGrant: { perOrderUsdcCap: 1, dailyUsdcCap: 2 },
            })
          ),
        // A WITH CHECK failure is insufficient_privilege and carries no
        // constraint name, so the code is the whole assertion. It is still
        // unambiguous: nothing else in this transaction can raise 42501.
        { code: PG_INSUFFICIENT_PRIVILEGE }
      );
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

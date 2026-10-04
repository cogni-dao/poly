// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-capability-grant-rls.int.test`
 * Purpose: Prove performance-read delegation is tenant-isolated by PostgreSQL RLS.
 * Scope: Real Postgres app/service roles, active and inactive grants, copy-trade fills and decisions. Does not test HTTP transport.
 * Invariants: Owners and active delegates see the same account markers; delegates never gain mutation rights or second-tenant visibility.
 * Side-effects: IO (testcontainers Postgres)
 * Links: task.1791070950, packages/db-schema/src/agent-capability-grants.ts
 * @internal
 */

import { randomUUID } from "node:crypto";
import { agentCapabilityGrants } from "@cogni/db-schema/agent-capability-grants";
import {
  polyCopyTradeDecisions,
  polyCopyTradeFills,
} from "@cogni/db-schema/copy-trade";
import { toUserId, userActor } from "@cogni/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/adapters/server/db/client";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { billingAccounts, users } from "@/shared/db/schema";

type Principal = { userId: string; name: string };
type Tenant = Principal & { billingAccountId: string };

const MARKER_A = "data-api:agent-grant-tenant-a";
const MARKER_B = "data-api:agent-grant-tenant-b";
const DECISION_A = "data-api:agent-grant-decision-a";
const DECISION_B = "data-api:agent-grant-decision-b";

const future = new Date("2099-01-01T00:00:00.000Z");
const past = new Date("2000-01-01T00:00:00.000Z");

function principal(name: string): Principal {
  return { userId: randomUUID(), name };
}

function tenant(name: string): Tenant {
  return { ...principal(name), billingAccountId: randomUUID() };
}

function randomWalletAddress(): string {
  const first = randomUUID().replace(/-/g, "");
  const second = randomUUID().replace(/-/g, "");
  return `0x${first}${second}`.slice(0, 42);
}

describe("agent capability grant RLS", () => {
  let db: Database;
  const ownerA = tenant("Grant owner A");
  const ownerB = tenant("Grant owner B");
  const internalAgent = principal("Internal agent");
  const externalAgent = principal("External agent");
  const wrongScopeAgent = principal("Wrong-scope agent");
  const expiredAgent = principal("Expired-grant agent");
  const revokedAgent = principal("Revoked-grant agent");
  const principals = [
    ownerA,
    ownerB,
    internalAgent,
    externalAgent,
    wrongScopeAgent,
    expiredAgent,
    revokedAgent,
  ];
  const targetA = randomUUID();
  const targetB = randomUUID();

  beforeAll(async () => {
    db = getAppDb();
    const seedDb = getSeedDb();

    await seedDb.insert(users).values(
      principals.map((entry) => ({
        id: entry.userId,
        name: entry.name,
        walletAddress: randomWalletAddress(),
      }))
    );
    await seedDb.insert(billingAccounts).values([
      {
        id: ownerA.billingAccountId,
        ownerUserId: ownerA.userId,
        balanceCredits: 0n,
      },
      {
        id: ownerB.billingAccountId,
        ownerUserId: ownerB.userId,
        balanceCredits: 0n,
      },
    ]);

    await seedDb.insert(agentCapabilityGrants).values([
      {
        billingAccountId: ownerA.billingAccountId,
        granteePrincipalId: internalAgent.userId,
        scopes: ["performance:read"],
        expiresAt: future,
        createdByUserId: ownerA.userId,
      },
      {
        billingAccountId: ownerA.billingAccountId,
        granteePrincipalId: externalAgent.userId,
        scopes: ["performance:read", "research:run"],
        expiresAt: future,
        createdByUserId: ownerA.userId,
      },
      {
        billingAccountId: ownerA.billingAccountId,
        granteePrincipalId: wrongScopeAgent.userId,
        scopes: ["research:run"],
        expiresAt: future,
        createdByUserId: ownerA.userId,
      },
      {
        billingAccountId: ownerA.billingAccountId,
        granteePrincipalId: expiredAgent.userId,
        scopes: ["performance:read"],
        expiresAt: past,
        createdByUserId: ownerA.userId,
        createdAt: new Date("1999-01-01T00:00:00.000Z"),
        updatedAt: new Date("2000-01-01T00:00:00.000Z"),
      },
      {
        billingAccountId: ownerA.billingAccountId,
        granteePrincipalId: revokedAgent.userId,
        scopes: ["performance:read"],
        expiresAt: future,
        createdByUserId: ownerA.userId,
        revokedAt: new Date("2026-10-04T00:00:00.000Z"),
        revokedByUserId: ownerA.userId,
      },
    ]);

    await seedDb.insert(polyCopyTradeFills).values([
      {
        billingAccountId: ownerA.billingAccountId,
        createdByUserId: ownerA.userId,
        targetId: targetA,
        fillId: MARKER_A,
        marketId: "agent-grant-market-a",
        observedAt: new Date("2026-10-04T00:00:00.000Z"),
        clientOrderId: `agent-grant-a-${randomUUID()}`,
        status: "filled",
        positionLifecycle: "open",
        mode: "paper",
        attributes: { marker: "tenant-a", size_usdc: "7" },
      },
      {
        billingAccountId: ownerB.billingAccountId,
        createdByUserId: ownerB.userId,
        targetId: targetB,
        fillId: MARKER_B,
        marketId: "agent-grant-market-b",
        observedAt: new Date("2026-10-04T00:01:00.000Z"),
        clientOrderId: `agent-grant-b-${randomUUID()}`,
        status: "filled",
        positionLifecycle: "open",
        mode: "paper",
        attributes: { marker: "tenant-b", size_usdc: "11" },
      },
    ]);
    await seedDb.insert(polyCopyTradeDecisions).values([
      {
        billingAccountId: ownerA.billingAccountId,
        createdByUserId: ownerA.userId,
        targetId: targetA,
        fillId: DECISION_A,
        outcome: "placed",
        intent: { marker: "tenant-a" },
        decidedAt: new Date("2026-10-04T00:00:00.000Z"),
        mode: "paper",
      },
      {
        billingAccountId: ownerB.billingAccountId,
        createdByUserId: ownerB.userId,
        targetId: targetB,
        fillId: DECISION_B,
        outcome: "placed",
        intent: { marker: "tenant-b" },
        decidedAt: new Date("2026-10-04T00:01:00.000Z"),
        mode: "paper",
      },
    ]);
  });

  afterAll(async () => {
    const seedDb = getSeedDb();
    await seedDb
      .delete(polyCopyTradeDecisions)
      .where(
        inArray(polyCopyTradeDecisions.fillId, [DECISION_A, DECISION_B])
      );
    await seedDb
      .delete(polyCopyTradeFills)
      .where(inArray(polyCopyTradeFills.fillId, [MARKER_A, MARKER_B]));
    await seedDb
      .delete(agentCapabilityGrants)
      .where(eq(agentCapabilityGrants.billingAccountId, ownerA.billingAccountId));
    await seedDb
      .delete(billingAccounts)
      .where(
        inArray(billingAccounts.id, [
          ownerA.billingAccountId,
          ownerB.billingAccountId,
        ])
      );
    await seedDb
      .delete(users)
      .where(inArray(users.id, principals.map((entry) => entry.userId)));
  });

  async function readMarkers(userId: string) {
    return withTenantScope(
      db,
      userActor(toUserId(userId)),
      async (tx) => ({
        fills: await tx
          .select({
            billingAccountId: polyCopyTradeFills.billingAccountId,
            fillId: polyCopyTradeFills.fillId,
          })
          .from(polyCopyTradeFills)
          .where(inArray(polyCopyTradeFills.fillId, [MARKER_A, MARKER_B]))
          .orderBy(asc(polyCopyTradeFills.fillId)),
        decisions: await tx
          .select({
            billingAccountId: polyCopyTradeDecisions.billingAccountId,
            fillId: polyCopyTradeDecisions.fillId,
          })
          .from(polyCopyTradeDecisions)
          .where(
            inArray(polyCopyTradeDecisions.fillId, [DECISION_A, DECISION_B])
          )
          .orderBy(asc(polyCopyTradeDecisions.fillId)),
      })
    );
  }

  const markerIds = (result: Awaited<ReturnType<typeof readMarkers>>) => ({
    fills: result.fills.map((row) => row.fillId),
    decisions: result.decisions.map((row) => row.fillId),
  });

  it("gives owner, internal agent, and external agent identical account-A visibility", async () => {
    const owner = await readMarkers(ownerA.userId);
    const internal = await readMarkers(internalAgent.userId);
    const external = await readMarkers(externalAgent.userId);

    expect(markerIds(owner)).toEqual({
      fills: [MARKER_A],
      decisions: [DECISION_A],
    });
    expect(markerIds(internal)).toEqual(markerIds(owner));
    expect(markerIds(external)).toEqual(markerIds(owner));
    expect(
      internal.fills.every(
        (row) => row.billingAccountId === ownerA.billingAccountId
      )
    ).toBe(true);
    expect(
      external.fills.every(
        (row) => row.billingAccountId === ownerA.billingAccountId
      )
    ).toBe(true);
  });

  it("never exposes the second tenant through an account-A grant", async () => {
    const tenantB = await readMarkers(ownerB.userId);
    const internal = await readMarkers(internalAgent.userId);
    const external = await readMarkers(externalAgent.userId);

    expect(markerIds(tenantB)).toEqual({
      fills: [MARKER_B],
      decisions: [DECISION_B],
    });
    expect(markerIds(internal).fills).not.toContain(MARKER_B);
    expect(markerIds(internal).decisions).not.toContain(DECISION_B);
    expect(markerIds(external).fills).not.toContain(MARKER_B);
    expect(markerIds(external).decisions).not.toContain(DECISION_B);
  });

  it.each([
    ["wrong scope", wrongScopeAgent],
    ["expired grant", expiredAgent],
    ["revoked grant", revokedAgent],
  ])("returns zero rows for %s", async (_label, actor) => {
    expect(markerIds(await readMarkers(actor.userId))).toEqual({
      fills: [],
      decisions: [],
    });
  });

  it("returns zero rows without tenant context", async () => {
    const result = await db.transaction(async (tx) => ({
      fills: await tx
        .select({ fillId: polyCopyTradeFills.fillId })
        .from(polyCopyTradeFills)
        .where(inArray(polyCopyTradeFills.fillId, [MARKER_A, MARKER_B])),
      decisions: await tx
        .select({ fillId: polyCopyTradeDecisions.fillId })
        .from(polyCopyTradeDecisions)
        .where(
          inArray(polyCopyTradeDecisions.fillId, [DECISION_A, DECISION_B])
        ),
    }));

    expect(result).toEqual({ fills: [], decisions: [] });
  });

  it("rejects delegate INSERT and filters delegate UPDATE/DELETE", async () => {
    let insertError: unknown;
    try {
      await withTenantScope(
        db,
        userActor(toUserId(internalAgent.userId)),
        (tx) =>
          tx.insert(polyCopyTradeFills).values({
            billingAccountId: ownerA.billingAccountId,
            createdByUserId: ownerA.userId,
            targetId: targetA,
            fillId: "data-api:agent-grant-forbidden-insert",
            marketId: "agent-grant-forbidden-market",
            observedAt: new Date("2026-10-04T00:02:00.000Z"),
            clientOrderId: `agent-grant-forbidden-${randomUUID()}`,
            status: "filled",
            mode: "paper",
          })
      );
    } catch (error) {
      insertError = error;
    }
    expect(insertError).toBeDefined();
    expect(
      (insertError as { code?: string; cause?: { code?: string } }).code ??
        (insertError as { cause?: { code?: string } }).cause?.code
    ).toBe("42501");

    const updated = await withTenantScope(
      db,
      userActor(toUserId(internalAgent.userId)),
      (tx) =>
        tx
          .update(polyCopyTradeFills)
          .set({ status: "canceled" })
          .where(eq(polyCopyTradeFills.fillId, MARKER_A))
          .returning({ fillId: polyCopyTradeFills.fillId })
    );
    const deleted = await withTenantScope(
      db,
      userActor(toUserId(internalAgent.userId)),
      (tx) =>
        tx
          .delete(polyCopyTradeDecisions)
          .where(eq(polyCopyTradeDecisions.fillId, DECISION_A))
          .returning({ fillId: polyCopyTradeDecisions.fillId })
    );

    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);

    const seedDb = getSeedDb();
    const [fill] = await seedDb
      .select({ status: polyCopyTradeFills.status })
      .from(polyCopyTradeFills)
      .where(eq(polyCopyTradeFills.fillId, MARKER_A));
    const decisions = await seedDb
      .select({ fillId: polyCopyTradeDecisions.fillId })
      .from(polyCopyTradeDecisions)
      .where(eq(polyCopyTradeDecisions.fillId, DECISION_A));
    expect(fill?.status).toBe("filled");
    expect(decisions).toEqual([{ fillId: DECISION_A }]);
  });
});

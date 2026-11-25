// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-roles-account-read.int.test`
 * Purpose: Account-read delegation on the one grant table (`agent_roles`, resource = 'account') opens BOTH halves together: the app `authorize()`
 *   decision and the delegated SELECT policies (migration 0094). A row that authorizes but reads zero rows is the failure this test exists to catch.
 * Scope: Real Postgres app role, live / pending / revoked / expired / node-resource role rows, copy-trade fills. No HTTP transport.
 * Side-effects: IO (testcontainers Postgres)
 * @internal
 */

import { randomUUID } from "node:crypto";
import { agentRoles } from "@cogni/db-schema";
import { polyCopyTradeFills } from "@cogni/db-schema/copy-trade";
import { toUserId, userActor } from "@cogni/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/adapters/server/db/client";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { authorize } from "@/features/agent-grants/authorization";
import { billingAccounts, users } from "@/shared/db/schema";

const MARKER_A = "data-api:agent-roles-tenant-a";
const MARKER_B = "data-api:agent-roles-tenant-b";
const future = new Date("2099-01-01T00:00:00.000Z");
const past = new Date("2000-01-01T00:00:00.000Z");
const granted = new Date("1999-01-01T00:00:00.000Z");

const id = () => randomUUID();
const wallet = () => `0x${id().replace(/-/g, "")}${id().replace(/-/g, "")}`.slice(0, 42);

describe("agent_roles account read", () => {
  let db: Database;
  const [ownerA, ownerB] = [id(), id()];
  const [accountA, accountB] = [id(), id()];
  const live = id();
  const pending = id();
  const revoked = id();
  const expired = id();
  const nodeOnly = id();
  const everyone = [ownerA, ownerB, live, pending, revoked, expired, nodeOnly];

  const row = (principal: string, extra: Partial<typeof agentRoles.$inferInsert> = {}) => ({
    principalUserId: principal,
    scope: "account:read",
    resource: "account" as const,
    accountId: accountA,
    approvedBy: ownerA,
    grantedAt: granted,
    ...extra,
  });

  beforeAll(async () => {
    db = getAppDb();
    const seed = getSeedDb();
    await seed.insert(users).values(
      everyone.map((userId) => ({ id: userId, name: `roles-${userId.slice(0, 6)}`, walletAddress: wallet() }))
    );
    await seed.insert(billingAccounts).values([
      { id: accountA, ownerUserId: ownerA, balanceCredits: 0n },
      { id: accountB, ownerUserId: ownerB, balanceCredits: 0n },
    ]);
    await seed.insert(agentRoles).values([
      row(live),
      row(pending, { approvedBy: null, grantedAt: null }),
      row(revoked, { revokedAt: new Date("2026-10-04T00:00:00.000Z") }),
      row(expired, { expiresAt: past }),
      { principalUserId: nodeOnly, scope: "account:read", resource: "node", approvedBy: ownerA, grantedAt: granted },
    ]);
    const fill = (account: string, owner: string, fillId: string) => ({
      billingAccountId: account,
      createdByUserId: owner,
      targetId: id(),
      fillId,
      marketId: `market-${fillId}`,
      observedAt: new Date("2026-10-04T00:00:00.000Z"),
      clientOrderId: `roles-${id()}`,
      status: "filled",
      positionLifecycle: "open",
      mode: "paper",
      attributes: {},
    });
    await seed.insert(polyCopyTradeFills).values([fill(accountA, ownerA, MARKER_A), fill(accountB, ownerB, MARKER_B)]);
  });

  afterAll(async () => {
    const seed = getSeedDb();
    await seed.delete(polyCopyTradeFills).where(inArray(polyCopyTradeFills.fillId, [MARKER_A, MARKER_B]));
    await seed.delete(agentRoles).where(inArray(agentRoles.principalUserId, everyone));
    await seed.delete(billingAccounts).where(inArray(billingAccounts.id, [accountA, accountB]));
    await seed.delete(users).where(inArray(users.id, everyone));
  });

  const decide = (principalId: string, accountId: string) =>
    withTenantScope(db, userActor(toUserId(principalId)), (tx) =>
      authorize(tx, { principalId, accountId, requiredScope: "account:read" })
    );
  const reads = (principalId: string) =>
    withTenantScope(db, userActor(toUserId(principalId)), (tx) =>
      tx
        .select({ fillId: polyCopyTradeFills.fillId })
        .from(polyCopyTradeFills)
        .where(inArray(polyCopyTradeFills.fillId, [MARKER_A, MARKER_B]))
    ).then((rows) => rows.map((r) => r.fillId));

  it("a live approved account row authorizes AND reads the granted account only", async () => {
    expect(await decide(live, accountA)).toMatchObject({ accessKind: "delegated" });
    expect(await reads(live)).toEqual([MARKER_A]);
    expect(await decide(live, accountB)).toBeNull();
  });

  it.each([
    ["pending", pending],
    ["revoked", revoked],
    ["expired", expired],
    ["node-resource", nodeOnly],
  ])("a %s row neither authorizes nor reads", async (_name, principal) => {
    expect(await decide(principal, accountA)).toBeNull();
    expect(await reads(principal)).toEqual([]);
  });

  it("the owner is unchanged and never sees the other tenant", async () => {
    expect(await decide(ownerA, accountA)).toEqual({ accessKind: "owner", grantId: null });
    expect(await reads(ownerA)).toEqual([MARKER_A]);
  });

  it("ends on revoke: the next read is empty", async () => {
    const seed = getSeedDb();
    await seed.update(agentRoles).set({ revokedAt: new Date() }).where(eq(agentRoles.principalUserId, live));
    expect(await decide(live, accountA)).toBeNull();
    expect(await reads(live)).toEqual([]);
  });
});

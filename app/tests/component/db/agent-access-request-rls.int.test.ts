// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-access-request-rls.int.test`
 * Purpose: Prove request self-isolation and token-bound owner approval against
 *   real Postgres RLS.
 * Scope: App/service roles and transactional request/grant mutations only.
 * Invariants: no raw token storage, no cross-tenant rows, grant and request bind
 *   in one owner transaction, consumed tokens cannot select pending work.
 * Side-effects: IO (testcontainers Postgres)
 * @internal
 */

import { createHash, randomUUID } from "node:crypto";
import { agentAccessRequests } from "@cogni/db-schema/agent-access-requests";
import { agentCapabilityGrants } from "@cogni/db-schema/agent-capability-grants";
import { toUserId, userActor } from "@cogni/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/adapters/server/db/client";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import {
  decideAgentAccessRequest,
  listAgentAccessRequests,
} from "@/features/agent-grants/agent-access-request-service";
import { revokeOwnedAgentGrant } from "@/features/agent-grants/agent-grant-service";
import { billingAccounts, users } from "@/shared/db/schema";

const ownerA = { userId: randomUUID(), accountId: randomUUID() };
const ownerB = { userId: randomUUID(), accountId: randomUUID() };
const agent = { userId: randomUUID() };
const otherAgent = { userId: randomUUID() };
const rawToken = "approval_token_only_the_agent_sees_123456789";
const approvalTokenHash = createHash("sha256")
  .update(rawToken)
  .digest("hex");
const future = new Date("2099-01-01T00:00:00.000Z");
const tokenFuture = new Date("2098-01-01T00:00:00.000Z");

describe("agent access request RLS", () => {
  let db: Database;
  let requestId: string;
  let grantId: string;
  const requestIds: string[] = [];

  beforeAll(async () => {
    db = getAppDb();
    const seedDb = getSeedDb();
    await seedDb.insert(users).values([
      { id: ownerA.userId, name: "Request owner A" },
      { id: ownerB.userId, name: "Request owner B" },
      { id: agent.userId, name: "Requesting agent" },
      { id: otherAgent.userId, name: "Other agent" },
    ]);
    await seedDb.insert(billingAccounts).values([
      {
        id: ownerA.accountId,
        ownerUserId: ownerA.userId,
        balanceCredits: 0n,
      },
      {
        id: ownerB.accountId,
        ownerUserId: ownerB.userId,
        balanceCredits: 0n,
      },
    ]);

    const created = await withTenantScope(
      db,
      userActor(toUserId(agent.userId)),
      (tx) =>
        tx
          .insert(agentAccessRequests)
          .values({
            requesterPrincipalId: agent.userId,
            requesterDisplayName: "Requesting agent",
            requestedScopes: ["performance:read"],
            grantExpiresAt: future,
            approvalTokenHash,
            approvalTokenExpiresAt: tokenFuture,
          })
          .returning({ id: agentAccessRequests.id })
    );
    requestId = created[0]!.id;
    requestIds.push(requestId);
  });

  afterAll(async () => {
    const seedDb = getSeedDb();
    await seedDb
      .delete(agentAccessRequests)
      .where(inArray(agentAccessRequests.id, requestIds));
    if (grantId) {
      await seedDb
        .delete(agentCapabilityGrants)
        .where(eq(agentCapabilityGrants.id, grantId));
    }
    await seedDb
      .delete(billingAccounts)
      .where(inArray(billingAccounts.id, [ownerA.accountId, ownerB.accountId]));
    await seedDb
      .delete(users)
      .where(
        inArray(users.id, [
          ownerA.userId,
          ownerB.userId,
          agent.userId,
          otherAgent.userId,
        ])
      );
  });

  it("stores only the token hash and exposes the request only to its agent", async () => {
    const ownRows = await withTenantScope(
      db,
      userActor(toUserId(agent.userId)),
      (tx) =>
        tx
          .select({
            id: agentAccessRequests.id,
            tokenHash: agentAccessRequests.approvalTokenHash,
          })
          .from(agentAccessRequests)
          .where(eq(agentAccessRequests.id, requestId))
    );
    const ownerRows = await withTenantScope(
      db,
      userActor(toUserId(ownerA.userId)),
      (tx) =>
        tx
          .select({ id: agentAccessRequests.id })
          .from(agentAccessRequests)
          .where(eq(agentAccessRequests.id, requestId))
    );

    expect(ownRows).toEqual([{ id: requestId, tokenHash: approvalTokenHash }]);
    expect(ownRows[0]?.tokenHash).not.toBe(rawToken);
    expect(ownerRows).toEqual([]);
  });

  it("uses the production decision service to atomically bind the owner grant", async () => {
    const approved = await withTenantScope(
      db,
      userActor(toUserId(ownerA.userId)),
      (tx) =>
        decideAgentAccessRequest(tx, {
          ownerPrincipalId: ownerA.userId,
          requestId,
          tokenHash: approvalTokenHash,
          decision: "approve",
          now: new Date(),
        })
    );
    grantId = approved!.grant_id!;

    expect(approved).toMatchObject({
      id: requestId,
      // story.5006: the wire reports the canonical name. The underlying
      // request row still stores the legacy name (its equality CHECK was not
      // widened) and the minted grant carries both.
      scope: "account:read",
      status: "active",
      grant_id: grantId,
    });
  });

  it("lists active account context only for the requesting principal", async () => {
    const ownRequests = await withTenantScope(
      db,
      userActor(toUserId(agent.userId)),
      (tx) => listAgentAccessRequests(tx, agent.userId)
    );
    const otherRequests = await withTenantScope(
      db,
      userActor(toUserId(otherAgent.userId)),
      (tx) => listAgentAccessRequests(tx, otherAgent.userId)
    );

    expect(ownRequests).toEqual([
      {
        id: requestId,
        scope: "account:read",
        expires_at: future.toISOString(),
        requested_at: expect.any(String),
        decided_at: expect.any(String),
        status: "active",
        billing_account_id: ownerA.accountId,
      },
    ]);
    expect(Object.keys(ownRequests[0]!).sort()).toEqual([
      "billing_account_id",
      "decided_at",
      "expires_at",
      "id",
      "requested_at",
      "scope",
      "status",
    ]);
    expect(otherRequests).toEqual([]);
  });

  it("hides account context when the linked grant is effectively expired", async () => {
    const requests = await withTenantScope(
      db,
      userActor(toUserId(agent.userId)),
      (tx) =>
        listAgentAccessRequests(
          tx,
          agent.userId,
          new Date("2100-01-01T00:00:00.000Z")
        )
    );

    expect(requests).toEqual([
      expect.objectContaining({
        id: requestId,
        status: "expired",
        billing_account_id: null,
      }),
    ]);
  });

  it("makes the consumed token non-replayable and hides the binding from another owner", async () => {
    const replay = await withTenantScope(
      db,
      userActor(toUserId(ownerA.userId)),
      async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.agent_access_request_token_hash', ${approvalTokenHash}, true)`
        );
        return tx
          .select({ id: agentAccessRequests.id })
          .from(agentAccessRequests)
          .where(
            and(
              eq(agentAccessRequests.id, requestId),
              eq(agentAccessRequests.status, "pending")
            )
          );
      }
    );
    const otherOwner = await withTenantScope(
      db,
      userActor(toUserId(ownerB.userId)),
      async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.agent_access_request_token_hash', ${approvalTokenHash}, true)`
        );
        return tx
          .select({ id: agentAccessRequests.id })
          .from(agentAccessRequests)
          .where(eq(agentAccessRequests.id, requestId));
      }
    );

    expect(replay).toEqual([]);
    expect(otherOwner).toEqual([]);
  });

  it("lets the agent read its approved account but not mutate the request", async () => {
    const visible = await withTenantScope(
      db,
      userActor(toUserId(agent.userId)),
      (tx) =>
        tx
          .select({
            accountId: agentAccessRequests.billingAccountId,
            grantId: agentAccessRequests.approvedGrantId,
          })
          .from(agentAccessRequests)
          .where(eq(agentAccessRequests.id, requestId))
    );
    const mutated = await withTenantScope(
      db,
      userActor(toUserId(agent.userId)),
      (tx) =>
        tx
          .update(agentAccessRequests)
          .set({ status: "revoked" })
          .where(eq(agentAccessRequests.id, requestId))
          .returning({ id: agentAccessRequests.id })
    );

    expect(visible).toEqual([
      { accountId: ownerA.accountId, grantId },
    ]);
    expect(mutated).toEqual([]);
  });

  it("rolls back the grant when request finalization fails after grant creation", async () => {
    const secondRawToken = "second_approval_token_for_rollback_123456789";
    const secondTokenHash = createHash("sha256")
      .update(secondRawToken)
      .digest("hex");
    const [created] = await withTenantScope(
      db,
      userActor(toUserId(agent.userId)),
      (tx) =>
        tx
          .insert(agentAccessRequests)
          .values({
            requesterPrincipalId: agent.userId,
            requesterDisplayName: "Requesting agent",
            requestedScopes: ["performance:read"],
            grantExpiresAt: future,
            approvalTokenHash: secondTokenHash,
            approvalTokenExpiresAt: tokenFuture,
          })
          .returning({ id: agentAccessRequests.id })
    );
    const secondRequestId = created!.id;
    requestIds.push(secondRequestId);

    let failure: unknown;
    try {
      await withTenantScope(
        db,
        userActor(toUserId(ownerA.userId)),
        async (tx) => {
          await tx.execute(sql`
            CREATE FUNCTION pg_temp.reject_agent_request_finalize()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              RAISE EXCEPTION 'forced request finalization failure';
            END;
            $$
          `);
          await tx.execute(sql`
            CREATE TRIGGER reject_agent_request_finalize
            BEFORE UPDATE ON agent_access_requests
            FOR EACH ROW WHEN (NEW.status = 'approved')
            EXECUTE FUNCTION pg_temp.reject_agent_request_finalize()
          `);
          await decideAgentAccessRequest(tx, {
            ownerPrincipalId: ownerA.userId,
            requestId: secondRequestId,
            tokenHash: secondTokenHash,
            decision: "approve",
            now: new Date(),
          });
        }
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();

    const seedDb = getSeedDb();
    const requestRows = await seedDb
      .select({ status: agentAccessRequests.status })
      .from(agentAccessRequests)
      .where(eq(agentAccessRequests.id, secondRequestId));
    const activeGrants = await seedDb
      .select({
        id: agentCapabilityGrants.id,
        revokedAt: agentCapabilityGrants.revokedAt,
      })
      .from(agentCapabilityGrants)
      .where(
        and(
          eq(agentCapabilityGrants.billingAccountId, ownerA.accountId),
          eq(agentCapabilityGrants.granteePrincipalId, agent.userId)
        )
      );

    expect(requestRows).toEqual([{ status: "pending" }]);
    expect(activeGrants).toEqual([{ id: grantId, revokedAt: null }]);
  });

  it("tracks production soft revocation on the approved request", async () => {
    const revoked = await withTenantScope(
      db,
      userActor(toUserId(ownerA.userId)),
      (tx) => revokeOwnedAgentGrant(tx, ownerA.userId, grantId)
    );
    const seedDb = getSeedDb();
    const requests = await seedDb
      .select({ status: agentAccessRequests.status })
      .from(agentAccessRequests)
      .where(eq(agentAccessRequests.id, requestId));

    expect(revoked?.revoked_at).not.toBeNull();
    expect(requests).toEqual([{ status: "revoked" }]);

    const listed = await withTenantScope(
      db,
      userActor(toUserId(agent.userId)),
      (tx) => listAgentAccessRequests(tx, agent.userId)
    );
    expect(listed.find(({ id }) => id === requestId)).toMatchObject({
      status: "revoked",
      billing_account_id: null,
    });
  });

  it("returns a hard-bounded newest-first history", async () => {
    const seedDb = getSeedDb();
    const baseCreatedAt = new Date("2097-01-01T00:00:00.000Z").getTime();
    const history = Array.from({ length: 55 }, (_, index) => ({
      requesterPrincipalId: agent.userId,
      requesterDisplayName: "Requesting agent",
      requestedScopes: ["performance:read"],
      grantExpiresAt: future,
      approvalTokenHash: createHash("sha256")
        .update(`history-token-${index}`)
        .digest("hex"),
      approvalTokenExpiresAt: tokenFuture,
      status: "expired",
      createdAt: new Date(baseCreatedAt + index),
      updatedAt: new Date(baseCreatedAt + index),
    }));
    const inserted = await seedDb
      .insert(agentAccessRequests)
      .values(history)
      .returning({
        id: agentAccessRequests.id,
        createdAt: agentAccessRequests.createdAt,
      });
    requestIds.push(...inserted.map(({ id }) => id));

    const requests = await withTenantScope(
      db,
      userActor(toUserId(agent.userId)),
      (tx) => listAgentAccessRequests(tx, agent.userId)
    );
    const expectedNewest = [...inserted]
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime()
      )
      .slice(0, 50)
      .map(({ id }) => id);

    expect(requests).toHaveLength(50);
    expect(requests.map(({ id }) => id)).toEqual(expectedNewest);
    expect(
      requests.every((request) => request.billing_account_id === null)
    ).toBe(true);
  });
});

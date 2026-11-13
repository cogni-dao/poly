// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-spawn.int.test`
 * Purpose: Spawn grants against real Postgres with migration 0041 applied (task.5474): a person issues a one-time grant, an agent redeems it, the
 *   agent's principal row stores the issuer as owner, the owner lists and revokes only their own agents, and the admin table shows the owner.
 * Scope: `@cogni-dao/agent-grants/credentials` spawn store + `@cogni-dao/agent-grants` role-row read + migration 0041. No HTTP.
 * Invariants:
 *   - SERVICE_ROLE_ONLY: the app role sees no `agent_spawn_grants` row and cannot write one.
 *   - ATOMIC_REDEEM: two parallel redeems of one grant make exactly one agent.
 *   - OWNER_IS_THE_ISSUER; OWNER_SEES_ONLY_OWN; TOKEN_HASH_ONLY; DATABASE_CLOCK (expiry is moved with UPDATE on the database clock).
 * Side-effects: IO (testcontainers Postgres)
 * Notes: DATABASE_SERVICE_URL = BYPASSRLS; DATABASE_URL = app role with FORCE RLS.
 * Links: app/src/adapters/server/db/migrations/0041_agent_ownership.sql
 */

import { randomUUID } from "node:crypto";
import { createPostgresAgentGrantsStore } from "@cogni/agent-grants";
import {
  agentRolesHasRoles,
  type CredentialSql,
  confirmCredential,
  createPostgresCredentialStore,
  createPostgresSpawnStore,
  hashAgentKey,
  issueSpawnGrant,
  listOwnedAgents,
  MAX_PENDING_SPAWN_GRANTS,
  redeemSpawnGrant,
  revokeOwnedAgentKeys,
  SPAWN_GRANT_TTL_SEC,
  verifyBearer,
} from "@cogni/agent-grants/credentials";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("spawn grants (real Postgres)", () => {
  let service: Sql;
  let app: Sql;
  const users: string[] = [];
  const makeUser = async (label = "person") => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${`${label}-${id.slice(0, 6)}`})`;
    users.push(id);
    return id;
  };
  const sql = () => service as unknown as CredentialSql;
  const spawn = () => createPostgresSpawnStore(sql());
  const creds = () => createPostgresCredentialStore(sql(), { hasRoles: agentRolesHasRoles(sql()) });
  const free = async () => false;
  const issue = async (who: string) => {
    const r = await issueSpawnGrant(spawn(), { issuerUserId: who });
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    return r;
  };
  const redeem = async (grant: string, name: string, nameTaken = free) => {
    const newUserId = randomUUID();
    const r = await redeemSpawnGrant(spawn(), { grant, name, newUserId, nameTaken });
    if (r.ok && !r.retry) users.push(r.userId);
    return r;
  };
  const agentName = () => `agent-${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL || !process.env.DATABASE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 8 });
    app = postgres(process.env.DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    await service?.unsafe("DELETE FROM agent_credentials WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM agent_roles WHERE principal_user_id = ANY($1) OR approved_by = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM agent_spawn_grants WHERE issuer_user_id = ANY($1) OR redeemed_user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM agent_principals WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [users]);
    await service?.end({ timeout: 1 });
    await app?.end({ timeout: 1 });
  });

  describe("schema (rows only SQL can prove)", () => {
    it("the app role sees no spawn grant row (FORCE RLS, no policy) and cannot write one", async () => {
      const alice = await makeUser("alice");
      await issue(alice);
      expect(await app`SELECT 1 FROM agent_spawn_grants`).toHaveLength(0);
      await expect(
        app`INSERT INTO agent_spawn_grants (issuer_user_id, token_hash, expires_at) VALUES (${alice}, 'x', now() + interval '1 day')`
      ).rejects.toThrow();
    });

    it("only the sha256 of a grant is stored, never the grant", async () => {
      const alice = await makeUser("alice");
      const g = await issue(alice);
      const rows = await service`SELECT token_hash FROM agent_spawn_grants WHERE issuer_user_id = ${alice}`;
      expect(rows).toEqual([expect.objectContaining({ token_hash: await hashAgentKey(g.grant) })]);
      expect(JSON.stringify(rows)).not.toContain(g.grant);
    });

    it("an internal principal can never have an owner, and nobody owns themselves (checks)", async () => {
      const alice = await makeUser("alice");
      const target = await makeUser("agent");
      await expect(
        service`INSERT INTO agent_principals (kind, slug, user_id, owner_user_id) VALUES ('internal', ${`own-${target}`}, ${target}, ${alice})`
      ).rejects.toThrow(/agent_principals_owner_external_only/);
      await expect(
        service`INSERT INTO agent_principals (kind, user_id, owner_user_id) VALUES ('external', ${target}, ${target})`
      ).rejects.toThrow(/agent_principals_owner_not_self/);
    });

    it("redeemed_at and redeemed_user_id are set together (check)", async () => {
      const alice = await makeUser("alice");
      await expect(
        service`INSERT INTO agent_spawn_grants (issuer_user_id, token_hash, expires_at, redeemed_at) VALUES (${alice}, ${randomUUID()}, now() + interval '1 day', now())`
      ).rejects.toThrow(/agent_spawn_grants_redeemed_together/);
    });
  });

  describe("issue", () => {
    it("caps pending grants at 5 per person on the database clock; another person is not counted; expiry frees a slot", async () => {
      const alice = await makeUser("alice");
      const bob = await makeUser("bob");
      for (let i = 0; i < MAX_PENDING_SPAWN_GRANTS; i++) await issue(alice);
      expect(await issueSpawnGrant(spawn(), { issuerUserId: alice })).toEqual({ ok: false, reason: "too_many_pending" });
      expect((await issueSpawnGrant(spawn(), { issuerUserId: bob })).ok).toBe(true);
      await service`UPDATE agent_spawn_grants SET created_at = now() - interval '2 day', expires_at = now() - interval '1 day'
        WHERE id = (SELECT id FROM agent_spawn_grants WHERE issuer_user_id = ${alice} LIMIT 1)`;
      expect((await issueSpawnGrant(spawn(), { issuerUserId: alice })).ok).toBe(true);
    });

    it("a grant lives 24 hours", async () => {
      const alice = await makeUser("alice");
      const g = await issue(alice);
      const row = (await service`SELECT extract(epoch FROM (expires_at - created_at))::int AS ttl FROM agent_spawn_grants WHERE issuer_user_id = ${alice}`)[0];
      expect(row?.ttl).toBe(SPAWN_GRANT_TTL_SEC);
      expect(Date.parse(g.expiresAt)).toBeGreaterThan(Date.now());
    });

    it("an agent principal cannot issue a grant", async () => {
      const alice = await makeUser("alice");
      const agent = await redeem((await issue(alice)).grant, agentName());
      if (!agent.ok) throw new Error("unreachable");
      expect(await issueSpawnGrant(spawn(), { issuerUserId: agent.userId })).toEqual({ ok: false, reason: "agent_issuer" });
    });

    it("parallel issues never pass the cap", async () => {
      const alice = await makeUser("alice");
      const results = await Promise.all(Array.from({ length: 9 }, () => issueSpawnGrant(spawn(), { issuerUserId: alice })));
      expect(results.filter((r) => r.ok)).toHaveLength(MAX_PENDING_SPAWN_GRANTS);
    });
  });

  describe("redeem", () => {
    it("happy path: user, owned external principal, pending spawn_grant key; the issuer is the owner; the grant is marked redeemed", async () => {
      const alice = await makeUser("alice");
      const g = await issue(alice);
      const name = agentName();
      const r = await redeem(g.grant, name);
      if (!r.ok) throw new Error(`refused: ${r.reason}`);
      expect(r).toMatchObject({ ownerUserId: alice, retry: false });
      expect(await service`SELECT name, wallet_address FROM users WHERE id = ${r.userId}`).toEqual([{ name, wallet_address: null }]);
      expect(await service`SELECT kind, owner_user_id FROM agent_principals WHERE user_id = ${r.userId}`).toEqual([{ kind: "external", owner_user_id: alice }]);
      expect(await service`SELECT created_from, confirmed_at FROM agent_credentials WHERE id = ${r.credentialId}`).toEqual([{ created_from: "spawn_grant", confirmed_at: null }]);
      expect(await service`SELECT redeemed_user_id FROM agent_spawn_grants WHERE issuer_user_id = ${alice}`).toEqual([{ redeemed_user_id: r.userId }]);
      // Pending: ordinary routes (active only) refuse it; the confirm route's states accept it; after confirm it is active.
      expect(await verifyBearer(creds(), r.apiKey)).toEqual({ ok: false, reason: "invalid" });
      expect(await verifyBearer(creds(), r.apiKey, ["pending", "active"])).toMatchObject({ ok: true, userId: r.userId, state: "pending" });
      await confirmCredential(creds(), { credentialId: r.credentialId });
      expect(await verifyBearer(creds(), r.apiKey)).toMatchObject({ ok: true, userId: r.userId, state: "active" });
    });

    it("reuse is refused after confirm, whoever asks and whatever the name", async () => {
      const alice = await makeUser("alice");
      const g = await issue(alice);
      const name = agentName();
      const first = await redeem(g.grant, name);
      if (!first.ok) throw new Error("unreachable");
      await confirmCredential(creds(), { credentialId: first.credentialId });
      expect(await redeem(g.grant, name)).toEqual({ ok: false, reason: "already_redeemed" });
      expect(await redeem(g.grant, agentName())).toEqual({ ok: false, reason: "already_redeemed" });
      expect((await listOwnedAgents(spawn(), { ownerUserId: alice })).map((a) => a.name)).toEqual([name]);
    });

    it("a retry before confirm is idempotent: same agent, new pending key, the old key dead, still one agent", async () => {
      const alice = await makeUser("alice");
      const g = await issue(alice);
      const name = agentName();
      const first = await redeem(g.grant, name);
      const second = await redeem(g.grant, name);
      if (!first.ok || !second.ok) throw new Error("unreachable");
      expect(second).toMatchObject({ userId: first.userId, retry: true });
      expect(second.apiKey).not.toBe(first.apiKey);
      expect(await verifyBearer(creds(), first.apiKey, ["pending", "active"])).toEqual({ ok: false, reason: "invalid" });
      expect(await verifyBearer(creds(), second.apiKey, ["pending", "active"])).toMatchObject({ ok: true });
      expect(await listOwnedAgents(spawn(), { ownerUserId: alice })).toHaveLength(1);
    });

    it("REVOKE_IS_FINAL: after the owner revokes a never-confirmed agent, the same grant and name cannot mint a new key", async () => {
      const alice = await makeUser("alice");
      const g = await issue(alice);
      const name = agentName();
      const first = await redeem(g.grant, name);
      if (!first.ok) throw new Error("unreachable");
      expect(await revokeOwnedAgentKeys(spawn(), creds(), { ownerUserId: alice, agentUserId: first.userId })).toEqual({ ok: true, revoked: 1 });
      expect(await redeem(g.grant, name)).toEqual({ ok: false, reason: "already_redeemed" });
      expect(await verifyBearer(creds(), first.apiKey, ["pending", "active"])).toEqual({ ok: false, reason: "invalid" });
      expect(await service`SELECT count(*)::int AS n FROM agent_credentials WHERE user_id = ${first.userId} AND revoked_at IS NULL`).toEqual([{ n: 0 }]);
      expect(await listOwnedAgents(spawn(), { ownerUserId: alice })).toEqual([expect.objectContaining({ agentUserId: first.userId, keyState: "revoked" })]);
    });

    it("an expired grant is refused (retry included)", async () => {
      const alice = await makeUser("alice");
      const g = await issue(alice);
      const first = await redeem(g.grant, agentName());
      expect(first.ok).toBe(true);
      const g2 = await issue(alice);
      await service`UPDATE agent_spawn_grants SET created_at = now() - interval '2 day', expires_at = now() - interval '1 second' WHERE issuer_user_id = ${alice}`;
      expect(await redeem(g.grant, agentName())).toEqual({ ok: false, reason: "expired" });
      expect(await redeem(g2.grant, agentName())).toEqual({ ok: false, reason: "expired" });
    });

    it("an unknown or malformed grant is refused", async () => {
      expect(await redeem("cogni_sg_v1_nope", agentName())).toEqual({ ok: false, reason: "unknown" });
      expect(await redeem(`cogni_sg_v1_${"A".repeat(43)}`, agentName())).toEqual({ ok: false, reason: "unknown" });
    });

    it("ATOMIC_REDEEM: two parallel redeems of one grant make exactly one agent", async () => {
      const alice = await makeUser("alice");
      const g = await issue(alice);
      const [a, b] = await Promise.all([redeem(g.grant, agentName()), redeem(g.grant, agentName())]);
      expect([a, b].filter((r) => r.ok)).toHaveLength(1);
      expect([a, b].filter((r) => !r.ok)).toEqual([{ ok: false, reason: "already_redeemed" }]);
      expect(await listOwnedAgents(spawn(), { ownerUserId: alice })).toHaveLength(1);
    });

    it("the agent cannot bind a wallet (AGENTS_HOLD_NO_WALLET holds for a redeemed agent)", async () => {
      const alice = await makeUser("alice");
      const r = await redeem((await issue(alice)).grant, agentName());
      if (!r.ok) throw new Error("unreachable");
      await expect(
        service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${r.userId}, 'wallet', ${`0x${randomUUID().replaceAll("-", "")}`})`
      ).rejects.toThrow(/cannot bind a wallet/);
    });
  });

  describe("ownership", () => {
    it("the owner sees only their own agents, with key state and no secret", async () => {
      const alice = await makeUser("alice");
      const bob = await makeUser("bob");
      const a = await redeem((await issue(alice)).grant, agentName());
      const b = await redeem((await issue(bob)).grant, agentName());
      if (!a.ok || !b.ok) throw new Error("unreachable");
      const mine = await listOwnedAgents(spawn(), { ownerUserId: alice });
      expect(mine.map((x) => x.agentUserId)).toEqual([a.userId]);
      expect(mine[0]).toMatchObject({ keyState: "pending" });
      expect((await listOwnedAgents(spawn(), { ownerUserId: bob })).map((x) => x.agentUserId)).toEqual([b.userId]);
      expect(JSON.stringify(mine)).not.toContain(a.apiKey);
      await confirmCredential(creds(), { credentialId: a.credentialId });
      expect((await listOwnedAgents(spawn(), { ownerUserId: alice }))[0]?.keyState).toBe("active");
    });

    it("an ownerless agent is listed for nobody", async () => {
      const ownerless = await makeUser("ownerless");
      await service`INSERT INTO agent_principals (kind, user_id) VALUES ('external', ${ownerless})`;
      const alice = await makeUser("alice");
      expect(await listOwnedAgents(spawn(), { ownerUserId: alice })).toEqual([]);
      expect(await revokeOwnedAgentKeys(spawn(), creds(), { ownerUserId: alice, agentUserId: ownerless })).toEqual({ ok: false, reason: "not_found" });
    });

    it("the owner revokes: the agent's next call is refused; another person cannot revoke it", async () => {
      const alice = await makeUser("alice");
      const bob = await makeUser("bob");
      const a = await redeem((await issue(alice)).grant, agentName());
      if (!a.ok) throw new Error("unreachable");
      await confirmCredential(creds(), { credentialId: a.credentialId });
      expect(await verifyBearer(creds(), a.apiKey)).toMatchObject({ ok: true });

      expect(await revokeOwnedAgentKeys(spawn(), creds(), { ownerUserId: bob, agentUserId: a.userId })).toEqual({ ok: false, reason: "not_found" });
      expect(await verifyBearer(creds(), a.apiKey)).toMatchObject({ ok: true }); // untouched

      expect(await revokeOwnedAgentKeys(spawn(), creds(), { ownerUserId: alice, agentUserId: a.userId })).toEqual({ ok: true, revoked: 1 });
      expect(await verifyBearer(creds(), a.apiKey)).toEqual({ ok: false, reason: "invalid" });
      expect((await listOwnedAgents(spawn(), { ownerUserId: alice }))[0]?.keyState).toBe("revoked");
      expect(await service`SELECT revoked_reason, revoked_by FROM agent_credentials WHERE id = ${a.credentialId}`).toEqual([{ revoked_reason: "owner_revoked", revoked_by: alice }]);
    });

    it("a store over the app role (no BYPASSRLS) is unavailable, never an empty list", async () => {
      const wrong = createPostgresSpawnStore(app as unknown as CredentialSql);
      await expect(listOwnedAgents(wrong, { ownerUserId: await makeUser("alice") })).rejects.toMatchObject({ code: "authz_unavailable" });
    });
  });

  describe("admin table", () => {
    it("shows each outside agent's owner, or 'No owner'", async () => {
      const alice = await makeUser("alice");
      const admin = await makeUser("admin");
      const owned = await redeem((await issue(alice)).grant, agentName());
      if (!owned.ok) throw new Error("unreachable");
      const ownerless = await makeUser("ownerless");
      await service`INSERT INTO agent_principals (kind, user_id) VALUES ('external', ${ownerless})`;
      for (const id of [owned.userId, ownerless])
        await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at) VALUES (${id}, 'probe:owner', ${admin}, now())`;
      const aliceName = (await service`SELECT name FROM users WHERE id = ${alice}`)[0]?.name as string;
      const { rows } = await createPostgresAgentGrantsStore(service).listRoleRows(1000);
      const hint = (id: string) => rows.find((r) => r.principalUserId === id)?.hint;
      expect(hint(owned.userId)).toBe(`Owner: ${aliceName}`);
      expect(hint(ownerless)).toBe("No owner");
    });
  });
});

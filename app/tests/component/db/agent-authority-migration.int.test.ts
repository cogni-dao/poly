// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-authority-migration`
 * Purpose: Prove migrations 0092 (agent authority) and 0093 (Poly's own grant plane moves onto it) over Poly's REAL migration chain with isolated app, service
 *   and migration roles, and run the released grant conformance suite over the real SQL store (adopt-node-package-release step 5; the agent-grants migrations README).
 * Scope: Poly's own reviewed gate, modelled on red#88 `agent-authority-migration.int.test.ts` (head d73090d4), cut to what Poly adds:
 *   `agent_principals`, `agent_roles` and the seed. Task-owned test databases and roles, removed in teardown.
 * Invariants:
 *   - APP_ROLE_WALL: the NOBYPASSRLS app role reads no `agent_roles` row and writes neither table; it reads `agent_principals`.
 *   - SERVICE_ROLE_PRIVILEGES: the BYPASSRLS service role reads and writes both tables (the default privileges production relies on).
 *   - SEED_IS_EXACT_AND_IDEMPOTENT: two credential-less principals, two `users` rows with no wallet, zero role rows; re-running the tail changes nothing.
 *   - COPY_FORWARD_LOSES_NOTHING (0093, expand-only): every live or revoked legacy grant becomes one `agent_roles` row (same id, approver, dates, account), every pending
 *     unexpired request becomes an OFF ask with its link hash, only this plane's outside agents get an external principal row, and a legacy row that cannot map ABORTS the
 *     migration (G0, G1a-d, G2, G3) with the whole transaction rolled back. Guards count only live rows; expired never-revoked grants are left behind. The legacy tables are
 *     byte-identical afterwards (the contract migration drops them in a later release).
 *   - WALLET_GUARD (0094): the released `runAgentWalletGuardConformance` row passes over the real chain (the function exists and exactly the two payout leaf tables carry it),
 *     and the function refuses a bound or stored agent wallet.
 *   - ONE_LIVE_PREDICATE (0093): the 11 delegated SELECT policies call `agent_has_scope()`; no policy, view or function names a legacy table.
 *   - GRANT_CONFORMANCE: `runGrantConformance` passes over `createPostgresAgentGrantsStore` on the service role.
 *   - POLY_314_PURGE: on a database holding the reverted poly#314 leftovers (the three real #314 migrations, applied on top of the real chain through 0091),
 *     0092 purges exactly those objects, creates the package tables and seed, deletes no other row and leaves `user_bindings` writable; a partial shape is not purged.
 * Omissions, by design (recorded in the 0092 header too):
 *   - `runCredentialConformance`: Poly adds NO `agent_credentials` table, credential routes or trigger in this PR, so there is nothing for that suite to run
 *     against. Adopting credentials means the package tail `agent_credentials.sql` plus that suite, in the PR that adds the credential routes.
 *   - A separate migration role: Poly migrates as the database owner, which IS the app role (provision.sh model; the global setup runs `db:migrate:direct`
 *     as `app_<node>`). The migration role here is a distinct NOBYPASSRLS login that inherits the app role, as red#88's, so a migration run by a role other
 *     than the connection role is exercised too.
 * Side-effects: Postgres roles and databases (isolated, removed in teardown)
 * Links: story.0090, task.0204, task.0205, app/src/adapters/server/db/migrations/0092_agent_authority.sql, app/src/adapters/server/db/migrations/0093_account_grants_one_plane.sql
 * @internal
 */

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPostgresAgentGrantsStore,
  type SqlTag,
} from "@cogni/agent-grants";
import {
  runAgentWalletGuardConformance,
  runGrantConformance,
} from "@cogni/agent-grants/grants-conformance";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Each case clones a migrated database; a loaded CI container needs more than the default 5s for the first clone.
vi.setConfig({ testTimeout: 60_000 });

const migrations = path.resolve(
  import.meta.dirname,
  "../../../src/adapters/server/db/migrations"
);
const NODE_AI = "00000000-0000-4000-a000-0000000a0001";
const PRIORITIZER = "00000000-0000-4000-a000-0000000a0002";
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const roles = {
  app: `app_authority_${suffix}`,
  service: `service_authority_${suffix}`,
  migration: `migration_authority_${suffix}`,
};
const password = "isolated_authority_fixture";
let admin: postgres.Sql;
let through91Template: string;
let through92Template: string;
let fullTemplate: string;
let through91Folder: string;
let through92Folder: string;

function urlFor(database: string, role?: string) {
  const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
  if (!adminUrl)
    throw new Error("Component setup must provide its isolated Postgres admin URL");
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role;
    url.password = password;
  }
  return url.toString();
}

interface Handles {
  app: postgres.Sql;
  service: postgres.Sql;
  migration: postgres.Sql;
}

async function withHandles<T>(database: string, run: (h: Handles) => Promise<T>) {
  const app = postgres(urlFor(database, roles.app), { max: 1, onnotice: () => {} });
  const service = postgres(urlFor(database, roles.service), { max: 1, onnotice: () => {} });
  const migration = postgres(urlFor(database, roles.migration), { max: 1, onnotice: () => {} });
  try {
    return await run({ app, service, migration });
  } finally {
    await Promise.all([app.end(), service.end(), migration.end()]);
  }
}

async function createTemplate(name: string, folder: string) {
  await admin.unsafe(`CREATE DATABASE ${name} OWNER ${roles.app}`);
  await withHandles(name, async ({ app }) => {
    // Production's provisioner grants the service role DML on whatever the app owner creates.
    await app.unsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roles.service}`
    );
    await migrate(drizzle(app), { migrationsFolder: folder });
  });
  // The rollout role creates tables in later migrations; the provisioner grants the service role DML on those too.
  const owner = postgres(urlFor(name), { max: 1, onnotice: () => {} });
  try {
    await owner.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.migration} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roles.service}`
    );
  } finally {
    await owner.end();
  }
}

/** A journal-truncated copy of the real chain: the exact history before 0092, not a second model of it. */
async function truncatedChain(before: number) {
  const folder = await mkdtemp(path.join(tmpdir(), "poly-authority-"));
  await mkdir(path.join(folder, "meta"));
  const journal = JSON.parse(
    await readFile(path.join(migrations, "meta/_journal.json"), "utf8")
  );
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < before);
  await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries)
    await copyFile(path.join(migrations, `${e.tag}.sql`), path.join(folder, `${e.tag}.sql`));
  return folder;
}

beforeAll(async () => {
  admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  for (const [kind, name] of Object.entries(roles)) {
    await admin.unsafe(
      `CREATE ROLE ${name} LOGIN PASSWORD '${password}' ${kind === "service" ? "BYPASSRLS" : "NOBYPASSRLS"}`
    );
  }
  await admin.unsafe(`GRANT ${roles.app} TO ${roles.migration}`);
  through91Folder = await truncatedChain(92);
  through92Folder = await truncatedChain(93);
  through91Template = `authority_t91_${suffix}`;
  through92Template = `authority_t92_${suffix}`;
  fullTemplate = `authority_full_${suffix}`;
  await createTemplate(through91Template, through91Folder);
  await createTemplate(through92Template, through92Folder);
  await createTemplate(fullTemplate, migrations);
}, 240_000);

afterAll(async () => {
  for (const database of [through91Template, through92Template, fullTemplate])
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
  for (const name of [roles.migration, roles.service, roles.app])
    await admin.unsafe(`DROP ROLE IF EXISTS ${name}`);
  await admin.end();
  await rm(through91Folder, { recursive: true, force: true });
  await rm(through92Folder, { recursive: true, force: true });
}, 60_000);

/** A fresh database cloned from a migrated template (no re-run of the chain per case). */
async function fixture<T>(template: string, run: (h: Handles) => Promise<T>) {
  const database = `authority_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE ${database} TEMPLATE ${template} OWNER ${roles.app}`);
  try {
    return await withHandles(database, run);
  } finally {
    await admin.unsafe(`DROP DATABASE ${database}`);
  }
}

// The package SQL tail, exactly as 0092 appends it.
const packageTail = readFile(
  path.resolve(
    import.meta.dirname,
    "../../../node_modules/@cogni/agent-grants/migrations/agent_authority.sql"
  ),
  "utf8"
);

function statements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && !/^(--[^\n]*\n?)+$/.test(statement));
}

describe("migration 0092: agent authority tables", () => {
  it("creates both tables with FORCE RLS, the two policies and no other agent_* table", async () => {
    await fixture(fullTemplate, async ({ service }) => {
      expect(
        await service`SELECT c.relname FROM pg_class c WHERE c.oid IN ('agent_roles'::regclass,'agent_principals'::regclass)
          AND c.relrowsecurity AND c.relforcerowsecurity ORDER BY 1`
      ).toEqual([{ relname: "agent_principals" }, { relname: "agent_roles" }]);
      expect(
        await service`SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename IN ('agent_roles','agent_principals') ORDER BY 1,2`
      ).toEqual([
        { tablename: "agent_principals", policyname: "agent_principals_read", cmd: "SELECT" },
        { tablename: "agent_roles", policyname: "agent_roles_account_self_read", cmd: "SELECT" },
      ]);
      // No credentials, payer or org tables (they join in later PRs). The two legacy grant tables stay until the CONTRACT migration (0093 is expand-only).
      expect(
        await service`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'agent\\_%' ORDER BY 1`
      ).toEqual([
        { tablename: "agent_access_requests" },
        { tablename: "agent_capability_grants" },
        { tablename: "agent_principals" },
        { tablename: "agent_roles" },
      ]);
    });
  });

  it("seeds exactly node-ai and prioritizer, credential-less, with no role row", async () => {
    await fixture(fullTemplate, async ({ service }) => {
      expect(
        await service`SELECT slug, kind, user_id FROM agent_principals ORDER BY slug`
      ).toEqual([
        { slug: "node-ai", kind: "internal", user_id: NODE_AI },
        { slug: "prioritizer", kind: "internal", user_id: PRIORITIZER },
      ]);
      expect(
        await service`SELECT id, wallet_address, email FROM users WHERE id IN (${NODE_AI}, ${PRIORITIZER}) ORDER BY id`
      ).toEqual([
        { id: NODE_AI, wallet_address: null, email: null },
        { id: PRIORITIZER, wallet_address: null, email: null },
      ]);
      expect(await service`SELECT * FROM agent_roles`).toHaveLength(0);
      const store = createPostgresAgentGrantsStore(service as unknown as SqlTag);
      expect(await store.findInternalPrincipal("node-ai")).toEqual({ userId: NODE_AI });
      expect(await store.liveScopes(NODE_AI, ["sandbox:exec"])).toEqual([]);
    });
  });

  it("re-running the package tail is a no-op and leaves FORCE RLS in place", async () => {
    await fixture(fullTemplate, async ({ service, migration }) => {
      const tail = statements(await packageTail);
      expect(tail.length).toBeGreaterThan(5);
      const snapshot = async () => ({
        principals: await service`SELECT slug, user_id FROM agent_principals ORDER BY slug`,
        users: await service`SELECT id, name FROM users WHERE id IN (${NODE_AI}, ${PRIORITIZER}) ORDER BY id`,
        roles: await service`SELECT count(*)::int AS n FROM agent_roles`,
        force: await service`SELECT relname, relforcerowsecurity FROM pg_class WHERE oid IN ('agent_roles'::regclass,'agent_principals'::regclass) ORDER BY 1`,
      });
      const before = await snapshot();
      for (let run = 0; run < 2; run++)
        await migration.begin(async (tx) => {
          for (const statement of tail) await tx.unsafe(statement);
        });
      expect(await snapshot()).toEqual(before);
      expect(before.force.every((r) => r.relforcerowsecurity === true)).toBe(true);
      // 0092 itself carries the tail verbatim.
      const file = await readFile(path.join(migrations, "0092_agent_authority.sql"), "utf8");
      for (const statement of tail) expect(file).toContain(statement);
    });
  });

  it("walls the app role off agent_roles and keeps agent_principals read-only, while the service role has full privileges", async () => {
    await fixture(fullTemplate, async ({ app, service }) => {
      // App role (NOBYPASSRLS, owner of the database): FORCE RLS applies to it too.
      expect(await app`SELECT * FROM agent_roles`).toHaveLength(0);
      expect(await app`SELECT slug FROM agent_principals ORDER BY slug`).toEqual([
        { slug: "node-ai" },
        { slug: "prioritizer" },
      ]);
      await expect(
        app`INSERT INTO agent_roles(principal_user_id, scope) VALUES (${NODE_AI}, 'sandbox:exec')`
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        app`INSERT INTO agent_principals(kind, slug, user_id) VALUES ('internal', 'rogue', ${NODE_AI})`
      ).rejects.toMatchObject({ code: "42501" });
      // Service role (BYPASSRLS): reads and writes both, which proves the default privileges production relies on.
      await service`INSERT INTO agent_roles(principal_user_id, scope, approved_by, granted_at)
        VALUES (${NODE_AI}, 'sandbox:exec', ${PRIORITIZER}, now())`;
      const store = createPostgresAgentGrantsStore(service as unknown as SqlTag);
      expect(await store.liveScopes(NODE_AI, ["sandbox:exec"])).toEqual(["sandbox:exec"]);
      expect(await app`SELECT * FROM agent_roles`).toHaveLength(0); // still invisible to the app role
      await service`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${NODE_AI}`;
      expect(await store.liveScopes(NODE_AI, ["sandbox:exec"])).toEqual([]);
      const outsider = randomUUID();
      await service`INSERT INTO users(id, name) VALUES (${outsider}, 'outsider')`;
      await service`INSERT INTO agent_principals(kind, user_id) VALUES ('external', ${outsider})`;
      expect(await app`SELECT user_id FROM agent_principals WHERE kind = 'external'`).toEqual([
        { user_id: outsider },
      ]);
      // One live row per (principal, scope).
      await service`INSERT INTO agent_roles(principal_user_id, scope, approved_by, granted_at) VALUES (${NODE_AI}, 'x:y', ${PRIORITIZER}, now())`;
      await expect(
        service`INSERT INTO agent_roles(principal_user_id, scope, approved_by, granted_at) VALUES (${NODE_AI}, 'x:y', ${PRIORITIZER}, now())`
      ).rejects.toMatchObject({ code: "23505" });
    });
  });
});


/** Seed the legacy plane on a database through 0092: an owner, accounts, agents and every grant/request shape 0093 must handle. */
async function seedLegacy(service: postgres.Sql) {
  const ids = {
    owner: randomUUID(),
    ownerB: randomUUID(),
    agentA: randomUUID(), // approved through a request, legacy alias name
    agentB: randomUUID(), // both alias names, revoked by its approver
    agentC: randomUUID(), // expired, never revoked
    agentD: randomUUID(), // pending, unexpired ask
    agentE: randomUUID(), // denied request only
    agentR: randomUUID(), // renewal: a lapsed grant beside a new pending ask
    agentX: randomUUID(), // a lapsed grant on one account beside a live grant on another
    agentM: randomUUID(), // a live grant that also names a reserved scope
    human: randomUUID(), // a grantee with a wallet: a person, not an agent
    accountA: randomUUID(),
    accountB: randomUUID(),
    grantA: randomUUID(),
    grantB: randomUUID(),
    grantC: randomUUID(),
    grantH: randomUUID(),
    grantR: randomUUID(),
    grantX1: randomUUID(),
    grantX2: randomUUID(),
    grantM: randomUUID(),
    requestA: randomUUID(),
    requestD: randomUUID(),
    requestE: randomUUID(),
    requestR: randomUUID(),
  };
  const agents = [ids.agentA, ids.agentB, ids.agentC, ids.agentD, ids.agentE, ids.agentR, ids.agentX, ids.agentM];
  for (const id of [ids.owner, ids.ownerB, ...agents])
    await service`INSERT INTO users(id, name) VALUES (${id}, ${`legacy ${id.slice(0, 6)}`})`;
  await service`INSERT INTO users(id, name, wallet_address) VALUES (${ids.human}, 'legacy human', '0x00000000000000000000000000000000000000aa')`;
  await service`INSERT INTO billing_accounts(id, owner_user_id, balance_credits) VALUES (${ids.accountA}, ${ids.owner}, 0), (${ids.accountB}, ${ids.ownerB}, 0)`;
  const t = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const grant = (
    id: string,
    account: string,
    grantee: string,
    scopes: string[],
    createdDays: number,
    expiresDays: number,
    approver: string,
    revoked?: { days: number }
  ) =>
    service`INSERT INTO agent_capability_grants(id, billing_account_id, grantee_principal_id, scopes, expires_at, created_by_user_id, created_at, revoked_at, revoked_by_user_id)
      VALUES (${id}, ${account}, ${grantee}, ${scopes}, ${t(expiresDays)}, ${approver}, ${t(createdDays)}, ${revoked ? t(revoked.days) : null}, ${revoked ? approver : null})`;
  await grant(ids.grantA, ids.accountA, ids.agentA, ["performance:read"], -5, 20, ids.owner);
  await grant(ids.grantB, ids.accountA, ids.agentB, ["account:read", "performance:read"], -9, 10, ids.owner, { days: -2 });
  await grant(ids.grantC, ids.accountB, ids.agentC, ["account:read"], -31, -1, ids.ownerB);
  await grant(ids.grantH, ids.accountB, ids.human, ["account:read"], -1, 5, ids.ownerB);
  await grant(ids.grantR, ids.accountA, ids.agentR, ["performance:read"], -40, -10, ids.owner);
  await grant(ids.grantX1, ids.accountA, ids.agentX, ["performance:read"], -40, -10, ids.owner);
  await grant(ids.grantX2, ids.accountB, ids.agentX, ["performance:read"], -3, 27, ids.ownerB);
  await grant(ids.grantM, ids.accountB, ids.agentM, ["performance:read", "research:run"], -2, 28, ids.ownerB);
  const hash = (c: string) => c.repeat(64);
  await service`INSERT INTO agent_access_requests(id, requester_principal_id, requester_display_name, requested_scopes, grant_expires_at, approval_token_hash, approval_token_expires_at,
      status, billing_account_id, approved_grant_id, decision_by_user_id, decided_at, token_consumed_at, created_at)
    VALUES (${ids.requestA}, ${ids.agentA}, 'Agent A', ARRAY['performance:read'], ${t(20)}, ${hash("a")}, ${t(-4)}, 'approved', ${ids.accountA}, ${ids.grantA}, ${ids.owner}, ${t(-5)}, ${t(-5)}, ${t(-6)})`;
  await service`INSERT INTO agent_access_requests(id, requester_principal_id, requester_display_name, requested_scopes, grant_expires_at, approval_token_hash, approval_token_expires_at, status, created_at)
    VALUES (${ids.requestD}, ${ids.agentD}, 'Agent D', ARRAY['performance:read'], ${t(25)}, ${hash("d")}, ${t(1)}, 'pending', ${t(-0.1)})`;
  await service`INSERT INTO agent_access_requests(id, requester_principal_id, requester_display_name, requested_scopes, grant_expires_at, approval_token_hash, approval_token_expires_at, status, created_at)
    VALUES (${ids.requestR}, ${ids.agentR}, 'Agent R', ARRAY['performance:read'], ${t(25)}, ${hash("r")}, ${t(1)}, 'pending', ${t(-0.1)})`;
  await service`INSERT INTO agent_access_requests(id, requester_principal_id, requester_display_name, requested_scopes, grant_expires_at, approval_token_hash, approval_token_expires_at,
      status, billing_account_id, decision_by_user_id, decided_at, token_consumed_at, created_at)
    VALUES (${ids.requestE}, ${ids.agentE}, 'Agent E', ARRAY['performance:read'], ${t(25)}, ${hash("e")}, ${t(-3)}, 'denied', ${ids.accountA}, ${ids.owner}, ${t(-4)}, ${t(-4)}, ${t(-5)})`;
  return ids;
}

const legacyTables = async (sql: postgres.Sql) =>
  sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('agent_capability_grants','agent_access_requests') ORDER BY 1`;
const legacyFingerprint = async (sql: postgres.Sql) => ({
  grants: await sql`SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) AS md5, count(*)::int AS n FROM agent_capability_grants t`,
  requests: await sql`SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) AS md5, count(*)::int AS n FROM agent_access_requests t`,
  force: await sql`SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('agent_capability_grants','agent_access_requests') AND relkind = 'r' ORDER BY 1`,
});

// Poly migrates as the database owner, which IS the app role (provision.sh model), so `GRANT EXECUTE ... TO CURRENT_USER` in the package tail names the app role.
describe("migration 0093 (expand): Poly's account grant moves onto the shared plane and drops nothing", () => {
  it("copies every live or revoked grant and every pending ask forward, leaves the legacy tables byte-identical, and labels only this plane's outside agents", async () => {
    await fixture(through92Template, async ({ app, service }) => {
      const ids = await seedLegacy(service);
      const before = await service`SELECT id, created_at, expires_at, revoked_at FROM agent_capability_grants ORDER BY id`;
      const legacyBefore = await legacyFingerprint(service);
      expect(before).toHaveLength(8);
      await migrate(drizzle(app), { migrationsFolder: migrations }); // applies 0093 and 0094

      // EXPAND: nothing was dropped or changed, and FORCE row-level security is back on the legacy tables.
      expect(await legacyFingerprint(service)).toEqual(legacyBefore);
      expect(legacyBefore.force.every((r) => r.relforcerowsecurity === true)).toBe(true);

      const rows = await service`SELECT id, principal_user_id, scope, approved_by, granted_at, requested_by, created_at, revoked_at, resource, account_id, expires_at, link_hash, link_expires_at
        FROM agent_roles WHERE resource = 'account' ORDER BY id`;
      // 5 grants carry authority or history (A live, B revoked, H live, X2 live, M live) + 2 pending asks (D, R). Expired never-revoked grants (C, R's, X1) and the denied request (E) are not carried.
      expect(rows).toHaveLength(7);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      const was = Object.fromEntries(before.map((r) => [r.id, r]));
      for (const [grant, agent, account, owner] of [
        [ids.grantA, ids.agentA, ids.accountA, ids.owner],
        [ids.grantB, ids.agentB, ids.accountA, ids.owner],
        [ids.grantH, ids.human, ids.accountB, ids.ownerB],
        [ids.grantX2, ids.agentX, ids.accountB, ids.ownerB],
        [ids.grantM, ids.agentM, ids.accountB, ids.ownerB],
      ] as const) {
        expect(byId[grant]).toMatchObject({ principal_user_id: agent, scope: "account:read", approved_by: owner, resource: "account", account_id: account, link_hash: null });
        expect(byId[grant].granted_at).toEqual(was[grant].created_at);
        expect(byId[grant].created_at).toEqual(was[grant].created_at);
        expect(byId[grant].expires_at).toEqual(was[grant].expires_at); // a grant still ends on its own date
        expect(byId[grant].revoked_at).toEqual(was[grant].revoked_at);
      }
      for (const left of [ids.grantC, ids.grantR, ids.grantX1, ids.requestE]) expect(byId[left]).toBeUndefined();
      expect(byId[ids.grantA].requested_by).toBe(ids.agentA); // the approved request lives on as requested_by
      expect(byId[ids.grantB].revoked_at).not.toBeNull();
      // A pending ask is an OFF row carrying the legacy link hash, so an outstanding link still opens.
      for (const [request, agent, c] of [[ids.requestD, ids.agentD, "d"], [ids.requestR, ids.agentR, "r"]] as const)
        expect(byId[request]).toMatchObject({ principal_user_id: agent, scope: "account:read", approved_by: null, granted_at: null, account_id: null, revoked_at: null, link_hash: c.repeat(64) });
      // Principals: only the outside agents this plane copied (A, B, D, R, X, M). A person (wallet), an agent with nothing copied (C, E) and the owners get none.
      const labelled = await service`SELECT user_id FROM agent_principals WHERE kind = 'external' ORDER BY user_id`;
      expect(labelled.map((r) => r.user_id).sort()).toEqual([ids.agentA, ids.agentB, ids.agentD, ids.agentR, ids.agentX, ids.agentM].sort());
      // FORCE RLS is back on every table the migration lifted it from; billing_accounts was never touched.
      expect(
        await service`SELECT relname FROM pg_class WHERE relname IN ('users','billing_accounts','user_bindings','user_profiles','identity_events','agent_roles','agent_principals','agent_capability_grants','agent_access_requests')
          AND relkind = 'r' AND NOT relforcerowsecurity`
      ).toEqual([]);
    });
  }, 60_000);

  it("passes the two real shapes the review reproduced: a lapsed grant beside a new pending ask, and a lapsed grant beside a live grant on another account", async () => {
    await fixture(through92Template, async ({ app, service }) => {
      const owner = randomUUID();
      const other = randomUUID();
      const renewal = randomUUID();
      const split = randomUUID();
      const accountA = randomUUID();
      const accountB = randomUUID();
      for (const [id, name] of [[owner, "owner"], [other, "other owner"], [renewal, "renewal agent"], [split, "split agent"]] as const)
        await service`INSERT INTO users(id, name) VALUES (${id}, ${name})`;
      await service`INSERT INTO billing_accounts(id, owner_user_id, balance_credits) VALUES (${accountA}, ${owner}, 0), (${accountB}, ${other}, 0)`;
      const lapsed = (grantee: string, account: string, approver: string) =>
        service`INSERT INTO agent_capability_grants(billing_account_id, grantee_principal_id, scopes, expires_at, created_by_user_id, created_at)
          VALUES (${account}, ${grantee}, ARRAY['performance:read'], now() - interval '2 days', ${approver}, now() - interval '32 days')`;
      // Renewal: the grant lapsed, nothing revoked it, and the agent asked again.
      await lapsed(renewal, accountA, owner);
      await service`INSERT INTO agent_access_requests(requester_principal_id, requester_display_name, requested_scopes, grant_expires_at, approval_token_hash, approval_token_expires_at)
        VALUES (${renewal}, 'Renewal', ARRAY['performance:read'], now() + interval '25 days', ${"9".repeat(64)}, now() + interval '1 day')`;
      // Split: a lapsed grant on A and a live one on B.
      await lapsed(split, accountA, owner);
      await service`INSERT INTO agent_capability_grants(billing_account_id, grantee_principal_id, scopes, expires_at, created_by_user_id)
        VALUES (${accountB}, ${split}, ARRAY['performance:read'], now() + interval '20 days', ${other})`;

      await migrate(drizzle(app), { migrationsFolder: migrations });
      const rows = await service`SELECT principal_user_id, account_id, approved_by, link_hash FROM agent_roles WHERE resource = 'account' ORDER BY principal_user_id`;
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.principal_user_id === renewal)).toMatchObject({ account_id: null, approved_by: null, link_hash: "9".repeat(64) }); // the ask, not the lapsed grant
      expect(rows.find((r) => r.principal_user_id === split)).toMatchObject({ account_id: accountB, approved_by: other }); // the live grant, not the lapsed one
    });
  }, 60_000);

  it("maps a live grant that also names a reserved scope to account:read, and a grant that names only reserved scopes aborts (G1a)", async () => {
    await fixture(through92Template, async ({ app, service }) => {
      const ids = await seedLegacy(service);
      await migrate(drizzle(app), { migrationsFolder: migrations });
      expect(await service`SELECT scope FROM agent_roles WHERE id = ${ids.grantM}`).toEqual([{ scope: "account:read" }]);
    });
  }, 60_000);

  it("decides the same as the legacy plane through agent_has_scope() for the app role, per grant state", async () => {
    await fixture(through92Template, async ({ app, service }) => {
      const ids = await seedLegacy(service);
      await migrate(drizzle(app), { migrationsFolder: migrations });
      const has = (user: string, account: string) =>
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_user_id', ${user}, true)`;
          const [r] = await tx`SELECT agent_has_scope(${account}, 'account:read') AS ok`;
          return r?.ok;
        });
      expect(await has(ids.agentA, ids.accountA)).toBe(true); // live
      expect(await has(ids.agentA, ids.accountB)).toBe(false); // foreign account
      expect(await has(ids.agentB, ids.accountA)).toBe(false); // revoked
      expect(await has(ids.agentC, ids.accountB)).toBe(false); // expired (not copied)
      expect(await has(ids.agentR, ids.accountA)).toBe(false); // lapsed grant, pending ask: an ask opens no lock
      expect(await has(ids.agentX, ids.accountA)).toBe(false); // the lapsed grant
      expect(await has(ids.agentX, ids.accountB)).toBe(true); // the live grant
      expect(await has(ids.agentD, ids.accountA)).toBe(false); // an ask opens no lock
      expect(await has(ids.human, ids.accountB)).toBe(true);
      expect(await has(ids.agentE, ids.accountA)).toBe(false); // denied request: no grant
      const [scope] = await service`SELECT has_function_privilege('public', 'agent_has_scope(text,text)', 'EXECUTE') AS pub`;
      expect(scope?.pub).toBe(false);
    });
  }, 60_000);

  it("rewrites exactly the 11 delegated SELECT policies onto agent_has_scope and leaves none naming a legacy table", async () => {
    await fixture(fullTemplate, async ({ service }) => {
      const policies = await service`SELECT tablename, policyname FROM pg_policies WHERE qual LIKE '%agent_has_scope%' ORDER BY tablename, policyname`;
      expect(policies).toEqual([
        { tablename: "poly_algorithm_input_snapshots", policyname: "poly_algorithm_input_snapshots_select" },
        { tablename: "poly_copy_trade_decisions", policyname: "poly_copy_trade_decisions_select" },
        { tablename: "poly_copy_trade_fills", policyname: "poly_copy_trade_fills_select" },
        { tablename: "poly_copy_trade_targets", policyname: "poly_copy_trade_targets_select" },
        { tablename: "poly_position_gap_actions", policyname: "poly_position_gap_actions_select" },
        { tablename: "poly_position_gap_cohorts", policyname: "poly_position_gap_cohorts_select" },
        { tablename: "poly_position_gap_reservations", policyname: "poly_position_gap_reservations_select" },
        { tablename: "poly_position_gap_runs", policyname: "poly_position_gap_runs_select" },
        { tablename: "poly_wallet_balance_snapshots", policyname: "poly_wallet_balance_snapshots_delegated_select" },
        { tablename: "poly_wallet_connections", policyname: "poly_wallet_connections_delegated_select" },
        { tablename: "poly_wallet_grants", policyname: "poly_wallet_grants_delegated_select" },
      ]);
      // Nothing outside the two legacy tables reads them any more (the contract migration can drop them).
      expect(
        await service`SELECT tablename, policyname FROM pg_policies WHERE tablename NOT IN ('agent_capability_grants','agent_access_requests')
          AND (qual ~ 'agent_capability_grants|agent_access_requests' OR with_check ~ 'agent_capability_grants|agent_access_requests')`
      ).toEqual([]);
      expect(
        await service`SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc ~ 'agent_capability_grants|agent_access_requests'`
      ).toEqual([]);
    });
  }, 60_000);

  const abort = (
    name: string,
    guard: string,
    mutate: (service: postgres.Sql, ids: Awaited<ReturnType<typeof seedLegacy>>) => Promise<void>
  ) =>
    it(`guard ${name} aborts the migration, names the rows, and rolls everything back`, async () => {
      await fixture(through92Template, async ({ app, service }) => {
        const ids = await seedLegacy(service);
        await mutate(service, ids);
        const before = await legacyFingerprint(service);
        const accountRowsBefore = (await service`SELECT count(*)::int AS n FROM agent_roles WHERE resource = 'account'`)[0]?.n;
        await expect(migrate(drizzle(app), { migrationsFolder: migrations })).rejects.toMatchObject({
          cause: { message: expect.stringContaining(`guard ${guard}`) },
        });
        // Nothing moved: legacy tables unchanged, no account row, no function, no principal, no wallet guard (0094 is in the same rolled-back batch).
        expect(await legacyFingerprint(service)).toEqual(before);
        expect((await service`SELECT count(*)::int AS n FROM agent_roles WHERE resource = 'account'`)[0]?.n).toBe(accountRowsBefore);
        expect(await service`SELECT 1 FROM pg_proc WHERE proname IN ('agent_has_scope','agent_wallet_is_not_a_payee')`).toHaveLength(0);
        expect((await service`SELECT count(*)::int AS n FROM agent_principals WHERE kind = 'external'`)[0]?.n).toBe(0);
      });
    }, 60_000);

  abort("G1a (a grant to copy with only reserved scopes)", "G1a", async (s, ids) => {
    await s`UPDATE agent_capability_grants SET scopes = ARRAY['research:run'] WHERE id = ${ids.grantA}`;
  });
  abort("G1b (a grantee that approved itself)", "G1b", async (s, ids) => {
    await s`UPDATE agent_capability_grants SET created_by_user_id = grantee_principal_id WHERE id = ${ids.grantA}`;
  });
  abort("G1c (a revoker other than the approver)", "G1c", async (s, ids) => {
    await s`UPDATE agent_capability_grants SET revoked_by_user_id = ${ids.ownerB} WHERE id = ${ids.grantB}`;
  });
  abort("G1d (two LIVE grants for one grantee)", "G1d", async (s, ids) => {
    await s`INSERT INTO agent_capability_grants(billing_account_id, grantee_principal_id, scopes, expires_at, created_by_user_id)
      VALUES (${ids.accountB}, ${ids.agentA}, ARRAY['account:read'], now() + interval '5 days', ${ids.ownerB})`;
  });
  abort("G2 (a pending ask beside a LIVE grant of the same agent)", "G2", async (s, ids) => {
    await s`UPDATE agent_access_requests SET requester_principal_id = ${ids.agentA} WHERE id = ${ids.requestD}`;
  });
  abort("G3 (a user with no human trace that approved a grant)", "G3", async (s, ids) => {
    // agentA is a grantee (to be labelled an outside agent) and also approves another grant: a signed-in human, which no-trace users never are.
    await s`UPDATE agent_capability_grants SET created_by_user_id = ${ids.agentA} WHERE id = ${ids.grantH}`;
  });
  abort("G0 (account rows already in agent_roles)", "G0", async (s, ids) => {
    await s`INSERT INTO agent_roles(principal_user_id, scope, approved_by, granted_at, resource, account_id)
      VALUES (${ids.agentE}, 'account:read', ${ids.owner}, now(), 'account', ${ids.accountA})`;
  });

  it("is a no-op on a database with no legacy rows: nothing is copied and the legacy tables stay", async () => {
    await fixture(through92Template, async ({ app, service }) => {
      await migrate(drizzle(app), { migrationsFolder: migrations });
      expect((await legacyTables(service)).length).toBe(2);
      expect(await service`SELECT * FROM agent_roles`).toHaveLength(0);
    });
  }, 60_000);
});

describe("migration 0094: AGENT_WALLET_IS_NOT_A_PAYEE", () => {
  it("refuses a payee wallet that belongs to an agent principal (bound or stored), and allows a person's wallet", async () => {
    await fixture(fullTemplate, async ({ app, service }) => {
      const agentBound = randomUUID();
      const agentStored = randomUUID();
      const person = randomUUID();
      await service`INSERT INTO users(id, name) VALUES (${agentBound}, 'bound agent')`;
      await service`INSERT INTO users(id, name, wallet_address) VALUES (${agentStored}, 'stored agent', '0xAAAA00000000000000000000000000000000AAAA'), (${person}, 'person', '0xBBBB00000000000000000000000000000000BBBB')`;
      await service`INSERT INTO user_bindings(id, user_id, provider, external_id) VALUES (${randomUUID()}, ${agentBound}, 'wallet', '0xCCCC00000000000000000000000000000000CCCC')`;
      await service`INSERT INTO agent_principals(kind, user_id) VALUES ('external', ${agentBound}), ('external', ${agentStored})`;
      // The guard is the trigger FUNCTION; attach it to a scratch table with the leaf shape so the case needs no attribution fixtures.
      await app`CREATE TABLE scratch_leaf (account_lower text NOT NULL)`;
      await app`CREATE TRIGGER scratch_leaf_guard BEFORE INSERT ON scratch_leaf FOR EACH ROW EXECUTE FUNCTION agent_wallet_is_not_a_payee()`;
      // Leaf rows are written by the BYPASSRLS service role (the function is not security definer, so the invoker must see users and user_bindings).
      for (const wallet of ["0xcccc00000000000000000000000000000000cccc", "0xaaaa00000000000000000000000000000000aaaa"])
        await expect(service`INSERT INTO scratch_leaf(account_lower) VALUES (${wallet})`).rejects.toMatchObject({ code: "23514", constraint_name: "agent_wallet_is_not_a_payee" });
      await service`INSERT INTO scratch_leaf(account_lower) VALUES ('0xbbbb00000000000000000000000000000000bbbb')`;
      await service`INSERT INTO scratch_leaf(account_lower) VALUES ('0xdddd00000000000000000000000000000000dddd')`;
      expect(await service`SELECT count(*)::int AS n FROM scratch_leaf`).toEqual([{ n: 2 }]);
    });
  }, 60_000);
});

// The released conformance row: the guard function exists and exactly the two payout leaf tables carry it (SUITE_GATES_RELEASE).
let walletGuardService: postgres.Sql;
runAgentWalletGuardConformance({
  describe,
  it: (name, run) =>
    it(name, () =>
      fixture(fullTemplate, async ({ service }) => {
        walletGuardService = service;
        await run();
      })
    ),
  expect,
  get sql() {
    return walletGuardService as unknown as SqlTag;
  },
  leafTables: ["epoch_distribution_leaves", "distribution_settlement_leaves"],
});

/**
 * The reverted poly#314 (story.5158) left its identity tables, functions and triggers on the candidate-a and preview databases. The files
 * under tests/_fixtures/db/poly-314 are those three migrations, verbatim from #314's merge commit 3674c3db5 (reverted by #317).
 */
const poly314Files = ["0092_agent_identity", "0093_agent_spawn_grants", "0094_agent_personal_grants"];
const poly314Fixtures = path.resolve(import.meta.dirname, "../../_fixtures/db/poly-314");
const poly314Objects = {
  tables: ["agent_credentials", "agent_spawn_grants", "agent_claims"],
  functions: [
    "agent_principals_refuse_wallet_binding",
    "agent_credential_state",
    "agent_credentials_require_external_principal",
  ],
  triggers: ["agent_principals_no_wallet_binding", "agent_credentials_external_principal_only"],
};

async function applyPoly314(app: postgres.Sql) {
  for (const file of poly314Files) {
    const text = await readFile(path.join(poly314Fixtures, `${file}.sql`), "utf8");
    await app.begin(async (tx) => {
      for (const statement of text
        .split("--> statement-breakpoint")
        .map((chunk) => chunk.trim())
        .filter(Boolean))
        await tx.unsafe(statement);
    });
  }
}

async function poly314Presence(sql: postgres.Sql) {
  return {
    tables: await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(${poly314Objects.tables}) ORDER BY 1`,
    functions: await sql`SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY(${poly314Objects.functions}) ORDER BY 1`,
    triggers: await sql`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY(${poly314Objects.triggers}) ORDER BY 1`,
    retiredColumns: await sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
      AND ((table_name = 'agent_roles' AND column_name IN ('resource_kind','owner_user_id')) OR (table_name = 'agent_principals' AND column_name = 'owner_user_id')) ORDER BY 1,2`,
  };
}

describe("migration 0092 on a database holding the reverted poly#314 leftovers (CEO-approved purge, forward-looking only)", () => {
  it("purges exactly the #314 objects, creates the package tables, keeps the seed users, deletes no other row, and leaves user_bindings writable", async () => {
    await fixture(through91Template, async ({ app, service, migration }) => {
      await applyPoly314(app);
      // The leftovers really are there, with #314's data in them, and the hook on user_bindings is live.
      expect((await poly314Presence(service)).tables).toHaveLength(3);
      expect((await poly314Presence(service)).triggers).toHaveLength(2);
      const agent = randomUUID();
      await service`INSERT INTO users(id, name) VALUES (${agent}, 'poly314 agent'), ('outside-user', 'Outside user')`;
      await service`INSERT INTO agent_principals(kind, user_id) VALUES ('external', ${agent})`;
      await service`INSERT INTO agent_roles(principal_user_id, scope, approved_by, granted_at) VALUES (${agent}, 'knowledge:read', 'outside-user', now())`;
      await service`INSERT INTO agent_credentials(user_id, token_hash, created_from, expires_at, renew_until)
        VALUES (${agent}, 'h', 'key_upgrade', now() + interval '1 day', now() + interval '2 day')`;
      await expect(
        service`INSERT INTO user_bindings(id, user_id, provider, external_id) VALUES (${randomUUID()}, ${agent}, 'wallet', '0xabc')`
      ).rejects.toMatchObject({ code: "23514" }); // #314's trigger refuses a wallet for an agent principal
      // Rows that must survive: seed users, a legacy grant, an ordinary user, billing data.
      await service`INSERT INTO billing_accounts(id, owner_user_id, balance_credits) VALUES ('keep-account','outside-user',0)`;
      await service`INSERT INTO agent_capability_grants(billing_account_id, grantee_principal_id, scopes, expires_at, created_by_user_id)
        VALUES ('keep-account', ${agent}, ARRAY['account:read'], now() + interval '10 days', 'outside-user')`;
      const keep = async () => ({
        users: await service`SELECT id, name FROM users WHERE id NOT IN ('00000000-0000-4000-a000-0000000a0001','00000000-0000-4000-a000-0000000a0002') ORDER BY id`,
        seedUsers: await service`SELECT id, name FROM users WHERE id IN (${NODE_AI}, ${PRIORITIZER}) ORDER BY id`,
        billing: await service`SELECT id FROM billing_accounts ORDER BY id`,
        legacyGrants: await service`SELECT count(*)::int AS n FROM agent_capability_grants`,
      });
      const before = await keep();
      expect(before.seedUsers).toHaveLength(2); // seeded by #314 with the same IDs the package seed uses

      await migrate(drizzle(migration), { migrationsFolder: through92Folder }); // applies only 0092

      // The #314 objects are gone.
      expect(await poly314Presence(service)).toEqual({
        tables: [],
        functions: [],
        triggers: [],
        retiredColumns: [],
      });
      // The package tables exist exactly as on a fresh database, with the exact seed and no role row.
      expect(
        await service`SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_principals' AND column_name = 'owner_source_kind'`
      ).toHaveLength(1);
      expect(
        await service`SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_roles' AND column_name IN ('resource','account_id') ORDER BY 1`
      ).toEqual([{ column_name: "account_id" }, { column_name: "resource" }]);
      expect(await service`SELECT slug, kind, user_id FROM agent_principals ORDER BY slug`).toEqual([
        { slug: "node-ai", kind: "internal", user_id: NODE_AI },
        { slug: "prioritizer", kind: "internal", user_id: PRIORITIZER },
      ]);
      expect(await service`SELECT * FROM agent_roles`).toHaveLength(0);
      expect(
        await service`SELECT c.relname FROM pg_class c WHERE c.oid IN ('agent_roles'::regclass,'agent_principals'::regclass)
          AND c.relrowsecurity AND c.relforcerowsecurity ORDER BY 1`
      ).toEqual([{ relname: "agent_principals" }, { relname: "agent_roles" }]);
      // Nothing else was touched: the seed users were upserted (not duplicated), every other row is identical.
      expect(await keep()).toEqual(before);
      // user_bindings writes work with the hook gone, including the wallet binding #314 refused.
      await service`INSERT INTO user_bindings(id, user_id, provider, external_id) VALUES (${randomUUID()}, ${agent}, 'wallet', '0xabc')`;
      await service`INSERT INTO user_bindings(id, user_id, provider, external_id) VALUES (${randomUUID()}, 'outside-user', 'wallet', '0xdef')`;
      expect(await service`SELECT count(*)::int AS n FROM user_bindings WHERE external_id IN ('0xabc','0xdef')`).toEqual([{ n: 2 }]);
      // A re-run is a no-op: the journal skips 0092, and the guard itself is false on the migrated database.
      await migrate(drizzle(migration), { migrationsFolder: through92Folder });
      const file = await readFile(path.join(migrations, "0092_agent_authority.sql"), "utf8");
      const guard = file.slice(file.indexOf("DO $poly314$"), file.indexOf("--> statement-breakpoint"));
      expect(guard).toContain("DROP TABLE");
      await migration.begin(async (tx) => {
        await tx.unsafe(guard.trim());
      });
      expect(await service`SELECT slug FROM agent_principals ORDER BY slug`).toEqual([
        { slug: "node-ai" },
        { slug: "prioritizer" },
      ]);
      expect(await keep()).toEqual(before);
    });
  }, 60_000);

  it("does not run for a database with only part of the #314 shape: it keeps failing loudly and changes nothing", async () => {
    await fixture(through91Template, async ({ app, service, migration }) => {
      await applyPoly314(app);
      await app.unsafe(`DROP TRIGGER agent_credentials_external_principal_only ON agent_credentials`);
      await expect(
        migrate(drizzle(migration), { migrationsFolder: through92Folder })
      ).rejects.toMatchObject({ cause: { code: "42P07" } });
      expect((await poly314Presence(service)).tables).toHaveLength(3);
      expect(await service`SELECT to_regclass('public.agent_principals')::text AS t`).toEqual([{ t: "agent_principals" }]);
      expect(
        await service`SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_principals' AND column_name = 'owner_user_id'`
      ).toHaveLength(1); // still #314's table, untouched
    });
  }, 60_000);
});

// The released behavioral contract over the adopted SQL store, each case in its own database cloned from the migrated template,
// with the store on the BYPASSRLS service role exactly as the app composes it.
let conformanceService: postgres.Sql;
runGrantConformance({
  describe,
  it: (name, run) =>
    it(name, () =>
      fixture(fullTemplate, async ({ service }) => {
        conformanceService = service;
        await run();
      })
    ),
  expect,
  async setup(spec) {
    const ids: Record<string, string> = {};
    const accounts: Record<string, string> = {};
    for (const name of [...spec.owners, ...spec.agents, ...spec.internal]) {
      const id = name === "node-ai" ? NODE_AI : name === "prioritizer" ? PRIORITIZER : randomUUID();
      ids[name] = id;
      await conformanceService`INSERT INTO users(id,name) VALUES (${id},${name}) ON CONFLICT(id) DO NOTHING`;
      if (spec.internal.includes(name)) {
        await conformanceService`INSERT INTO agent_principals(kind,slug,user_id) VALUES ('internal',${name},${id}) ON CONFLICT(user_id) DO NOTHING`;
      } else if (spec.agents.includes(name)) {
        await conformanceService`INSERT INTO agent_principals(kind,user_id) VALUES ('external',${id})`;
      }
      if (spec.owners.includes(name)) {
        accounts[name] = randomUUID();
        await conformanceService`INSERT INTO billing_accounts(id,owner_user_id,balance_credits) VALUES (${accounts[name]},${id},0)`;
      }
    }
    return {
      ids,
      accounts,
      store: createPostgresAgentGrantsStore(conformanceService as unknown as SqlTag),
    };
  },
  async expireGrant(id, scope) {
    await conformanceService`UPDATE agent_roles SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE principal_user_id = ${id} AND scope = ${scope} AND revoked_at IS NULL`;
  },
  async expireLink(id, scope) {
    await conformanceService`UPDATE agent_roles SET link_expires_at = now() - interval '1 day' WHERE principal_user_id = ${id} AND scope = ${scope} AND revoked_at IS NULL`;
  },
  broken: () =>
    createPostgresAgentGrantsStore(() => {
      throw new Error("isolated test outage");
    }),
});

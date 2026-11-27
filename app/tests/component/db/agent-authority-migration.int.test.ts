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
 *   - COPY_FORWARD_LOSES_NOTHING (0093): every legacy grant becomes one `agent_roles` row (same id, approver, dates, account), every pending unexpired request
 *     becomes an OFF ask with its link hash, outside agents get an external principal row, and a legacy row that cannot map ABORTS the migration (G0, G1a-d, G2) with
 *     the whole transaction rolled back. The drop guard blocks while anything still names a legacy table.
 *   - ONE_LIVE_PREDICATE (0093): the 11 delegated SELECT policies call `agent_has_scope()`; no policy, view or function names a legacy table.
 *   - GRANT_CONFORMANCE: `runGrantConformance` passes over `createPostgresAgentGrantsStore` on the service role.
 *   - POLY_314_PURGE: on a database holding the reverted poly#314 leftovers (the three real #314 migrations, applied on top of the real chain through 0091),
 *     0092 purges exactly those objects, creates the package tables and seed, deletes no other row and leaves `user_bindings` writable; a partial shape is not purged.
 * Omissions, by design (recorded in the 0092 header too):
 *   - `runCredentialConformance`: Poly adds NO `agent_credentials` table, credential routes or trigger in this PR, so there is nothing for that suite to run
 *     against. Adopting credentials means the package tail `agent_credentials.sql` plus that suite, in the PR that adds the credential routes.
 *   - `runAgentWalletGuardConformance`: Poly binds no agent wallet and has no wallet-guard trigger yet (node-template 0043 is not ported).
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
import { runGrantConformance } from "@cogni/agent-grants/grants-conformance";
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
      // No credentials, payer or org tables (they join in later PRs), and no legacy grant plane (0093 dropped it).
      expect(
        await service`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'agent\\_%' ORDER BY 1`
      ).toEqual([{ tablename: "agent_principals" }, { tablename: "agent_roles" }]);
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
    human: randomUUID(), // a grantee with a wallet: a person, not an agent
    accountA: randomUUID(),
    accountB: randomUUID(),
    grantA: randomUUID(),
    grantB: randomUUID(),
    grantC: randomUUID(),
    grantH: randomUUID(),
    requestA: randomUUID(),
    requestD: randomUUID(),
    requestE: randomUUID(),
  };
  const agents = [ids.agentA, ids.agentB, ids.agentC, ids.agentD, ids.agentE];
  for (const id of [ids.owner, ids.ownerB, ...agents])
    await service`INSERT INTO users(id, name) VALUES (${id}, ${`legacy ${id.slice(0, 6)}`})`;
  await service`INSERT INTO users(id, name, wallet_address) VALUES (${ids.human}, 'legacy human', '0x00000000000000000000000000000000000000aa')`;
  await service`INSERT INTO billing_accounts(id, owner_user_id, balance_credits) VALUES (${ids.accountA}, ${ids.owner}, 0), (${ids.accountB}, ${ids.ownerB}, 0)`;
  const t = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  await service`INSERT INTO agent_capability_grants(id, billing_account_id, grantee_principal_id, scopes, expires_at, created_by_user_id, created_at)
    VALUES (${ids.grantA}, ${ids.accountA}, ${ids.agentA}, ARRAY['performance:read'], ${t(20)}, ${ids.owner}, ${t(-5)})`;
  await service`INSERT INTO agent_capability_grants(id, billing_account_id, grantee_principal_id, scopes, expires_at, created_by_user_id, created_at, revoked_at, revoked_by_user_id)
    VALUES (${ids.grantB}, ${ids.accountA}, ${ids.agentB}, ARRAY['account:read','performance:read'], ${t(10)}, ${ids.owner}, ${t(-9)}, ${t(-2)}, ${ids.owner})`;
  await service`INSERT INTO agent_capability_grants(id, billing_account_id, grantee_principal_id, scopes, expires_at, created_by_user_id, created_at)
    VALUES (${ids.grantC}, ${ids.accountB}, ${ids.agentC}, ARRAY['account:read'], ${t(-1)}, ${ids.ownerB}, ${t(-31)})`;
  await service`INSERT INTO agent_capability_grants(id, billing_account_id, grantee_principal_id, scopes, expires_at, created_by_user_id, created_at)
    VALUES (${ids.grantH}, ${ids.accountB}, ${ids.human}, ARRAY['account:read'], ${t(5)}, ${ids.ownerB}, ${t(-1)})`;
  const hash = (c: string) => c.repeat(64);
  await service`INSERT INTO agent_access_requests(id, requester_principal_id, requester_display_name, requested_scopes, grant_expires_at, approval_token_hash, approval_token_expires_at,
      status, billing_account_id, approved_grant_id, decision_by_user_id, decided_at, token_consumed_at, created_at)
    VALUES (${ids.requestA}, ${ids.agentA}, 'Agent A', ARRAY['performance:read'], ${t(20)}, ${hash("a")}, ${t(-4)}, 'approved', ${ids.accountA}, ${ids.grantA}, ${ids.owner}, ${t(-5)}, ${t(-5)}, ${t(-6)})`;
  await service`INSERT INTO agent_access_requests(id, requester_principal_id, requester_display_name, requested_scopes, grant_expires_at, approval_token_hash, approval_token_expires_at, status, created_at)
    VALUES (${ids.requestD}, ${ids.agentD}, 'Agent D', ARRAY['performance:read'], ${t(25)}, ${hash("d")}, ${t(1)}, 'pending', ${t(-0.1)})`;
  await service`INSERT INTO agent_access_requests(id, requester_principal_id, requester_display_name, requested_scopes, grant_expires_at, approval_token_hash, approval_token_expires_at,
      status, billing_account_id, decision_by_user_id, decided_at, token_consumed_at, created_at)
    VALUES (${ids.requestE}, ${ids.agentE}, 'Agent E', ARRAY['performance:read'], ${t(25)}, ${hash("e")}, ${t(-3)}, 'denied', ${ids.accountA}, ${ids.owner}, ${t(-4)}, ${t(-4)}, ${t(-5)})`;
  return ids;
}

const legacyTables = async (sql: postgres.Sql) =>
  sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('agent_capability_grants','agent_access_requests') ORDER BY 1`;

// Poly migrates as the database owner, which IS the app role (provision.sh model), so `GRANT EXECUTE ... TO CURRENT_USER` in the package tail names the app role.
describe("migration 0093: Poly's account grant moves onto the shared plane", () => {
  it("copies every legacy grant and pending ask forward, drops the legacy plane, and backfills outside agents", async () => {
    await fixture(through92Template, async ({ app, service }) => {
      const ids = await seedLegacy(service);
      const before = await service`SELECT id, created_at, expires_at, revoked_at FROM agent_capability_grants ORDER BY id`;
      expect(before).toHaveLength(4);
      await migrate(drizzle(app), { migrationsFolder: migrations }); // applies only 0093

      expect(await legacyTables(service)).toEqual([]);
      const rows = await service`SELECT id, principal_user_id, scope, approved_by, granted_at, requested_by, created_at, revoked_at, resource, account_id, expires_at, link_hash, link_expires_at
        FROM agent_roles WHERE resource = 'account' ORDER BY id`;
      expect(rows).toHaveLength(5); // 4 grants + 1 pending ask; the denied request is lifecycle history and is not carried
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      const was = Object.fromEntries(before.map((r) => [r.id, r]));
      // Grant rows keep id, approver, dates and account; the alias becomes the one scope; both alias names collapse to one row.
      for (const [grant, agent, account, owner] of [
        [ids.grantA, ids.agentA, ids.accountA, ids.owner],
        [ids.grantB, ids.agentB, ids.accountA, ids.owner],
        [ids.grantC, ids.agentC, ids.accountB, ids.ownerB],
        [ids.grantH, ids.human, ids.accountB, ids.ownerB],
      ] as const) {
        expect(byId[grant]).toMatchObject({ principal_user_id: agent, scope: "account:read", approved_by: owner, resource: "account", account_id: account, link_hash: null });
        expect(byId[grant].granted_at).toEqual(was[grant].created_at);
        expect(byId[grant].created_at).toEqual(was[grant].created_at);
        expect(byId[grant].expires_at).toEqual(was[grant].expires_at); // a grant still ends on its own date
        expect(byId[grant].revoked_at).toEqual(was[grant].revoked_at);
      }
      expect(byId[ids.grantA].requested_by).toBe(ids.agentA); // the approved request lives on as requested_by
      expect(byId[ids.grantB].revoked_at).not.toBeNull();
      // The pending ask is an OFF row carrying the legacy link hash, so an outstanding link still opens.
      expect(byId[ids.requestD]).toMatchObject({
        principal_user_id: ids.agentD,
        scope: "account:read",
        approved_by: null,
        granted_at: null,
        account_id: null,
        revoked_at: null,
        link_hash: "d".repeat(64),
      });
      expect(await service`SELECT 1 FROM agent_roles WHERE id = ${ids.requestE}`).toHaveLength(0);
      // Outside agents get an external principal; a person (wallet) gets none; the owners (users, no wallet) are labelled by the same precision rule.
      const principals = await service`SELECT user_id FROM agent_principals WHERE kind = 'external' AND user_id = ANY(${[ids.agentA, ids.agentB, ids.agentC, ids.agentD, ids.agentE, ids.human]}) ORDER BY user_id`;
      expect(principals.map((r) => r.user_id).sort()).toEqual([ids.agentA, ids.agentB, ids.agentC, ids.agentD, ids.agentE].sort());
      // FORCE RLS is back on every table the migration lifted it from.
      const force = await service`SELECT relname FROM pg_class WHERE relname IN ('users','billing_accounts','user_bindings','user_profiles','identity_events','agent_roles','agent_principals')
        AND relkind = 'r' AND NOT relforcerowsecurity`;
      expect(force).toEqual([]);
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
      expect(await has(ids.agentC, ids.accountB)).toBe(false); // expired
      expect(await has(ids.agentD, ids.accountA)).toBe(false); // an ask opens no lock
      expect(await has(ids.human, ids.accountB)).toBe(true);
      expect(await has(ids.agentE, ids.accountA)).toBe(false); // denied request: no grant
      const [scope] = await service`SELECT has_function_privilege('public', 'agent_has_scope(text,text)', 'EXECUTE') AS pub`;
      expect(scope?.pub).toBe(false);
    });
  }, 60_000);

  it("rewrites exactly the 11 delegated SELECT policies onto agent_has_scope and leaves no object naming a legacy table", async () => {
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
      expect(
        await service`SELECT tablename, policyname FROM pg_policies WHERE qual ~ 'agent_capability_grants|agent_access_requests' OR with_check ~ 'agent_capability_grants|agent_access_requests'`
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
        const counts = async () => ({
          grants: (await service`SELECT count(*)::int AS n FROM agent_capability_grants`)[0]?.n,
          requests: (await service`SELECT count(*)::int AS n FROM agent_access_requests`)[0]?.n,
        });
        const before = await counts();
        await expect(migrate(drizzle(app), { migrationsFolder: migrations })).rejects.toMatchObject({
          cause: { message: expect.stringContaining(`guard ${guard}`) },
        });
        // Nothing moved: both legacy tables and their rows, no account row, no function, no journal entry past 0092.
        expect((await legacyTables(service)).length).toBe(2);
        expect(await counts()).toEqual(before);
        expect((await service`SELECT count(*)::int AS n FROM agent_roles WHERE resource = 'account' AND id IN (SELECT id FROM agent_capability_grants)`)[0]?.n).toBe(0);
        expect(await service`SELECT 1 FROM pg_proc WHERE proname = 'agent_has_scope'`).toHaveLength(0);
        expect((await service`SELECT count(*)::int AS n FROM agent_principals WHERE kind = 'external'`)[0]?.n).toBe(0);
      });
    }, 60_000);

  abort("G1a (a scope with no shared grant)", "G1a", async (s, ids) => {
    await s`UPDATE agent_capability_grants SET scopes = ARRAY['account:read','research:run'] WHERE id = ${ids.grantA}`;
  });
  abort("G1b (a grantee that approved itself)", "G1b", async (s, ids) => {
    await s`UPDATE agent_capability_grants SET created_by_user_id = grantee_principal_id WHERE id = ${ids.grantA}`;
  });
  abort("G1c (a revoker other than the approver)", "G1c", async (s, ids) => {
    await s`UPDATE agent_capability_grants SET revoked_by_user_id = ${ids.ownerB} WHERE id = ${ids.grantB}`;
  });
  abort("G1d (two non-revoked grants for one grantee)", "G1d", async (s, ids) => {
    await s`INSERT INTO agent_capability_grants(billing_account_id, grantee_principal_id, scopes, expires_at, created_by_user_id)
      VALUES (${ids.accountB}, ${ids.agentA}, ARRAY['account:read'], now() + interval '5 days', ${ids.ownerB})`;
  });
  abort("G2 (a pending ask beside a live grant of the same agent)", "G2", async (s, ids) => {
    await s`UPDATE agent_access_requests SET requester_principal_id = ${ids.agentA} WHERE id = ${ids.requestD}`;
  });
  abort("G0 (account rows already in agent_roles)", "G0", async (s, ids) => {
    await s`INSERT INTO agent_roles(principal_user_id, scope, approved_by, granted_at, resource, account_id)
      VALUES (${ids.agentE}, 'account:read', ${ids.owner}, now(), 'account', ${ids.accountA})`;
  });

  it("blocks the drop while a view still names a legacy table, and rolls the copy back", async () => {
    await fixture(through92Template, async ({ app, service }) => {
      await seedLegacy(service);
      await app`CREATE VIEW legacy_grant_view AS SELECT id FROM agent_capability_grants`;
      await expect(migrate(drizzle(app), { migrationsFolder: migrations })).rejects.toMatchObject({
        cause: { message: expect.stringContaining("0093 drop guard") },
      });
      expect((await legacyTables(service)).length).toBe(2);
      expect((await service`SELECT count(*)::int AS n FROM agent_roles WHERE resource = 'account'`)[0]?.n).toBe(0);
    });
  }, 60_000);

  it("is a no-op on a database with no legacy rows: the plane is dropped and nothing is copied", async () => {
    await fixture(through92Template, async ({ app, service }) => {
      await migrate(drizzle(app), { migrationsFolder: migrations });
      expect(await legacyTables(service)).toEqual([]);
      expect(await service`SELECT * FROM agent_roles`).toHaveLength(0);
    });
  }, 60_000);
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

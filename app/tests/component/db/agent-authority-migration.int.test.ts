// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-authority-migration`
 * Purpose: Prove migration 0092 (agent authority) over Poly's REAL migration chain with isolated app, service and migration roles, and
 *   run the released grant conformance suite over the real SQL store (adopt-node-package-release step 5; the agent-grants migrations README).
 * Scope: Poly's own reviewed gate, modelled on red#88 `agent-authority-migration.int.test.ts` (head d73090d4), cut to what Poly adds:
 *   `agent_principals`, `agent_roles` and the seed. Task-owned test databases and roles, removed in teardown.
 * Invariants:
 *   - APP_ROLE_WALL: the NOBYPASSRLS app role reads no `agent_roles` row and writes neither table; it reads `agent_principals`.
 *   - SERVICE_ROLE_PRIVILEGES: the BYPASSRLS service role reads and writes both tables (the default privileges production relies on).
 *   - SEED_IS_EXACT_AND_IDEMPOTENT: two credential-less principals, two `users` rows with no wallet, zero role rows; re-running the tail changes nothing.
 *   - LEGACY_PLANE_UNCHANGED: `agent_capability_grants`, its rows and every policy that reads it are byte-identical before and after 0092.
 *   - GRANT_CONFORMANCE: `runGrantConformance` passes over `createPostgresAgentGrantsStore` on the service role.
 * Omissions, by design (recorded in the 0092 header too):
 *   - `runCredentialConformance`: Poly adds NO `agent_credentials` table, credential routes or trigger in this PR, so there is nothing for that suite to run
 *     against. Adopting credentials means the package tail `agent_credentials.sql` plus that suite, in the PR that adds the credential routes.
 *   - `runAgentWalletGuardConformance` and the package tail `agent_account_grants.sql` (`agent_has_scope()`): deferred to the grant-plane retirement PR,
 *     which writes Poly's own delegated select policies on those functions and its own wallet guard.
 *   - A separate migration role: Poly migrates as the database owner, which IS the app role (provision.sh model; the global setup runs `db:migrate:direct`
 *     as `app_<node>`). The migration role here is a distinct NOBYPASSRLS login that inherits the app role, as red#88's, so a migration run by a role other
 *     than the connection role is exercised too.
 * Side-effects: Postgres roles and databases (isolated, removed in teardown)
 * Links: story.0090, task.0204, app/src/adapters/server/db/migrations/0092_agent_authority.sql
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
let fullTemplate: string;
let through91Folder: string;

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
  through91Template = `authority_t91_${suffix}`;
  fullTemplate = `authority_full_${suffix}`;
  await createTemplate(through91Template, through91Folder);
  await createTemplate(fullTemplate, migrations);
}, 240_000);

afterAll(async () => {
  for (const database of [through91Template, fullTemplate])
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
  for (const name of [roles.migration, roles.service, roles.app])
    await admin.unsafe(`DROP ROLE IF EXISTS ${name}`);
  await admin.end();
  await rm(through91Folder, { recursive: true, force: true });
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
      // No credentials, payer or org tables: they join in later PRs.
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

/** Everything that defines the legacy account-grant plane: its table, its rows, and every policy anywhere that reads it. */
async function legacyFingerprint(sql: postgres.Sql) {
  return {
    columns: await sql`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'agent_capability_grants' ORDER BY ordinal_position`,
    constraints: await sql`SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
      WHERE conrelid = 'public.agent_capability_grants'::regclass ORDER BY conname`,
    indexes: await sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'agent_capability_grants' ORDER BY indexname`,
    force: await sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.agent_capability_grants'::regclass`,
    ownPolicies: await sql`SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'agent_capability_grants' ORDER BY policyname`,
    readers: await sql`SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
      WHERE qual LIKE '%agent_capability_grants%' OR with_check LIKE '%agent_capability_grants%' ORDER BY tablename, policyname`,
    rows: await sql`SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) AS md5, count(*)::int AS n FROM agent_capability_grants t`,
    accessRequests: await sql`SELECT count(*)::int AS n FROM agent_access_requests`,
  };
}

describe("migration 0092 leaves Poly's own grant plane untouched", () => {
  it("keeps agent_capability_grants, its rows and all 11 policies that read it byte-identical", async () => {
    await fixture(through91Template, async ({ service, migration }) => {
      await service`INSERT INTO users(id, name) VALUES ('legacy-owner','Owner'), ('legacy-agent','Agent')`;
      await service`INSERT INTO billing_accounts(id, owner_user_id, balance_credits) VALUES ('legacy-account','legacy-owner',0)`;
      await service`INSERT INTO agent_capability_grants(billing_account_id, grantee_principal_id, scopes, expires_at, created_by_user_id)
        VALUES ('legacy-account','legacy-agent', ARRAY['account:read'], now() + interval '10 days', 'legacy-owner')`;
      const before = await legacyFingerprint(service);
      expect(before.rows).toEqual([{ md5: expect.any(String), n: 1 }]);
      expect(before.readers).toHaveLength(11);
      await migrate(drizzle(migration), { migrationsFolder: migrations }); // applies only 0092
      expect(
        await service`SELECT to_regclass('public.agent_roles')::text AS t`
      ).toEqual([{ t: "agent_roles" }]);
      expect(await legacyFingerprint(service)).toEqual(before);
    });
  });
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

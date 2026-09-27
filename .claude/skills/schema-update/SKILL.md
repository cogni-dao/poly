---
name: schema-update
description: Use any time you are about to add, change, or migrate a Postgres or Doltgres table in this node — editing schema TS under `packages/db-schema/src`, `packages/poly-db-schema/src`, or `packages/doltgres-schema/src`, running `drizzle-kit generate`, writing a migration `.sql`, touching `meta/_journal.json` / `*_snapshot.json`, adding row-level security / tenant isolation (a table with a FK to `users` or `billing_accounts`), or debugging a migration that didn't apply on candidate. Mandatory before any schema edit. Covers the RLS-first rule + the component gate that enforces it.
---

# schema-update

The minimal procedure for changing a table in this node. Follow it; don't improvise.

This node is a single repo (no monorepo `nodes/<node>/` tree). Two data planes:

| Plane    | Schema source                  | Migrations out                                   | Purpose                                    |
| -------- | ------------------------------ | ------------------------------------------------ | ------------------------------------------ |
| Postgres | `packages/db-schema/src/`      | `app/src/adapters/server/db/migrations`          | Operational data                           |
| Doltgres | `packages/doltgres-schema/src/`| `app/src/adapters/server/db/doltgres-migrations` | AI-written knowledge (`knowledge_*` tables) |

drizzle-kit reads these via `drizzle.config.ts` (Postgres) and `drizzle.doltgres.config.ts` (Doltgres). Both require `DATABASE_URL` in the environment.

## ⚠️ Poly's Postgres slices exist in TWO packages — edit both

This is a port artifact (`3fa499e` seeded `db-schema`; `0638967` added
`poly-db-schema`), never reconciled. Both copies are **live at runtime**, and
only one drives migrations:

| Copy | Role | Consumed by |
| --- | --- | --- |
| `packages/db-schema/src/<slice>.ts` | **drizzle-kit globs this** (`drizzle.config.ts:29`) → owns the migration | also runtime-live via `app/src/shared/db/schema.ts` |
| `packages/poly-db-schema/src/<slice>.ts` | **no** migration effect | imported directly by ~25 files, e.g. `order-ledger.ts` |

Duplicated slices: `copy-trade.ts`, `poly-redeem-jobs.ts`, `trader-activity.ts`,
`wallet-connections.ts`, `wallet-grants.ts`.

**Rule: apply the identical edit to both copies.** The only sanctioned difference
is the `* Module: `@cogni/{db-schema,poly-db-schema}/<slice>`` doc line.

- Edit only `poly-db-schema` → types compile, **no migration** → prod throws
  `column "X" does not exist` (failure mode #3).
- Edit only `db-schema` → migration ships, the 25 direct importers don't see the
  column.

Enforced by `app/tests/unit/schema/poly-schema-duplication.test.ts` in the
`unit` lane (verified to fail on injected drift). If that test is red, you
edited one copy.

Non-poly slices (`ai.ts`, `auth.ts`, `billing.ts`, `identity.ts`, …) exist only
in `packages/db-schema/src/` — edit once.

## Postgres — the only path

1. **Edit the schema TS** under `packages/db-schema/src/` (e.g. `ai.ts`, `auth.ts`, `identity.ts`; barrel `index.ts`). Never put schema under `app/src/...` — the drizzle config globs only `packages/db-schema/src/**/*.ts`, so it won't see it and `generate` produces no diff.
2. **Generate.** `DATABASE_URL=<dsn> pnpm drizzle-kit generate --config=drizzle.config.ts`. drizzle-kit emits `NNNN_<tag>.sql`, the `meta/_journal.json` entry, and `meta/NNNN_snapshot.json` together. **Inspect the `.sql`** — drop any unintended `DROP TABLE` it proposes for orphaned/out-of-tree tables.
3. **Validate the chain.** The snapshot `prevId` chain and journal `when` values must be intact. Journal `when` must be **strictly increasing**: a new entry whose `when` lands before a prior entry's `when` will silently no-op on deploy (see failure mode #1). If the auto-gen `Date.now()` produced a non-monotonic `when`, bump the new entry's `when` past the prior max.
4. Commit `NNNN_*.sql` + `meta/_journal.json` + `meta/NNNN_snapshot.json` **together, in one commit**. Never `--no-verify` a schema PR.
5. **Post-flight:** the migrator (`scripts/db/migrate.mjs`, run in the node's migrate initContainer) must log your tag as applied. If it didn't run, your column won't exist at runtime.

## RLS coverage — mandatory for any tenant-scoped table (RLS-first)

drizzle-kit does **not** generate RLS. If your table is tenant-scoped — a foreign
key to `users` (per-user) or `billing_accounts` (per-account) — it ships with
row-level security in the **same migration that creates it**, never "added later."
This is the rule that makes multi-tenant safe by default; skip it and you leak
every account's rows to every other account.

Two correct shapes:

- **User/account-facing reads** → an owner-scoped policy. Per-account:
  `USING ("account_id" IN (SELECT "id" FROM "billing_accounts" WHERE "owner_user_id" = current_setting('app.current_user_id', true)))`
  (per-user is the direct `"user_id" = current_setting('app.current_user_id', true)` form). Mirror `0004_enable_rls.sql`.
- **Service-role-only** (only the BYPASSRLS worker role touches it, no app-role
  path) → `ENABLE` + `FORCE` with **no policy** = deny-all / fail-closed. No fake
  policy needed.

Always pair `ENABLE ROW LEVEL SECURITY` with `FORCE ROW LEVEL SECURITY`. Without
FORCE, the table owner (the app role that runs migrations) bypasses its own RLS —
tests pass while production leaks. drizzle-kit emits neither; hand-author both
(see the fallback below).

### The component gate is your "done"

The `component` CI lane (`app/tests/component/setup/testcontainers-postgres.global.ts`)
runs three catalog-derived preflights against a real Postgres on every PR, with no
hard-coded table list:

1. every `public` table with a FK to `users` has RLS **enabled** (`RLS_COVERAGE`),
2. every table that enables RLS also **forces** it (no owner bypass),
3. at least one table has RLS (catches a dropped migration).

A tenant table with missing/owner-bypassable RLS fails the lane **before any test
runs** — that is the gate that makes this class of leak un-mergeable. Then prove
isolation explicitly: add a 2-account test under `app/tests/component/db/*.int.test.ts`
that writes rows for two accounts and asserts each account's
`SET LOCAL app.current_user_id` session sees only its own. See the `test-expert`
skill for the component-lane mechanics.

## Hand-authored fallback — only if drizzle-kit literally can't emit it

Valid triggers: RLS policies, `ALTER POLICY`, triggers, custom Postgres functions, ARRAY DEFAULTs the TS schema can't express. This repo already ships one (`0004_enable_rls.sql`). **Plain `ADD COLUMN`, CHECK, partial index, FK — auto-gen handles all of this.** When in doubt, try `generate` first.

Recipe (steps 1–4 atomic in one commit):

1. Write `NNNN_<tag>.sql`.
2. Append the journal entry; **`when` > max(prior `when`)**.
3. `cp meta/(N-1)_snapshot.json meta/NNNN_snapshot.json`; regenerate `id`, set `prevId` to the prior snapshot's `id`, edit `tables` to reflect your deltas.
4. Confirm the snapshot/`prevId` chain is unbroken.

Never edit a previously committed snapshot's `prevId` to silence a chain error. If the chain is broken, fix it forward.

## Doltgres — same shape, parallel pipeline

Doltgres is for AI-written knowledge (the `knowledge` table + companions); Postgres is for operational data. **Default for any AI-edited content: a new row in `knowledge` with a different `domain` + `tags`, NOT a new table.**

When you do need a new Doltgres table:

1. Edit `packages/doltgres-schema/src/`.
2. `DATABASE_URL=<doltgres-dsn> pnpm drizzle-kit generate --config=drizzle.doltgres.config.ts` (DSN points at the Doltgres knowledge DB, not Postgres).
3. Same `when` monotonicity check on the Doltgres journal.
4. Confirm the snapshot/`prevId` chain.
5. Adapter writes use `sql.unsafe()` + try-INSERT / catch-duplicate (extended-protocol params + `ON CONFLICT EXCLUDED` are broken on the Doltgres version in use). Don't "modernize" them — see `scripts/db/migrate-doltgres.mjs`, which narrows on the exact DDL-collision shapes drizzle-kit emits.
6. The Doltgres migrator (`scripts/db/migrate-doltgres.mjs`) chains a trailing `SELECT dolt_commit('-Am', '...')` to capture DDL into `dolt_log`. Keep it.

`scripts/db/verify-doltgres-schema.mjs` compares the latest snapshot against the live DB and throws `SCHEMA_DRIFT` if anything is missing — run/trust it post-migrate.

## Common failure modes (rank-ordered)

1. **Future-dated / non-monotonic `when`** silently no-ops your migration on candidate. The app pod has the schema code; the DB doesn't have the column. Symptom: `PostgresError: column "X" does not exist` shortly into deploy.
2. **Hand-authored when auto-gen would have worked** — broke the snapshot chain, missed the journal entry, or both.
3. **Schema edited in the wrong place, or in only one of the two copies.** Under `app/src/...` → drizzle config doesn't see it, `generate` produces no diff. For a poly slice, editing only `poly-db-schema` produces the same no-diff outcome; editing only `db-schema` leaves the 25 direct importers stale. See the dual-package section above.
4. **Unintended `DROP TABLE` committed unread** — orphan/out-of-tree tables vanish on next migrate.
5. **Pushed with `--no-verify`** — skipped validation, shipped a broken chain.

## Quick reference

```bash
# Postgres
DATABASE_URL=<pg-dsn>  pnpm drizzle-kit generate --config=drizzle.config.ts
node scripts/db/migrate.mjs                      # apply (also runs in migrate initContainer)

# Doltgres (AI knowledge plane)
DATABASE_URL=<dg-dsn>  pnpm drizzle-kit generate --config=drizzle.doltgres.config.ts
node scripts/db/migrate-doltgres.mjs             # apply + dolt_commit
node scripts/db/verify-doltgres-schema.mjs       # drift check
```

Layout:

```
packages/db-schema/src/                              Postgres schema — drizzle-kit globs THIS (owns migrations)
packages/poly-db-schema/src/                         DUPLICATE of poly slices — runtime importers; edit in lockstep
packages/doltgres-schema/src/                        Doltgres schema (AI knowledge)
drizzle.config.ts / drizzle.doltgres.config.ts       drizzle-kit CLI boundary (need DATABASE_URL)
app/src/adapters/server/db/migrations/               Postgres history (.sql + meta/)
app/src/adapters/server/db/doltgres-migrations/      Doltgres history (.sql + meta/)
scripts/db/migrate.mjs / migrate-doltgres.mjs        runtime migrators
```

## When to escalate

- Choosing Postgres vs Doltgres for a new table → keep AI content in `knowledge` rows; only add operational tables to Postgres.
- Migrator initContainer not firing or crash-looping → that's a deploy/image-wiring problem, not a schema one.
- Anything about the *substrate* — migrator image build, the candidate→preview→prod promote chain, DB backups, cross-env credential/DSN wiring — is **operator-managed (the node BaaS), not yours.** Your scope ends at: schema TS, the migration, RLS on it, and the component test that proves it. File it with the operator if the substrate is wrong.

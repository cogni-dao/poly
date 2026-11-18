# db · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Database client singletons and tenant-scoping helpers for PostgreSQL access. App-role (`getAppDb`) and service-role (`getServiceDb`) singletons are in separate files to enable dependency-cruiser enforcement of BYPASSRLS isolation.

## Pointers

- [Database schema](../../../shared/db/schema.ts)
- [Drizzle configuration](../../../../../../drizzle.config.ts)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["adapters/server", "ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports (via `client.ts` barrel):** `Database` type, `getAppDb()`, `setTenantContext`, `withTenantScope`
- **Exports (via `drizzle.service-client.ts`, NOT in barrel):** `getServiceDb()` (service-role singleton, BYPASSRLS). Only `src/auth.ts` and `src/bootstrap/container.ts` may import this (enforced by depcruiser `no-service-db-adapter-import` rule).
- **Doltgres:** `doltgres/work-items-adapter.ts` implements the durable work-item query/command plane and is wired only from the bootstrap container.
- **Env/Config keys:** `DATABASE_URL`, `DATABASE_SERVICE_URL`
- **Files considered API:** `client.ts` (safe barrel), `drizzle.service-client.ts` (restricted)

## Responsibilities

- This directory **does**: Provide configured database singletons (`getAppDb`, `getServiceDb`) and tenant-scoping helpers for other adapters
- This directory **does not**: Contain business logic or table operations
- This directory **enforces**: BYPASSRLS isolation — `getServiceDb` is NOT in the barrel, requiring direct import from `drizzle.service-client.ts` with depcruiser allowlisting

## Usage

Minimal local commands:

```bash
pnpm test tests/component/db/
pnpm db:migrate
```

## Standards

- Uses Drizzle ORM for type-safe database access
- Connection pooling and transaction support
- Migration management through Drizzle

## Dependencies

- **Internal:** shared/db (schema), shared/env (serverEnv), `@cogni/db-client` (app factory), `@cogni/db-client/service` (service factory)
- **External:** drizzle-orm, postgres

## Change Protocol

- Update this file when **Exports** or **Env/Config** change
- Bump **Last reviewed** date
- Ensure component tests pass

## Notes

- Contains migration files in migrations/ subdirectory
- Shared by all database adapters (accounts, etc.)

App-role pool defaults to one connection per process; explicit `DB_POOL_MAX` overrides remain authoritative. Construction emits registered `adapter.db_pool.configured` metadata with requested/effective maximum and PID, never DSNs. Pool defaults are sized per Postgres ROLE: app `DB_POOL_MAX`=1 (app_poly), and the service_poly pools `DB_SERVICE_POOL_MAX`=2 + `DB_READ_POOL_MAX`=1 + leader 1 = 4 per pod, so two overlapping blue/green pods fit the role ceiling 8 (bug.5064). `service-role-budget.ts` clamps env-injected service/read maxes (e.g. production runtimePoolLimits 4/2) to `DB_SERVICE_ROLE_BUDGET` (default 4); each pool logs `adapter.db_pool.configured` with requested vs effective max. The old 4 + 2 + 1 = 7 per pod and service 10 + read 5 caused SQLSTATE 53300.

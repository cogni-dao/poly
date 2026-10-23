# tests/component · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft
- **Last reviewed:** 2026-10-23

## Purpose

Component tests using isolated docker testcontainers. Tests adapter implementations and feature-owned PostgreSQL persistence, reads, and authorization against real dependencies without a running application stack.

## Pointers

- [Adapters source](../../src/adapters/)
- [Port tests](../ports/)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": [
    "adapters/server",
    "adapters/worker",
    "ports",
    "features",
    "shared",
    "tests"
  ],
  "must_not_import": ["core", "app", "mcp"]
}
```

Feature imports are permitted only to exercise production feature-owned persistence, reads, or database-backed authorization against real PostgreSQL. Execute the production SQL; never mock the database or replace its queries. Pure feature/domain logic and graph orchestration belong in unit tests; HTTP/API/UI behavior belongs in stack/e2e tests. This test-only permission does not change production import boundaries.

## Public Surface

- **Exports:** none
- **CLI:** pnpm test:component or vitest run tests/component
- **Env/Config keys:** .env.test only (e.g., TEST_DB_URL, TEST_LITELLM_URL)

## Responsibilities

- This directory **does:** run port test suites against concrete adapters; smoke test infra clients (DB, LLM proxy, wallet verification); verify feature-owned PostgreSQL persistence, reads, and authorization; test repo adapter and brain tool wiring against real git repos
- This directory **does not:** test pure domain/business logic, graph orchestration, UI, or Next routes

## Usage

```bash
pnpm test:component
vitest run tests/component
pnpm test tests/component/adapters/ai
```

## Standards

- Adapters must pass their port tests: import tests/ports/\*.port.spec.ts and run the suite
- Dependencies: uses testcontainers for database isolation; no external service dependencies
- Setup/teardown: create and migrate schema per run; isolate data; clean shutdown
- Timing: avoid real time sensitivity; use deterministic inputs; allow retries only for transient network on localhost

## Dependencies

- **Internal:** src/adapters, src/ports, src/shared, src/features (PostgreSQL integration only), tests/ports, @cogni/ai-tools
- **External:** vitest, docker (for local testing), test environment configs, ripgrep binary (for repo/ tests)

## Change Protocol

- Update component tests when adapter implementations change
- Run full port test suites when port interfaces change
- Bump **Last reviewed** date
- Ensure clean test environment setup/teardown

## Notes

- If a spec requires the HTTP boundary, move it to e2e/ (API/UI). Keep this folder focused on real dependency integration
- If an adapter leaks business logic, refactor: rules belong in core or features

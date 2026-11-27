# agent-grants · AGENTS.md

> Scope: this directory only.

## Purpose

The ONE account-read decision of the capability plane, over the shared grant plane (`@cogni/agent-grants`). Poly has no grant table, grant
service or grant route of its own: migration 0093 copied every live or revoked legacy grant forward into `agent_roles` (`resource = 'account'`). The two legacy tables
stay until the contract migration.

## Public Surface

- `authorize(tx, { principalId, accountId, requiredScope })` — THE account-read decision. Owner, or a live `account:read` row for exactly this
  account; returns null for every denial. It asks the SQL function `agent_has_scope()` (package tail `agent_account_grants.sql`), the same
  function the 11 delegated SELECT policies call, so the app check and row-level security cannot disagree.
- `resolveSubjectAccountId(tx, { principalId, requiredScope })` — the account an `accountFrom: "principal"` operation is about.
- `resolvePrincipalAccountId(tx, principalId)` — the account a principal owns.

## Invariants

- **`routeOnlyCapabilities` is catalog metadata here, not enforcement.** `app/src/node-extensions.ts` lists Poly's route ids so `account:read` is declared, account-kind and askable
  (`POST /api/v1/agent/access-requests`). Poly's route wrapper has no `sameDoor` option, so nothing in the package guards these routes. Enforcement is this directory's
  `authorize()` (through `executeAccountRead`) plus the delegated SELECT policies, both asking `agent_has_scope()`. A new account-read route must call `executeAccountRead`.
- **Expand phase.** `agent_capability_grants` and `agent_access_requests` are still in the database (migration 0093 copied them and dropped nothing). No code reads or writes them;
  the contract migration (task.0210) drops them in a later release.

- `account:read` is the only delegable scope. The owner approves it on `/profile` (`/api/v1/agent-access/mine`); an outside agent asks at
  `POST /api/v1/agent/access-requests`. There is no `performance:read` alias and no Poly-only scope. A narrower grant, if ever needed, is a
  `poly.`-prefixed route-only scope declared in `app/src/node-extensions.ts` (not built).
- Access decisions are never cached, and `authorize()` runs before any account-keyed cache lookup (AUTHORIZE_BEFORE_CACHE).
- Missing, expired, revoked, and wrong-scope grants fail closed.
- Callers use app-role transactions with `app.current_user_id` set; never the service-role bypass. `agent_roles` is readable by the app role only
  for its own account rows (`agent_roles_account_self_read`); every write is the package's, over the service role.

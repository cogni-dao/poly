# capability-plane · AGENTS.md

> Scope: this directory only.

## Purpose

The one read path for account/trading data. A capability is defined ONCE as a
pure descriptor in `@cogni/poly-node-contracts`; this directory binds it to a
runtime handler and executes it. Every actor — owner session, approved external
agent, internal agent — is a client of the same executor and differs only by
the principal it carries.

## Public Surface

- `executeAccountRead(args)` — the executor. Validates input, opens an app-role
  tenant transaction, applies read-only isolation, authorizes, consults any
  cache, runs the handler, validates output, emits exactly one terminal event.
- `AccountReadHandler<I, O>` — `(tx, input) => Promise<O | null>`. Receives only
  validated input and the already-authorized transaction.
- `AccountReadOutcome<O>`, `AccountReadStatus`, `ACCOUNT_READ_HTTP_STATUS`,
  `ACCOUNT_READ_ERROR_CODES` — the outcome union and its renderings.
- `ACCOUNT_READ_TERMINAL_EVENTS` + the per-capability handlers and `extra`
  builders in `handlers.ts`.
- `accountReadDiscoveryActions`, `accountReadDiscoveryEndpoints` — pure
  projection of the catalog into `.well-known/agent.json`.

REST transport lives in `@app/_lib/capability-plane/account-read-route`; route
modules only name a descriptor plus its binding.

## Invariants

- DISPATCH_ORDER_IS_THE_CONTRACT — input parse → tenant transaction →
  `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` → `authorize()` +
  access-decision event → cache → handler → output parse → ONE terminal event.
  The isolation statement must stay the first statement after the tenant
  `SET LOCAL`; Postgres rejects it once a query has run.
- AUTHORIZE_BEFORE_CACHE — cache hooks take an `AccountReadAccess` argument, so
  they are unreachable before an allow. Access decisions are never cached.
- NO_PRIVILEGED_TRANSPORT — the transport injects `resolveAppDb()`. Never
  `resolveServiceDb` / `resolveServiceReadDb`; RLS is the backstop.
- EXACTLY_ONE_TERMINAL_EVENT — the executor is the sole emitter, including on
  the parse and error paths. Transports pass counts through `extra`.
- FAIL_CLOSED_NON_DISCLOSING — every denial renders the identical 404 and the
  terminal event carries no access kind and no account id. The separate
  `access_decision` audit event does name the principal/account/grant, because
  proving a denial in Loki requires naming its subject and object.
- NO_FABRICATED_VALUES — a null handler result is `not_found`, never zeroes.
- NO_HANDLER_REGISTRY_IN_PACKAGES — descriptors are pure; binding lives here.
- Features must not import `@/bootstrap`: the `Database` handle is injected.

## Adding a capability

1. Add a descriptor to `poly.capability-plane.v1.contract.ts` by composing the
   existing operation (never edit a frozen contract file).
2. Add its terminal event to `ACCOUNT_READ_TERMINAL_EVENTS` (keyed by the id
   union, so this is a compile error until you do) and its handler to
   `handlers.ts`.
3. Add its public names to `DISCOVERY_NAMES` in `discovery.ts`.
4. Bind a route with `accountReadGetHandler`. Add no query and no auth there.
5. Add delegated SELECT RLS policies for any newly read private table.

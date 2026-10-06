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
- `AccountReadHandler<I, O>` — `(tx, input, accountId) => Promise<O | null>`.
  Receives validated input, the already-authorized app-role transaction, and the
  account id `authorize()` allowed. **ACCOUNT_IS_EXPLICIT: filter every query by
  that `accountId`.** RLS is a backstop, not a tenant selector — a delegated
  principal sees both the account it owns and every account it holds a grant on,
  so an unfiltered handler merges two accounts into one response. This is
  decisive for `accountFrom: "principal"` operations (no account id on the wire)
  and for `poly_trader_*`, which has no RLS at all. Returning `null` means "no
  such saved fact" and is rendered as a non-disclosing not-found, never zeroes.
- **SUBJECT_IS_NOT_CALLER** — for `accountFrom: "principal"`, the subject is the
  single account the principal can *reach* for the scope (granted ∪ owned), not
  the account it owns. Every agent from `/agent/register` owns one, so resolving
  by ownership hands a delegate its own empty tenant and authorizes it as
  `owner`. Reachable by several → `invalid_input` asking the caller to name one;
  never a guess. An explicit `billing_account_id` on the wire always wins, which
  is why agent-facing transports declare `accountFrom: "input"`.
- `AccountReadOutcome<O>`, `AccountReadStatus`, `ACCOUNT_READ_HTTP_STATUS`,
  `ACCOUNT_READ_ERROR_CODES` — the outcome union and its renderings.
- `ACCOUNT_READ_TERMINAL_EVENTS` + the per-capability handlers and `extra`
  builders in `handlers.ts`.
- `accountReadDiscoveryActions`, `accountReadDiscoveryEndpoints` — pure
  projection of the catalog into `.well-known/agent.json`.

REST transport lives in `@app/_lib/capability-plane/account-read-route`; route
modules only name a descriptor, its binding, and `resolveDb: resolveAppDb`.

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
4. Bind a route with `accountReadGetHandler`, passing `resolveDb: resolveAppDb`.
   Add no query and no auth there.
5. Add delegated SELECT RLS policies for any newly read private table.

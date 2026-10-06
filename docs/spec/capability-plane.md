---
id: capability-plane-spec
type: spec
title: "Capability Plane — One Account-Read Definition, Every Actor Is a Client"
status: draft
spec_state: draft
trust: draft
summary: "Defines poly's single capability plane for account and trading reads. A capability is declared once as a pure descriptor, authorized once through one seam, and reached by three interchangeable principals — human session, external API key, and the internal poly-brain agent. The plane is the only read path; transports are thin clients holding zero queries and zero authorization."
read_when: "Adding or migrating any account/trading read, reviewing a PR against the capability invariants, wiring a new transport or principal, deciding where a scope or descriptor belongs, or asking why poly composes around frozen modules instead of editing them."
implements:
owner: derekg1729
created: 2026-10-06
verified:
tags: [capability-plane, authorization, agent-first, account-read, ports]
---

# Capability Plane

## Context

Poly bolted AI account-reads on as a **third parallel access plane**. The same logical
capability — "read this account's P/L" — is reachable through three different auth models
against three different data sources:

1. **Internal LangGraph tools**, principal-blind and bound to nothing. `ToolInvocationContext`
   carries only `runId` / `toolCallId` / optional `connectionId`
   (`packages/ai-core/src/tooling/types.ts:135`). `POLY_TOOL_BUNDLE` is exported at
   `packages/poly-ai-tools/src/index.ts:240` and has **zero call sites** — every runtime
   composes `CORE_TOOL_BUNDLE` only (`app/src/bootstrap/container.ts:24` and `:1941`,
   `app/src/bootstrap/graph-executor.factory.ts:24` and `:537`). `@cogni/poly-graphs` is not a
   dependency of `app/package.json` and is imported nowhere in `app/src`, so poly-brain is
   unreachable and `NODE_RUNTIME_CATALOG_BOUNDARY`
   ([langgraph-patterns.md:49](langgraph-patterns.md)) is violated today.
2. **External REST research routes**, reading internal tenant tables behind one coarse grant,
   with a near-duplicated authorize + scope + log block in three routes under
   `app/src/app/api/v1/poly/research/`: `copy-trade-pnl/route.ts`,
   `copy-trade-investigation/route.ts`, and `copy-trade-investigation/evidence/route.ts`.
3. **Owner-only dashboard routes** with no delegation path at all.

Consequences already observed in production: an agent **fabricated a wallet balance** because no
delegatable read existed; an agent stalled demanding a `billing_account_id` UUID because there is
no whoami; and hand-written tool-enumeration guides drift from the code.

Poly has no local architecture spec today — there is no `docs/spec/architecture.md` in this repo.
This is the first one, and it governs the capability plane only.

## Goal

**One Capability Plane — every actor is a client.**

The **agent-first inversion**: the capability plane is the *only* read path for account and
trading data. Dashboard routes become thin transport clients that carry a session principal and
contain **zero queries and zero authorization of their own**. Parity between the human UI and an
agent then becomes *structural* rather than something a test has to chase.

A capability is defined **once** as a pure descriptor and authorized through **exactly one**
decision function. Consumers differ only by principal.

## Non-Goals

- MCP projection — deferred by decision, see [Decisions](#decisions).
- OpenFGA as the authorization substrate — deferred to `story.5007`.
- A granular per-primitive scope map — scope stays coarse by decision.
- Write capabilities (`live:*`) — same plane, higher scopes, later.
- Raw-SQL agent surfaces, and any new write scope.

## Core Invariants

These are **review criteria**. A PR touching an account/trading read is reviewed against this
list by name.

1. **CAPABILITY_DEFINED_ONCE** — 📋 Contract. One logical capability has exactly one descriptor:
   `id`, `input`, `output`, `requiredScope`, `method`, `path`. Declared in
   `@cogni/poly-node-contracts`; the handler is bound app-locally. Packages hold pure
   contracts only — no handler registry, no DB, no env, no container.

2. **NO_PRIVILEGED_TRANSPORT** — 📋 Contract. No transport holds a query or an authorization
   decision of its own. A route is a principal-resolver plus a call into the plane. No actor gets
   a privileged back door — not the dashboard, not the internal agent.

3. **PRINCIPAL_CARRIES_PRIVILEGE** — 📋 Contract. Privilege is a property of the principal, never
   of the channel it arrived on. The same principal must yield the same answer over REST, over a
   session, or inside a graph tool call.

4. **ONE_AUTHORIZE_FN** — 📋 Contract. Exactly one decision function,
   `authorize(tx, { principalId, accountId, requiredScope })`. Every plane consumer goes through
   it, so the substrate underneath can be swapped (see `story.5007`) without touching a handler
   or a transport.

5. **AUTHORIZE_BEFORE_CACHE** — 📋 Contract. Authorization completes before any account-keyed
   cache lookup. Access decisions themselves are never cached.

6. **RLS_BACKSTOP** — 📋 Contract, **with a documented exception**. Postgres row-level security
   is the second line of defence beneath the capability. See
   [Carve-out 1](#carve-out-1--rls_backstop-is-not-universal) — this invariant is *not* universal,
   and the exception is named rather than silent.

7. **SAVED_FACTS_ONLY** — 📋 Contract. The plane returns facts this node has saved. It is not a
   proxy to a public upstream API. Identical saved facts for every principal is the parity
   contract; identical transport envelopes are not required.

8. **FAIL_CLOSED_NON_DISCLOSING** — 📋 Contract. Deny-by-default. A denial is a non-disclosing
   `404` — an unauthorized principal cannot distinguish "exists but forbidden" from "absent".

9. **SCOPE_ENUM_SINGLE_SOURCE** — 📋 Contract. One scope enum, one source. Today this is
   **violated**: the identical six-value list is hand-written twice —
   `AGENT_CAPABILITY_SCOPE_VALUES` at `packages/db-schema/src/agent-capability-grants.ts:35` and
   `AGENT_CAPABILITY_SCOPES` at
   `packages/poly-node-contracts/src/poly.agent-grants.v1.contract.ts:16` — and inlined a third
   time in the SQL `CHECK` constraint
   (`packages/db-schema/src/agent-capability-grants.ts:74`, emitted to
   `app/src/adapters/server/db/migrations/0070_first_wrecker.sql:13`).

10. **NO_FABRICATED_VALUES** — 📋 Contract. Missing or stale data returns a **typed unavailable**,
    never zero and never invented. This invariant exists because an agent fabricated a wallet
    balance in production when no delegatable read existed.

11. **GENERATED_DISCOVERY** — 📋 Contract. `.well-known/agent.json` is projected from the
    descriptors, not hand-maintained. Today it is a hybrid:
    `app/src/app/.well-known/agent.json/route.ts` generates only `inputSchema` / `outputSchema`
    via `z.toJSONSchema(...)`, while the `endpoints` map and every `actions` entry — method,
    URL template, `auth.requiredScope` — are hand-written per operation, with
    `requiredScope: "performance:read"` hard-coded at `:147`. Adding a contract does **not**
    currently publish it.

## Constraints

### The port-freeze gate forces compose-over-mutate

This is an architectural force, not trivia. CI runs the parity gate at
`.github/workflows/ci.yaml:65`:

```
pnpm poly:port:test && pnpm poly:port:verify && pnpm poly:port:regression -- --base origin/main
```

`scripts/poly-port-inventory.mjs:26` treats `{exact, upgraded, retired}` as **terminal**. An
`exact` entry requires byte *and* mode equality with the legacy source blob (`:674-675`); any
byte edit flips it to `content_differs` / `mode_differs`. An `upgraded` entry is digest-pinned, so
editing it yields `approval_stale` (`:701-707`). The regression leg (`:1223-1233`) fails the build
when a P0/P1 terminal entry becomes non-terminal.

Escaping the freeze for one file requires a `resolutions` entry in
`docs/porting/poly-port-policy.json:503` carrying a `rationale`, a `behaviorExpectation`,
`behaviorGateIds`, and `proofs` for **both** `candidate` **and** `production` environments, each
with a `buildSha` and `expectedTargetDigest`. That is a two-environment promotion ceremony **per
edited file**.

**Therefore poly builds this plane by composing around frozen modules, never by mutating them.**
New files are free (`targetOnly`). Two concrete consequences:

1. **Descriptors compose, they do not extend in place.** The 40 exported `*Operation` literals in
   `packages/poly-node-contracts/src` carry `id`, `input`, `output`, and usually
   `summary`/`description` — and **no** `method`, `path`, or `requiredScope` field. Two of them are
   frozen `exact` (`poly.research-copy-trade-pnl.v1.contract.ts`,
   `poly.copy-trade.orders.v1.contract.ts`). The capability descriptor is therefore built by
   spreading the existing literal rather than editing it:

   ```ts
   { ...someFrozenOperation, requiredScope, method, path, readOnly, accountFrom }
   ```

2. **Graph tool policy is declared app-locally.** All 14 tracked files under `graphs/` are
   `exact` — source and target blobs identical — including
   `graphs/src/graphs/poly-brain/tools.ts` and `graphs/src/index.ts`. These are **P2**, so editing
   them does **not** fail CI: the regression leg is P0/P1-only (`:1223-1233`), and
   `poly:port:verify` only prints a summary and returns — it does not fail on unresolved entries
   (`:1306-1312`). Editing a P2 `exact` file flips its inventory status, which shows up in the
   diff for review, but no gate blocks it. The binding force here is therefore
   `NODE_RUNTIME_CATALOG_BOUNDARY` alone
   ([langgraph-patterns.md:49](langgraph-patterns.md)), which independently puts app runtime
   policy in the node-local catalog. Tool policy is declared in the **app-local node catalog**
   on that architectural ground — not because `graphs/` is uneditable.

Priority matters when judging how hard a freeze bites: `app/src/bootstrap/container.ts` is
**P0 / `upgraded`** (digest-pinned, delivery group `hub-control-plane`) and
`app/src/app/api/v1/poly/wallet/balance/route.ts` is **P1 / `exact`** — both inside the P0/P1
regression hard-stop.

Other frozen files this plane must compose around: `app/src/bootstrap/container.ts`,
`app/src/bootstrap/ai/tool-source.factory.ts`, `packages/poly-ai-tools/src/index.ts`,
`app/src/features/wallet-analysis/server/copy-trade-pnl-service.ts`,
`app/src/features/trading/order-ledger.types.ts`, `app/src/features/trading/index.ts`,
`app/src/app/api/v1/poly/wallet/balance/route.ts`, and
`app/src/app/_lib/auth/request-identity.ts`.

## Design

### The three principals

One plane, three principals, **no privileged back door for any of them**.

| Principal | Credential | Resolution | Status |
| --------- | ---------- | ---------- | ------ |
| Human UI | Session cookie | `getServerSessionUser()` via `resolveRequestIdentity` | ✅ Implemented |
| External agent | API key (`cogni_ag_sk_v1_…` bearer) | bearer branch of `resolveRequestIdentity` | ✅ Implemented |
| Internal poly-brain agent | The signed-in user's principal | 📋 Contract — propagation unbuilt | 📋 Contract |

`app/src/app/_lib/auth/request-identity.ts` (frozen, `exact`) already unifies the first two:
`resolveRequestIdentity()` at `:114` returns a `SessionUser` from **either** an agent bearer token
or a session cookie, and its `BEARER_CLAIMS_EXCLUSIVE` invariant makes an invalid bearer return
`null` rather than silently falling back to the cookie. This is the existing foundation for
`NO_PRIVILEGED_TRANSPORT`: downstream code cannot tell which transport a principal arrived on.

Two things that resolver deliberately does **not** carry: scopes and a billing account. Those are
inputs to `authorize()`, not properties of the identity.

The third principal is the genuinely hard one, and it is a **design decision, not wiring**.
`ToolInvocationContext` (`packages/ai-core/src/tooling/types.ts:135`) carries no principal, and its
header comment forbids `accessToken`, `apiKey`, `refreshToken`, `headers`, `secret`, and
`credential` fields — enforced at compile time by
`app/tests/unit/security/no-secret-fields.types.test.ts`. Principal propagation therefore cannot
be a token smuggled through the tool context. This is the same blocker that removed the trade
tools (`bug.0319`).

### One authorization decision

```
authorize(tx, { principalId, accountId, requiredScope }) -> Access | null
```

`null` means a non-disclosing `404`. Today the only grant-authorization helper is
`resolvePerformanceRead(tx, { principalId, billingAccountId })` at
`app/src/features/agent-grants/authorization.ts:34`. It is owner-first, then falls back to an
active, non-revoked, unexpired grant — but the scope is a **literal in the function body**
(`:62`, `arrayContains(..., ["performance:read"])`) per its own `PERFORMANCE_READ_ONLY` invariant
at `:11`. There is no generic `authorize(`, `requireScope`, or `assertScope` anywhere in
`app/src`. The parameterized seam is unbuilt.

Scope is **coarse by decision**: a single `account:read`. Expand-then-contract — the migration adds
`account:read` to the scopes `CHECK` while retaining `performance:read`, and `authorize()` matches
either, so the one live production grant keeps working with **no human re-approval**.

### Transports are thin clients

A transport does exactly three things: resolve a principal, call the plane, serialize the result.
It holds no query and no authorization. UI-only mutation handles and action affordances such as
`actionsAllowed` sit outside the data parity contract and must never imply agent write authority.

## Carve-outs

An invariant with a silent exception is worse than one with a documented exception. There are two.

### Carve-out 1 — RLS_BACKSTOP is not universal

The `poly_trader_*` tables have **no** `enableRLS()` and **no** `pgPolicy`. Verified zero
occurrences of either in both files that define them —
`packages/db-schema/src/trader-activity.ts` and
`packages/poly-db-schema/src/trader-activity.ts` (the schema is itself duplicated across two
packages). The tables: `poly_trader_wallets`, `poly_trader_ingestion_cursors`,
`poly_trader_fills`, `poly_trader_fill_rollups_daily`, `poly_trader_fill_rollup_cursors`,
`poly_trader_position_snapshots`, `poly_trader_current_positions`,
`poly_trader_user_pnl_points`.

The app role's grants are blanket and schema-wide — `ON ALL TABLES IN SCHEMA public` in
`infra/compose/runtime/postgres-init/provision.sh` — not per-table. There is no per-table
`GRANT` for these tables anywhere, and no `GRANT` statements at all in
`app/src/adapters/server/db/migrations/`.

**Consequence: for `poly_trader_*` the capability is the only tenant clamp.** There is no RLS
underneath to catch a mistake. A missing or wrong `accountId` filter in a `poly_trader_*` query is
a cross-tenant leak with no second line of defence. Treat every such query as
security-critical and review it as such.

By contrast `agent_capability_grants` (`packages/db-schema/src/agent-capability-grants.ts`) is
fully protected — three `pgPolicy` declarations at `:96`, `:103`, `:110` and `.enableRLS()` at
`:122`, covered by `app/tests/component/db/agent-capability-grant-rls.int.test.ts`.

### Carve-out 2 — the wallet/balance tombstone

`app/src/app/api/v1/poly/wallet/balance/route.ts` is a **frozen, already-compliant tombstone** and
is **intentionally never migrated**.

It is `exact` in the port inventory, and it satisfies `NO_PRIVILEGED_TRANSPORT` *by construction*:
it performs **zero DB queries** (it imports no `db`) and returns a **constant** object through
`polyWalletBalanceOperation.output.parse` with
`error_reason: "operator_wallet_removed_use_money_page"` (`:50`). There is no query and no
capability decision to migrate.

One precision, because the distinction matters to reviewers: the route is **not** unauthenticated.
It is session-gated — `auth: { mode: "required", getSessionUser }` at `:37`, and its own header
calls it an "Auth-gated tombstone" (`:15`). What it lacks is *scope/capability* authorization, not
*authentication*. Leave it alone; the per-tenant Money page owns user balances on a new route.

## Decisions

Recorded deferrals. Each is a **decision with a reason**, not an oversight.

| Decision | Ruling | Reason |
| -------- | ------ | ------ |
| **MCP projection** | Deferred | Materially more expensive than the poly-brain binding, which proves internal/external interchangeability just as well. |
| **OpenFGA RBAC substrate** | Deferred to `story.5007` | Poly runs a second, divergent authz substrate versus the operator — the exact fork class this plane exists to eliminate. Swapped in later **behind** the single `authorize()` seam, so no handler or transport changes. Prerequisite: this plane shipped and proven in production. |
| **Granular scope map** | Deferred; coarse `account:read` | Sufficient at one-user scale. The real defect was the *identifier*: `performance` is the wrong name for account data access, so it is renamed `account:read` expand-then-contract. Granularity is what OpenFGA buys later. |
| **Write capabilities (`live:*`)** | Deferred | Same plane, higher scopes, later. No new write scope in this wave. |

## As-built today

Per `SPECS_ARE_AS_BUILT`
(`.claude/skills/contribute-knowledge-to-cogni/SKILL.md:61`): everything in this spec is
**📋 Contract** until `story.5004` and `story.5006` ship and are proven at an exact SHA. Only then
does it become ✅ Implemented. Nothing above describes unbuilt behavior in the present tense.

| Element | Status | Evidence |
| ------- | ------ | -------- |
| Dual-principal identity resolution | ✅ Implemented | `request-identity.ts:114` (frozen) |
| `agent_capability_grants` + RLS | ✅ Implemented | `agent-capability-grants.ts` |
| Pure operation descriptors | ✅ Implemented, plus the account-read catalog | `poly.capability-plane.v1.contract.ts` |
| Generic `authorize()` seam | 🚧 Merged, unproven in production | `agent-grants/authorization.ts` — `authorize(tx, { principalId, accountId, requiredScope })` with alias tolerance |
| App-local account-read executor | 🚧 Merged, unproven in production | `features/capability-plane/execute-account-read.ts` |
| Thin transports, zero queries | 🚧 Merged for the 3 research routes | each route is now a descriptor + binding; the block and the 3 db casts are gone |
| Single scope enum | 🚧 Merged | `AGENT_CAPABILITY_SCOPES` + the grants `CHECK`; migration `0074_account_read_scope_alias` |
| Generated discovery | 🚧 Merged | `features/capability-plane/discovery.ts`; `agent.json` spreads the projection |
| Dashboard routes as plane clients | 📋 Contract | `task.1791070962` / `task.1791070959` |
| poly-brain principal propagation | 📋 Contract | `ToolInvocationContext:135` has no principal |
| `RLS_BACKSTOP` on `poly_trader_*` | ❌ Documented exception | Carve-out 1 |

🚧 means merged to `main` with CI + component-lane proof, but not yet validated at an exact SHA on
candidate and production. Per `SPECS_ARE_AS_BUILT` these only become ✅ after `task.1791070963`
closes the `deploy_verified` loop; the gated knowledge contribution stays gated until then.

### Rename, as built

`task.1791070961` landed the expand half of `performance:read` -> `account:read`:

- `account:read` is canonical; `performance:read` is retained as its alias. No rows were
  backfilled and the legacy name was not dropped — that is the later contract phase.
- `authorize()` matches either name with array **overlap** (`&&`), and migration 0074 rewrites the
  three delegated SELECT policy bodies on `poly_copy_trade_{fills,decisions,targets}` with the same
  overlap, in the same migration as the `CHECK` widening and after it. Splitting those two halves
  is the one failure that presents as "no data" rather than "denied".
- Newly approved grants are minted with **both** names, so a grant cannot exist that `authorize()`
  allows but RLS reads zero rows for.
- `agent_access_requests.requested_scopes` keeps its equality `CHECK` on the legacy name alone and
  is deliberately unwidened; the request row is tracking only, never authority.

Two further as-built findings worth recording, because they are easy to mistake for compliance:

- `app/src/app/api/v1/poly/research/target-overlap/route.ts:39` and
  `trader-comparison/route.ts:47` have **session auth only and no grant check at all** — they are
  not delegable reads, and they are not instances of the duplicated block.
- The three routes that *did* carry the block were **near**-duplicated, not byte-identical: the log
  payloads differed and `logComplete` was called with different signatures, so the migration could
  not be a mechanical find-and-replace. Their per-route counts now arrive through the executor's
  `extra` callback, which is what let one emitter replace three.

## Verification method

The freeze gate above was confirmed by **static reading** of
`scripts/poly-port-inventory.mjs` (terminal set at `:26`, `exact` blob+mode equality at
`:674-675`, `approval_stale` on edited pinned entries at `:701-707`, terminal regression at
`:1223-1233`) and `.github/workflows/ci.yaml:65`.

The originally-planned throwaway probe PR was therefore **not needed and was cancelled**. Recorded
so nobody re-opens that question.

## Acceptance Checks

**Automated:**

- `pnpm poly:port:verify && pnpm poly:port:regression -- --base origin/main` stays green — proving
  the plane was composed, not mutated into frozen files.
- Cross-tenant, wrong-scope, expired, and revoked reads each return a non-disclosing `404`.
- Delegated principals are rejected on every write path.

**Manual:**

1. The human dashboard, an approved external agent, and the internal poly-brain agent return
   **identical saved facts** for the same capability and account.
2. No transport in the plane contains a query or an authorization decision — `grep` for `db.` and
   for `resolvePerformanceRead` in route files returns nothing.
3. Every rendered dashboard data primitive maps to exactly one capability in the inventory.
4. `.well-known/agent.json` gains a new capability with no hand-edit to the route.

## Open Questions

- [ ] How does the signed-in user's principal reach a graph tool, given that
      `ToolInvocationContext` forbids credential-shaped fields and is compile-time enforced?
- [ ] Which layer owns the `account:read` ↔ `performance:read` alias during expand-then-contract,
      and when is the legacy alias dropped?
- [ ] Should `SCOPE_ENUM_SINGLE_SOURCE` resolve toward `@cogni/poly-node-contracts` or
      `@cogni/db-schema`, given the `CHECK` constraint must be generated from whichever wins?
- [ ] Do the two unguarded research routes become capabilities or get withdrawn?

## Related

- `story.5006` — Capability plane: one account-read definition, every actor is a client (governs
  this spec)
- `story.5004` — Standardize AI dashboard read parity (the four implementation tasks)
- `story.5007` — Adopt OpenFGA RBAC for poly data-read authorization (the recorded successor)
- [LangGraph Patterns](langgraph-patterns.md) — `NODE_RUNTIME_CATALOG_BOUNDARY` at `:49`, the
  package boundaries this plane composes within
- [Poly Parity Contract](../porting/poly-parity-contract.md) — the completion boundary the freeze
  gate enforces
- [Poly Port Inventory](../porting/poly-port-inventory.md) — per-file port status driving
  compose-over-mutate

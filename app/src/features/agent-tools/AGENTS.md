# agent-tools · AGENTS.md

> Scope: this directory only.

## Purpose

The **internal-agent transport** for the capability plane: thin functions that
invoke ONE account-read capability on behalf of the signed-in user's principal,
for a LangGraph tool to call.

**The tool CONTRACTS are not here — they live in `@cogni/poly-graphs/tools`.**
That split is forced, not stylistic: `ToolContract` in `@cogni/ai-tools` is typed
against zod **v3**, while `app` and `@cogni/poly-node-contracts` resolve zod
**v4**. A v4 schema does not merely fail to typecheck against it — `toToolSpec`
compiles specs with `zod-to-json-schema` (v3), which reads `_def.typeName`, a
field zod v4 does not have, so a v4 schema compiles to an **empty** JSON Schema
and the model receives a tool with **no arguments**. That was caught in CI by a
positive-control assertion, not reasoned about in the abstract. Contracts
therefore live in the one package that has zod v3 *and* can type-check itself
against the v4 descriptors.

This is the sibling of `@app/_lib/capability-plane/account-read-route` (the REST
transport). The two differ in exactly two ways and in nothing else:

| | REST transport | this directory |
| --- | --- | --- |
| Where the principal comes from | a session cookie or agent bearer | a closure, bound per request in `@bootstrap/ai/principal-tool-source` |
| How an outcome is rendered | an HTTP status + JSON body | a flat typed envelope a language model can read |

That symmetry is the point of `story.5006`: the internal agent and an external
API-key agent are interchangeable **clients** of one capability, not two
implementations of one feature.

## Public Surface

- `runPolyAccountCopyTradeOrdersTool(deps, rawInput)` — the transport for
  `poly.copy-trade.orders.v1`. `deps` is `{ db, principalId, ctx }`; it never
  throws.

Its contract (`polyAccountCopyTradeOrdersToolContract`,
`polyAccountCopyTradeOrdersBoundTool`,
`POLY_ACCOUNT_COPY_TRADE_ORDERS_TOOL_NAME`) is exported from
`@cogni/poly-graphs`.

## Invariants

- **PRINCIPAL_NEVER_IN_ARGS** — no tool here takes a `billing_account_id`,
  account id, user id, or wallet address. The account is resolved from the
  principal by the seam. A tool that asks the *model* who it is reading for is
  the incident that opened `story.5006`: an agent stalled demanding a UUID from a
  human. Pinned by `tests/unit/features/agent-tools/copy-trade-orders-tool.test.ts`
  against the **compiled** JSON Schema, not the Zod source.
- **CAPABILITY_DEFINED_ONCE_ACROSS_ZOD_MAJORS** — the tool schema cannot be the
  descriptor's schema by reference across the v3/v4 boundary, so it is pinned to
  the descriptor's inferred **type** instead
  (`z.ZodType<PolyCopyTradeOrdersInput>`). Add, rename, or remove a descriptor
  field and the contract stops compiling. A unit test additionally asserts both
  schemas accept and reject the same inputs.
- **ROWS_ARE_NOT_REVALIDATED** — the capability's rows reach this transport
  already validated against the capability's own output schema. Do not redeclare
  them; the tool's output schema validates only the envelope and passes rows
  through opaquely. A second copy of a 22-field row shape is exactly the drift
  `CAPABILITY_DEFINED_ONCE` forbids.
- **THIN_CLIENT** — zero queries, zero authorization, no container, no
  `Database` of its own. Call `executeAccountRead`; it authorizes, opens the
  app-role tenant transaction, and emits the one terminal event.
- **SAME_TERMINAL_EVENT_AS_REST** — reuse
  `ACCOUNT_READ_TERMINAL_EVENTS[operation.id]`. One capability is one Loki
  stream split by `routeId`, so human-vs-agent parity is a one-stream comparison
  rather than a cross-stream join.
- **FAIL_CLOSED_NON_DISCLOSING** — `denied` and `not_found` must collapse to ONE
  reason code with ONE message. A model is a perfectly good oracle for an
  attacker, so it must not be able to distinguish "forbidden" from "absent".
- **NO_FABRICATED_VALUES** — a non-ok outcome returns a typed `unavailable` that
  **omits** every data field. Make this a property of the returned *shape*, not
  of the prose: there must be no `0` and no `[]` for a model to narrate as fact.
- **AMBIGUITY_IS_A_MESSAGE_NOT_A_CRASH** — several reachable accounts is
  `invalid_input` at the seam. Render it as an instruction to ask the human. Do
  **not** forward the executor's own "specify `billing_account_id`" text for an
  `accountFrom: "principal"` capability — that field does not exist on the wire,
  so the advice is impossible to follow.
- **NEVER_THROW** — a throwing tool becomes an opaque `execution` error to the
  model, which is exactly when models start guessing. Return a typed
  `unavailable` instead.
- **FLAT_OUTPUT_NO_UNIONS** — `ToolSpec` compiles through `zodToJsonSchema` and
  the supported subset disallows `oneOf`/`anyOf`. Use one object with optional
  members, never `z.discriminatedUnion`.
- **ASSERT_THE_COMPILED_SPEC** — when testing a tool schema, assert against the
  output of `toToolSpec`, and include a positive control (e.g. that a known field
  name IS present). An empty compiled schema otherwise passes every "must not
  contain" assertion vacuously. This is how the zod-major bug was caught.
- Features must not import `@/bootstrap`. `db`, `principalId`, and `ctx` are
  arguments.

## Adding a tool

1. Pick an existing descriptor from `POLY_ACCOUNT_READ_OPERATIONS`. Prefer
   `accountFrom: "principal"` — then the input schema *cannot* carry an account
   id and `PRINCIPAL_NEVER_IN_ARGS` is structural rather than reviewed. For an
   `accountFrom: "input"` capability you would have to decide, deliberately and
   in writing, how the model learns an account id it has no business knowing.
2. Declare the contract in `graphs/src/tools/` (zod **v3**), annotating the input
   schema as `z.ZodType<DescriptorInput>` so it cannot drift from the v4
   descriptor. Flat result envelope, opaque rows, `effect: "read_only"`.
3. Export a `run…Tool(deps, rawInput)` that calls `executeAccountRead` and maps
   every outcome — `denied` and `not_found` to the same branch.
4. Register it in `@bootstrap/ai/principal-tool-source` (`PRINCIPAL_TOOL_BUNDLE`
   plus a runtime in `createPrincipalToolSource`).
5. Allowlist the tool id on the graph that may call it, in
   `@bootstrap/ai/node-catalog`. A tool absent from the catalog
   entry is unreachable; a tool in the entry but absent from the node bundle is
   logged as "graph misconfigured" on every run.
6. No write scope. `story.5006` adds none.

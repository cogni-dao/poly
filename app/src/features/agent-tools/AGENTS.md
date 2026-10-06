# agent-tools · AGENTS.md

> Scope: this directory only.

## Purpose

The **internal-agent transport** for the capability plane. Each module here is a
LangGraph tool contract plus a thin function that invokes ONE account-read
capability on behalf of the signed-in user's principal.

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

- `polyAccountCopyTradeOrdersToolContract` — the `ToolContract` for
  `core__poly_account_copy_trade_orders`, bound to `poly.copy-trade.orders.v1`.
- `runPolyAccountCopyTradeOrdersTool(deps, rawInput)` — the transport. `deps` is
  `{ db, principalId, ctx }`; it never throws.
- `polyAccountCopyTradeOrdersBoundTool` — contract + a **throwing** stub, for the
  node bundle that publishes specs to the model. Resolving it for execution means
  the per-request source was not composed in.

## Invariants

- **PRINCIPAL_NEVER_IN_ARGS** — no tool here takes a `billing_account_id`,
  account id, user id, or wallet address. The account is resolved from the
  principal by the seam. A tool that asks the *model* who it is reading for is
  the incident that opened `story.5006`: an agent stalled demanding a UUID from a
  human. Pinned by `tests/unit/features/agent-tools/copy-trade-orders-tool.test.ts`
  against the **compiled** JSON Schema, not the Zod source.
- **CAPABILITY_DEFINED_ONCE** — a tool's `inputSchema` is the descriptor's
  `input`, **by reference**. Never a hand-copied shape that can drift.
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
- Features must not import `@/bootstrap`. `db`, `principalId`, and `ctx` are
  arguments.

## Adding a tool

1. Pick an existing descriptor from `POLY_ACCOUNT_READ_OPERATIONS`. Prefer
   `accountFrom: "principal"` — then the input schema *cannot* carry an account
   id and `PRINCIPAL_NEVER_IN_ARGS` is structural rather than reviewed. For an
   `accountFrom: "input"` capability you would have to decide, deliberately and
   in writing, how the model learns an account id it has no business knowing.
2. Declare the contract with the descriptor's `input` **by reference** and a flat
   result envelope. Keep `effect: "read_only"`.
3. Export a `run…Tool(deps, rawInput)` that calls `executeAccountRead` and maps
   every outcome — `denied` and `not_found` to the same branch.
4. Register it in `@bootstrap/ai/principal-tool-source` (`PRINCIPAL_TOOL_BUNDLE`
   plus a runtime in `createPrincipalToolSource`).
5. Allowlist the tool id on the graph that may call it, in
   `@bootstrap/ai/node-catalog`. A tool absent from the catalog
   entry is unreachable; a tool in the entry but absent from the node bundle is
   logged as "graph misconfigured" on every run.
6. No write scope. `story.5006` adds none.

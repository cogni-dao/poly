# bootstrap/ai · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** stable

## Purpose

AI tool bindings and tool source factories. Wires tool implementations with injected capabilities at bootstrap time — including the **per-request, principal-scoped** source that carries the signed-in user's authority into a graph tool.

## Pointers

- [Tool Use Spec](../../../../../docs/spec/tool-use.md)
- [Tools Authoring](../../../../../docs/guides/tools-authoring.md)

## Boundaries

```json
{
  "layer": "bootstrap",
  "may_import": ["bootstrap", "features", "shared"],
  "must_not_import": ["app", "core", "adapters"]
}
```

`features` is permitted here, matching the parent `bootstrap` layer in practice
(`container.ts`, `capabilities/*`, `jobs/*` all import features). Bootstrap's job is
injection: a tool implementation lives in a feature and bootstrap hands it a `Database`
handle and a principal, because features must not reach into `@/bootstrap` themselves.
The direction that stays forbidden is the reverse one.

## Public Surface

- **Exports:** `createToolBindings()`, `createBoundToolSource()`, `ToolBindings`, `ToolBindingDeps`,
  `createPrincipalToolSource()`, `composeToolSources()`, `PRINCIPAL_TOOL_BUNDLE`,
  `PRINCIPAL_TOOL_IDS`
- **Files considered API:** `tool-bindings.ts`, `tool-source.factory.ts`,
  `principal-tool-source.ts`

## Responsibilities

- This directory **does**: Wire tool implementations with capabilities, create ToolSourcePort,
  bind a request's principal to the tools that need one
- This directory **does not**: Execute tools, contain business logic, authorize anything
  (`executeAccountRead` owns every account-read decision)

## Usage

```bash
# Consumed by container.ts automatically
```

## Standards

- Per CAPABILITY_INJECTION: implementations receive capabilities at construction
- Per PRINCIPAL_BY_CLOSURE_NOT_BY_CONTEXT: a tool that needs the caller's identity gets it
  from a closure in `principal-tool-source.ts`, never from `ToolInvocationContext` — that
  type forbids credential-shaped fields, and `ToolImplementation.execute` has no ctx
  parameter to forward one to anyway.
- Per PER_REQUEST_NEVER_MODULE_SCOPED: **never** cache, memoise, or hoist a
  principal-scoped source. It is built once per request in
  `graph-executor.factory.ts#createInProcProvider`. A leaked source answers one user's
  graph run with another user's authority — authorization would pass, aimed at the wrong
  human.
- Per OVERLAY_NEVER_SHADOWS: `composeToolSources` throws if the overlay and the base source
  declare the same tool id.

## Dependencies

- **Internal:** bootstrap
- **External:** `@cogni/ai-core`, `@cogni/ai-tools`

## Change Protocol

- Add new tools to `tool-bindings.ts` when adding to TOOL_CATALOG
- A tool that reads one principal's account data instead goes through
  `principal-tool-source.ts` + `@features/agent-tools`, and its id must be allowlisted in
  `bootstrap/ai/node-catalog.ts` for the graph that may call it

## Notes

- Per TOOL_BINDING_REQUIRED: createBoundToolSource throws if any catalog tool lacks binding
- `container.toolSource` is module-scoped and principal-free, and `container.ts` is a
  port-frozen P0 entry. `composeToolSources` is the seam that lets a per-request tool join
  the graph runtime without editing it.

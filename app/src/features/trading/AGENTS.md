# trading · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Generic Polymarket placement + order-ledger substrate. Every path that places an order on behalf of the operator wallet routes through this layer: the agent-callable `core__poly_place_trade` tool, the autonomous mirror-coordinator, and the future P4 WS ingester. Survives every phase — not scaffolding, not copy-trade-specific.

## Pointers

- [task.0315 — Phase 1 plan](../../../../../../work/items/task.0315.poly-copy-trade-prototype.md)
- [Phase 1 spec](../../../../../../docs/spec/poly-copy-trade-execution.md)
- [Root poly node AGENTS.md](../AGENTS.md)
- Sibling layers: [../copy-trade/AGENTS.md](../copy-trade/AGENTS.md), [../wallet-watch/AGENTS.md](../wallet-watch/AGENTS.md)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["features", "ports", "core", "shared", "types"],
  "must_not_import": [
    "app",
    "adapters/server",
    "adapters/worker",
    "bootstrap",
    "contracts"
  ]
}
```

`trading/` is intentionally siloed from `copy-trade/` and `wallet-watch/` — it does not know what calls it. The `copy-trade/mirror-coordinator` imports `trading/`, never the reverse. The `features/copy-trade` + `features/wallet-watch` no-import rule is enforced by review + the `TRADING_IS_GENERIC` invariant below; the AGENTS.md validator only models coarse layers.

## Public Surface

- **Exports (executor):** `createClobExecutor(deps) → ClobExecutor`, `ClobExecutorDeps`, `CLOB_EXECUTOR_METRICS`.
- **Exports (order ledger root):** `createOrderLedger(deps) → OrderLedger`, `OrderLedgerDeps`. Root carries `forTenant(ctx: TenantContext) → TenantOrderLedger` PLUS every legacy method kept for back-compat (`snapshotState(target_id, billing_account_id)` — `@deprecated`, bug-fixed but use forTenant instead — `insertPending`, `recordDecision`, `markOrderId`, `markError`, `markCanceled`, `updateStatus`, `markSynced`, `listRecent`, `listTenantPositions`, `listOpenOrPending`, `markPosition*`, `syncHealthSummary`, `findStaleOpen`). task.5012 migrates the legacy surface onto `TenantOrderLedger` (or names the explicitly cross-tenant ops as such and keeps them on root).
- **Exports (tenant-scoped ledger):** `TenantOrderLedger` — closure over the `TenantContext` exposing the v0 mirror-pipeline surface with no tenant args: `snapshotState(target_id)`, `cumulativeIntentForMarketToken(market_id, token_id)`, `insertPending(input)` (drops `billing_account_id` + `created_by_user_id` — stamped from `ctx`), `hasOpenForMarket({target_id, market_id})`, `findOpenForMarket({target_id, market_id})`, `recordDecision(input)` (drops tenant fields). API-route + reconciler methods land on this surface in task.5012 Phase 2.
- **Exports (types):** `TenantContext` (`{billing_account_id, created_by_user_id}` — the envelope every tenant-scoped op closes over), `TenantScopedInsertPendingInput`, `TenantScopedRecordDecisionInput`, `LedgerRow` (includes `synced_at` + `position_lifecycle`), `LedgerStatus`, `LedgerPositionLifecycle`, `StateSnapshot` (carries `position_aggregates: PositionIntentAggregate[]`), `PositionIntentAggregate` (generic per-(market_id, token_id) intent aggregate — vocabulary stays inside trading, mirror semantics overlay lives in `@/features/copy-trade`), `UpdateStatusInput`, `ListOpenOrPendingOptions`, `SyncHealthSummary`, `OpenOrderRow`, `LedgerCancelReason`, `AlreadyRestingError`, `TenantBinding` (still used internally by the legacy root input types).

## Invariants

- **TRADING_IS_GENERIC** — files in this slice MUST NOT import `features/copy-trade/` or `features/wallet-watch/`. Vocabulary is "order," "intent," "receipt," "ledger." Never "target," "mirror," "fill-observation."
- **EXECUTOR_SEAM_IS_PLACE_ORDER_FN** — the executor takes a `placeOrder(intent) => receipt` function, not an adapter instance. Mock seam for tests + future WS consumer.
- **NO_STATIC_CLOB_IMPORT** — no static import of `@polymarket/clob-client` or `@privy-io/node`. Only `bootstrap/capabilities/poly-trade.ts::buildRealAdapterMethods` dynamically imports those.
- **INSERT_BEFORE_PLACE** _(order-ledger consumers)_ — callers that use the ledger with the mirror-coordinator MUST call `insertPending` before `placeIntent` and `markOrderId` after. The ledger itself is ordering-agnostic; the invariant is the coordinator's responsibility.
- **TENANT_SCOPED_OPS_REQUIRE_CTX** _(bug.5022)_ — the canonical entry point for tenant-scoped reads + writes is `OrderLedger.forTenant(ctx: TenantContext) → TenantOrderLedger`. Methods on `TenantOrderLedger` close over the tenant so callers cannot accidentally cross-pollinate state. New mirror algorithms MUST go through `forTenant(ctx)`; root legacy methods are `@deprecated` and migrate in task.5012.
- **TENANT_FILTER_IN_EVERY_SNAPSHOT_QUERY** _(bug.5022)_ — every SQL read/write that touches `poly_copy_trade_{fills,decisions}` filters explicitly on `billing_account_id`. Even legacy root methods carry this filter (back-compatible bug fix).
- **FORTENANT_RUNS_UNDER_RLS** _(bug.5022)_ — every method on the `TenantOrderLedger` returned by `OrderLedger.forTenant(ctx)` runs inside `withTenantScope(appDb, ctx.created_by_user_id, ...)`. This covers all 6 v0 methods — 4 reads (`snapshotState`, `cumulativeIntentForMarketToken`, `hasOpenForMarket`, `findOpenForMarket`) AND 2 writes (`insertPending`, `recordDecision`). Postgres RLS on `poly_copy_trade_{fills,decisions}` is the runtime backstop: even if a query forgets the explicit `eq(billingAccountId, ...)` filter, the DB layer strips rows owned by another `created_by_user_id`. `insertPending`'s advisory_xact_lock cap path nests under withTenantScope's tx as a SAVEPOINT — same atomicity as the legacy root path.
- **CROSS_TENANT_OPS_NAMED_EXPLICITLY** _(bug.5022)_ — `findStaleOpen` (TTL sweeper) and `syncHealthSummary` are explicitly cross-tenant by design; both stay on the root `OrderLedger`. New cross-tenant ops require an explicit design callout in `docs/spec/poly-tenant-and-collateral.md`.
- **CAP_COUNTS_REALIZED_ON_CANCEL** _(bug.5050)_ — `cumulativeIntentForMarketToken` counts `canceled` rows by their `filled_size_usdc` (or `size_usdc` if not populated). A STALE_RESTING_CANCEL_REPLACE on a partially-filled order leaves the realized shares in our wallet past the order's terminal state; the cap must reflect that exposure or follow-on placements leak past `max_market_intent_usdc`. The SQL CASE in `order-ledger.ts` and the helper `ledgerCountedIntentUsdc` in `ledger-lifecycle.ts` MUST stay in sync. Per `CAP_IS_PER_TOKEN_ID` (bug.5004) the sum is also scoped to `attributes->>'token_id'`.
- **BOUNDED_METRIC_RESULT** — the executor's `result` label is one of `{ok, rejected, error}`.

## Responsibilities

- Own the Polymarket CLOB executor (structured logs + metrics wrapper around an injected `placeOrder`).
- Own the order-ledger read/write surface over `poly_copy_trade_fills` + `poly_copy_trade_decisions` (table rename deferred to P2).
- Expose `forTenant(ctx).snapshotState(target_id)` returning `StateSnapshot` data so the coordinator doesn't SELECT directly. The compiler steers callers to construct a `TenantContext` first; every query inside the adapter carries an explicit `eq(billingAccountId, ...)` filter. (bug.0438 dropped the kill-switch read; only cap counters + dedup keys remain.)

## Notes

- **DB clients:** `appDb` (RLS-enforced `app_user` role) for every method on the `TenantOrderLedger` (reads AND writes) — wrapped in `withTenantScope(appDb, ctx.created_by_user_id, ...)` so Postgres RLS is the structural floor for tenant isolation. `serviceDb` (BYPASSRLS) still serves: (a) the legacy root snapshotState path (back-compat, carries explicit filter; task.5012 migrates the remaining non-mirror callers), (b) COID-keyed mutations (`markOrderId`, `markError`, `markCanceled`, `updateStatus`, `markSynced`) — they update by `client_order_id` with `WHERE client_order_id = $coid` and no tenant filter, so they're BYPASSRLS-by-default. Today's safety rests on convention (COIDs are hash-deterministic from `(billing_account_id, target_id, fill_id)` and flow only from prior `insertPending` results, never user input) — NOT structural enforcement. task.5012 migrates these to ctx-stamped writes under withTenantScope, (c) the explicitly cross-tenant ops (`findStaleOpen`, `listOpenOrPending`, `syncHealthSummary`) — by design. Roles enumerated in `OrderLedgerDeps`.
- **Single-tenant boundary:** the executor doesn't know about wallets or tenants — the `placeOrder` seam is passed in by `bootstrap/capabilities/poly-trade.ts` which holds the `HARDCODED_WALLET_SECRETS_OK` isolation.
- **Extension points:** adding SELL support, adding a paper adapter route, or adding a cancel-order executor all live here. Adding multi-tenant wallet-keyed placement is a `bootstrap/` concern, not a trading-layer concern. **New tenant-scoped reads or writes MUST go on `TenantOrderLedger`, never the root.**

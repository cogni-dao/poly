# copy-trade · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Thin copy-trade slice — the shared `AlgorithmDefinition` registry is the only runtime planner seam for all five families. It validates explicit facts/config, binds an immutable version identity, and returns a venue-blind economic decision. The fill pipeline and position-gap actor translate those decisions into shared trading intents; algorithms never persist, submit, cancel, log, or shape dashboard attempts. Placement primitives + order ledger live in `features/trading/`, observation lives in `features/wallet-watch/`, and cap + scope enforcement lives downstream inside `PolyTraderWalletPort.authorizeIntent`.

## Pointers

- [task.0315 — Phase 1 plan](../../../../../../work/items/task.0315.poly-copy-trade-prototype.md)
- [task.0318 — Multi-tenant auth + per-tenant execution](../../../../../../work/items/task.0318.poly-wallet-multi-tenant-auth.md)
- [Phase 1 spec](../../../../../../docs/spec/poly-copy-trade-execution.md)
- [Multi-tenant auth spec](../../../../../../docs/spec/poly-tenant-and-collateral.md)
- [Poly trader wallet port](../../../../../../docs/spec/poly-tenant-and-collateral.md) — where caps + scope are enforced
- [Root poly node AGENTS.md](../AGENTS.md)
- Sibling layers: [../trading/AGENTS.md](../trading/AGENTS.md), [../wallet-watch/AGENTS.md](../wallet-watch/AGENTS.md)

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

`copy-trade/` may import from sibling `features/trading/` and `features/wallet-watch/`. It is the ONLY slice that crosses both.

## Public Surface

- **Exports (pure):** `ALGORITHM_DEFINITIONS`, `evaluateAlgorithm()`, and `AlgorithmDefinition` — the stable runtime seam. Every evaluation returns canonical economic actions plus `algorithm_id`, `algorithm_version_id`, `config_hash`, `input_snapshot_id`, `assignment_id`, and `correlation_id`. `planMirrorFromFill()` and `planPositionGapBook()` remain pure family implementations behind this seam, not runtime entry points.
- **Exports (types):** `MirrorTargetConfig` (carries `billing_account_id` + `created_by_user_id` + `sizing` + `placement` + optional `position_followup` + optional `min_target_side_fraction` + optional `vwap_tolerance`), `RuntimeState` (optional `position: MirrorPositionView` + `target_position: TargetConditionPositionView`), `MirrorPositionView` (per-condition mirror cache view — authority #4 only, signal not truth; see `docs/spec/poly-copy-trade-execution.md`), `TargetConditionPositionView` (live target position read model; v0 Data API, vNext Postgres-backed), `MirrorPlan` (place variant carries optional `wrong_side_holding_detected: boolean`), `MirrorReason` (includes `target_dominant_other_side`, `vwap_floor_breach`), `PlanMirrorInput` (includes optional market `tick_size`), `SizingPolicy` (`min_bet` | `target_percentile` | `target_percentile_scaled`), `PlacementPolicy` (`mirror_limit` | `market_fok`).
- **Exports (pure):** `aggregatePositionRows(rows) → Map<condition_id, MirrorPositionView>` — collapses generic `PositionIntentAggregate[]` from trading into the mirror-vocabulary view. Called per-tick from mirror-pipeline.
 - **Exports (pipeline):** `runMirrorTick(deps)` — orchestrates wallet-watch → registry evaluation → runtime-owned `OrderIntent` → the ledger-stamped paper/live venue. BUY path inspects `findOpenForMarket`; SELL runs a cancel pre-step. Historical get/cancel/reconcile always use each ledger row's durable `mode`. Position-gap runs through `startPositionGapActor()` and the same registry, never the legacy fill planner.
 - **Exports (target source):** `CopyTradeTargetSource` port + `EnumeratedTarget` shape, `envTargetSource(wallets)` (local-dev), `dbTargetSource({appDb, serviceDb})` (production). Two methods: `listForActor(actorId)` (RLS-clamped) + `listAllActive()` (the ONE sanctioned BYPASSRLS read; activation is a grant-aware EXISTS predicate over `poly_wallet_connections` + `poly_wallet_grants` — kind-agnostic, so paper and live accounts activate on one rule, and ONE row per target no matter how many connections/grants the account holds).

## Invariants

- **COPY_TRADE_ONLY_COORDINATES** — files in this slice MAY import `features/trading/` and `features/wallet-watch/`. They MUST NOT import each other's internals except through the public barrel.
- **NO_KILL_SWITCH** (bug.0438) — copy-trade has no per-tenant kill-switch table. The cross-tenant enumerator's `target × connection × grant` join is the sole gate. Stopping mirror placement for a tenant is done via DELETE on the target row (or revoking the grant/connection).
- **INTENT_BASED_CAPS** — caps count against intent submissions, not partial fills. **Enforced downstream** inside `PolyTraderWalletPort.authorizeIntent`, not here.
- **CAP_IS_PER_TOKEN_ID** (bug.5004; supersedes `CAP_IS_PER_CONDITION_ID` from bug.5054) — per-target `max_usdc_per_condition` is the cumulative-intent budget per `(conditionId, token_id)`. YES and NO outcome tokens of the same conditionId each get an independent per-leg budget, so a hedged binary can accumulate up to `2 × max_usdc_per_condition` of gross intent against one conditionId — operator-level dollar bound lives at `authorizeIntent` (`CAPS_LIVE_IN_GRANT`). Different conditionIds each get independent per-leg budgets. DB column `mirror_max_usdc_per_trade` and Loki decision-log field `mirror_max_usdc_per_trade` retained for external compatibility. See spec invariant of the same name.
- **IDEMPOTENT_BY_CLIENT_ID** — repeat decisions with the same `(target_id, fill_id)` are silently dropped via `already_placed_ids`.
- **PLANNER_IS_PURE** — `planMirrorFromFill` has no I/O, no env reads, no clock reads, no grant reads. All runtime state handed in explicitly.
- **REGISTRY_IS_THE_ONLY_PLANNER_SEAM** — runtime code selects one of exactly five `AlgorithmDefinition`s and calls `evaluateAlgorithm()`. It must not call a family planner directly.
- **VERSION_BINDS_BEHAVIOR** — `algorithm_version_id` hashes algorithm ID, exact runtime-supplied Git SHA, planner code version, input-contract version, config-schema version, and exact validated config hash. Missing/malformed revision prevents the mirror runtime from starting. The input snapshot is hashed separately.
- **ALGORITHM_OUTPUT_IS_VENUE_BLIND** — decisions may name side, size, shares, and limit price. They must not name provider, placement/order type, client order ID, market presentation fields, signing, persistence, logs, or terminal execution state.
- **ATTEMPTS_ARE_RUNTIME_OWNED** — every family persists the same first-class lineage columns on decision and ledger rows. `/api/v1/poly/copy-trade/attempts` projects a single decision-backed API shape; algorithm reason and execution terminal reason remain separate.
- **TARGET_POSITION_IS_CONTEXT** — target-wallet position data is read outside the planner and supplied as `RuntimeState.target_position`; it is context for branch selection (target-dominance + VWAP) and follow-up policy, not a persisted authority in this slice.
- **TARGET_DOMINANCE_DRIVES_BRANCH** (bug.5048) — when `config.min_target_side_fraction` is set + target data available, target's per-condition side fractions select the branch first; our position state routes within. Minority-side fills (below threshold) always skip as `target_dominant_other_side`, regardless of position state. Hedges only fire on above-threshold opposite-side fills. See spec branch table in `poly-copy-trade-execution.md`.
- **NEVER_PAY_ABOVE_TARGET_VWAP** (bug.5048, bug.5008) — when `config.vwap_tolerance` is set, `fill.price > target_vwap_for_fill_token + tolerance` → skip `vwap_floor_breach`. Asymmetric upward gate. Position-gap BUY also skips when benchmark evidence is invalid; fill-family SELL closes remain registry-planned but do not apply a BUY entry-price gate.
- **NO_SYNTHETIC_SELL_IN_LEGACY_POLICIES** — legacy sizing policies never invent a SELL to rebalance; wrong-side residue holds to redemption and target SELL fills may only close held shares. `position_gap` v2 is the explicit exception: a target SELL trigger may close only the mirror shares above its newly scaled desired quantity, never open a short.
- **OPTION_C_TOLERATES_MULTI_TARGET** (bug.5048) — when wallet holds the non-dominant side from another target's activity AND current target's dominant-side fill arrives, planner opens a parallel dominant-side leg + sets `wrong_side_holding_detected: true`; pipeline increments `poly_mirror_wrong_side_holding_total` + emits WARN log.
- **PRICE_TICK_NORMALIZED** — when market constraints include `tick_size`, `planMirrorFromFill` rounds target fill prices to the nearest valid CLOB tick before sizing / ledger insert, or skips with `price_outside_clob_bounds` when the price is not representable.
- **MIRROR_REASON_BOUNDED** — `MirrorReason` is an enum; used verbatim as a Prom label. Includes `already_resting` (task.5001).
- **PLACEMENT_DISCRIMINATOR_IN_ATTRIBUTES** — `intent.attributes.placement ∈ {"limit","market_fok"}` is the only source of truth for adapter order-type. Shared `OrderIntent` port stays clean.
- **DEDUPE_AT_DB** — `findOpenForMarket` returns the resting row(s); the staleness check (`isRestingPriceStale`) decides skip-as-already_resting vs cancel-then-place. The `poly_copy_trade_fills_one_open_per_market` partial unique index is the correctness backstop; `AlreadyRestingError` from `insertPending` still converts to `skip/already_resting`. (bug.5035 widened the gate from boolean to price-aware.)
- **MIRROR_BUY_CANCELED_ON_TARGET_SELL** — every SELL fill cancels any open mirror order on `(target, market)` BEFORE position-close. Cancel routes through `executor.cancelOrder` (404-idempotent).
- **TARGET_SOURCE_TENANT_SCOPED** — `listForActor` returns only the actor's own targets under appDb RLS. `listAllActive` is the only cross-tenant path; it runs under serviceDb and returns `(billing_account_id, created_by_user_id, target_wallet)` triples, filtered to tenants with an active `poly_wallet_connections` + at least one active `poly_wallet_grants` row so ungranted tenants never enter the pipeline.
- **TENANT_INHERITED_FROM_TARGET** — every fills/decisions write inherits `(billing_account_id, created_by_user_id)` from `TargetConfig`. The pipeline never reads tenant from anywhere else.

## Responsibilities

- Own the pure `planMirrorFromFill()` function and its input/output types.
- Own the `mirror-pipeline` that wires observation → planner → per-tenant executor dispatch.
- Stay thin — placement mechanics (executor, order-ledger) live in `features/trading/`; observation (Data-API, activity-poll) lives in `features/wallet-watch/`; per-tenant signing + cap enforcement lives in `adapters/server/wallet/` behind `PolyTraderWalletPort`.

## Notes

- **Not in this slice:** CLOB executor (in `features/trading/clob-executor.ts`); order-ledger I/O (in `features/trading/order-ledger.ts`); scheduler tick + bootstrap wiring (in `bootstrap/jobs/copy-trade-mirror.job.ts`); per-tenant executor factory (`bootstrap/capabilities/poly-trade-executor.ts`); Privy signing + `authorizeIntent` (`adapters/server/wallet/privy-poly-trader-wallet.adapter.ts`).
- **Removed (Stage 4, 2026-04-22):** `bootstrap/capabilities/poly-trade.ts` and its `PolyTradeBundle` — the single-operator prototype. `PolyTradeExecutorFactory` is the only placement path.

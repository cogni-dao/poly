# wallet-watch · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Generic Polymarket wallet observation primitive. Emits normalized `Fill[]` for a watched wallet since a prior cursor. Consumed by the mirror-coordinator (CP4.3d) today; any future feature that needs to observe a Polymarket wallet (PnL tracker, research tool, audit view) plugs in here without importing copy-trade vocabulary.

## Pointers

- [task.0315 — Phase 1 plan](../../../../../../work/items/task.0315.poly-copy-trade-prototype.md)
- [task.5043 — Polygon chain-log source (current)](../../../../../../work/items/task.5043.md)
- [Phase 1 spec](../../../../../../docs/spec/poly-copy-trade-execution.md)
- [Root poly node AGENTS.md](../AGENTS.md)
- Sibling layers: [../copy-trade/AGENTS.md](../copy-trade/AGENTS.md), [../trading/AGENTS.md](../trading/AGENTS.md)

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

`wallet-watch/` is intentionally siloed from `copy-trade/` and `trading/`. It produces `Fill[]` (from `@cogni/market-provider`) and has no opinion on what happens next. The cross-slice no-import rule is enforced by review + the `WALLET_WATCH_IS_GENERIC` invariant below; the AGENTS.md validator only models coarse layers.

## Public Surface

- **Exports (port):** `WalletActivitySource` — `fetchSince(since?: number) → {fills, newSince}`, plus optional `subscribeWake(cb) → unsubscribe` for push-on-wake. Sources that omit `subscribeWake` degrade cleanly to coordinator-tick polling.
- **Exports (adapter):** `createPolymarketChainActivitySource({ publicClient, client, wallet, logger, metrics, refreshAssetsIntervalMs?, heartbeatIntervalMs? })` — Polygon `OrderFilled` chain logs on Polymarket CTF Exchange V2 + NegRisk Exchange V2 contracts, filtered at RPC by `maker = target_wallet`. Polymarket emits two `OrderFilled` events per match (one per party from `_emitTakerFilledEvents` + `_emitOrderFilledEvent`); the maker-side event puts the target in the `maker` topic slot and carries target's order side directly in the `side` field. Two subscriptions per target (V2 + NegRisk V2). Per-wallet `listAllUserPositions` (paginated, bug.5055) snapshot enriches `(condition_id, outcome, end_date)` metadata. Latency ~2s (one Polygon block) end-to-end.
- **Exports (pure helpers):** `decodeOrderFilledForTarget(log, wallet)`, `chainFillId({ txHash, logIndex, side })`.
- **Exports (metrics):** `WALLET_WATCH_METRICS` (cursor/drain duration) + `WALLET_WATCH_CHAIN_METRICS` (logs/fills/skips/metadata-refresh).
- **Exports (types):** `NextFillsResult`, `PolymarketChainActivitySource`, `PolymarketChainActivitySourceDeps`.

## Invariants

- **WALLET_WATCH_IS_GENERIC** — files in this slice MUST NOT import `features/copy-trade/` or `features/trading/`. Emits the neutral `Fill` shape from `@cogni/poly-market-provider/domain/order`.
- **FILL_ID_SHAPE_CHAIN** — `fill_id = "chain:" + txHash + ":" + logIndex + ":" + side`. `(txHash, logIndex)` is a globally unique log coordinate on Polygon, so the id is fully deterministic from chain state. Cross-source collision with `data-api:` is impossible (different prefix). `(target_id, fill_id)` unique-index dedupes replays + multi-pod cleanly.
- **OBSERVED_AT_IS_BLOCK_TIMESTAMP** — `observed_at` is Polygon `block.timestamp` (ISO-8601), same semantic as the prior data-api source's `trade.timestamp` → lag histogram stays comparable across sources. Fetched via memoized `getBlock` (one RPC per unique block). On transient `getBlock` failure the source falls back to wall-clock with `poly_mirror_chain_block_timestamp_fallback_total` increment; fills are NEVER dropped for an RPC blip.
- **CHAIN_REORG_POLICY_V0** — `watchContractEvent` runs with no confirmations buffer; `removed:true` retractions are dropped + counted (`poly_mirror_chain_skip_total{reason="reorg"}`) but already-emitted Fills are not recalled. Mirror orders placed on a reorged log sit on CLOB until `order-reconciler.job` hits its `clob_not_found` grace window (default 900 s). v1 hardening: 1-block delay-buffer or `getLogs(toBlock: latest - N)`.
- **METADATA_FROM_POSITIONS** — `(condition_id, outcome, end_date)` enriched from `listAllUserPositions(wallet)`, refreshed every `refreshAssetsIntervalMs` (default 60s). Must paginate to exhaustion (bug.5055); single-page `listUserPositions` silently caps at ~100 rows per bug.5027, dropping everything past the top page for any target with a long-tail of holdings. Cache miss triggers immediate refresh + retry; still-missing OR empty-outcome → skip with `metadata_unresolved`. Empty-outcome skip prevents wrong-side mirroring on NegRisk multi-outcome markets.
- **CURSOR_IS_MAX_TIMESTAMP** — `newSince` = max `block.timestamp` (unix seconds) emitted this drain. Callers persist + feed back next tick.
- **CHAIN_TRANSPORT_IS_PUSH** (bug.5051) — the caller-supplied `publicClient` MUST use viem's `webSocket()` transport. `watchContractEvent` over WSS issues `eth_subscribe` (push, server-side filter — no client filter to expire). HTTP transport falls back to filter polling, which Alchemy GCs and viem 2.39 does not recreate. Container wires `webSocket(POLYGON_RPC_WSS_URL)`; missing → mirror does not start. viem's built-in reconnect handles transient drops (`WSS_RECONNECT_OWNED_BY_VIEM`); do not add bespoke retry. The same WSS client multiplexes all per-target subscriptions plus `getBlock` requests onto one connection.
- **WAKE_FANOUT_ISOLATED** — `subscribeWake` callbacks fire inside `onLog`. One bad subscriber MUST NOT prevent other subscribers from running, MUST NOT escape `onLog`, and MUST NOT block buffering. Implementations wrap each callback in try/catch + warn-log.

## Responsibilities

- Own the `WalletActivitySource` port and its Polygon chain-log Polymarket implementation.
- Emit bounded-label skip counters for log drops (`reorg`, `decode_no_target_match`, `metadata_unresolved`, `schema_invalid`). Transient `getBlock` failures are NOT a skip — they increment `poly_mirror_chain_block_timestamp_fallback_total` and the fill is still emitted with wall-clock `observed_at`.
- Stay observation-only — no writes, no decisions, no placements.

## Notes

- **Why chain logs (task.5043)**: Polymarket's public Market-channel WS frames carry no maker/taker addresses, so the prior WS source had to drain the `/trades` Data-API endpoint to attach wallet identity. That endpoint is server-cached → ~5 min observed lag from target-fill to mirror-decision. CTF Exchange V2 + NegRisk Exchange V2 emit `OrderFilled(bytes32 orderHash, address maker, address taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee, bytes32 builder, bytes32 metadata)` with `orderHash`, `maker`, and `taker` as indexed topics, so the RPC layer filters to the target wallet and identity arrives with the event. End-to-end latency ~2s (one Polygon block). bug.5049: keep this signature in sync with `polymarket.exchange.ts` — the keccak topic0 test in the market-provider package pins it to a real mainnet receipt, so any drift fails CI.
- **Why `getBlock` per unique block** (not per log): `watchContractEvent` does not surface `block.timestamp` on the log. Real timestamp is required for `observed_at` (so the task.5042 lag histogram measures the right interval). Memoized `blockNumber → timestamp` cache means one `getBlock` per unique block, not per log. `fill_id` does NOT depend on block timestamp — it uses `(txHash, logIndex)` directly.
- **Buy/sell determination** (decoder contract): the deployed V2 contracts emit one `OrderFilled` per party per match (`_emitOrderFilledEvent` for the resting maker + `_emitTakerFilledEvents` for each crossing taker). On the taker-side emission the target appears in the `maker` slot with target's order side directly in the `side` enum (0=BUY, 1=SELL). One subscription per exchange contract filtered on `maker = target_wallet` catches every target trade — 2 total per target (V2 + NegRisk V2).
- **Metadata cache** (`METADATA_FROM_POSITIONS`): cache miss triggers an immediate `listAllUserPositions` refresh + retry. New-market first fills can race the positions endpoint (Polymarket's snapshot may not reflect the fresh entry within milliseconds). If still unresolved OR `outcome` is empty, the fill is skipped and counted as `metadata_unresolved`. The pagination cap was the dominant cause of `metadata_unresolved` skips in prod (bug.5055 — fixed by switching from single-page `listUserPositions` to paginated `listAllUserPositions`). Worth a future Gamma `/markets?clob_token_ids=...` backstop for true new-market races, tracked separately.
- **Reorg policy** (`CHAIN_REORG_POLICY_V0`): no confirmations buffer in v0. `removed:true` retractions are dropped + counted; orders placed on a reorged log rely on the downstream status-sync reconciler to expire/refund. The prior implicit "data-api 5-min reconciliation backstop" no longer exists — the drain was removed.
- **Liveness**: each per-wallet source emits `event:"poly.wallet_watch.ws.heartbeat"` (name reused from the WS source for Loki absence-alert continuity) every `heartbeatIntervalMs` (default 5min) carrying `logs_received_window`, `fills_emitted_window`, `buffer_size`, `cached_tokens`, `last_log_at`, `subscriptions`. The `component:"polymarket-chain-source"` label in the line body disambiguates from any legacy WS heartbeats still in Loki retention. Source bring-up + teardown additionally emit `POLY_WALLET_WATCH_CHAIN_STARTED` / `_STOPPED`.
- **Hard requirement**: `POLYGON_RPC_URL` must be set. Absent → mirror not started (single WARN log at bootstrap). Same posture as the existing Privy/AEAD missing-creds gate.
- **Not in this slice:** scheduler tick + cadence (lives in `bootstrap/jobs/copy-trade-mirror.job.ts`); the DB cursor persistence (kept on the coordinator's `runOnce` deps); the decision / policy (lives in `features/copy-trade/`).

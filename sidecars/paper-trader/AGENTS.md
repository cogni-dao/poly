# poly-paper-sidecar · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Python sidecar wrapping [`agent-next/polymarket-paper-trader`](https://github.com/agent-next/polymarket-paper-trader) (MIT) behind an HTTP API. The TS `PaperAdapter` in `@cogni/poly-market-provider/adapters/paper` speaks HTTP to this sidecar over pod-loopback. Together they implement the paper-trading backend used by `mode='paper'` copy-trade targets and the always-paper `candidate-a` / `preview` overlays.

## Pointers

- [Project](../../../work/projects/proj.poly-paper-trading.md) — design + roadmap
- [Research](../../../docs/research/poly-paper-trading-mode.md) — OSS survey
- [TS adapter](../../../nodes/poly/packages/market-provider/src/adapters/paper/paper.adapter.ts)
- Upstream: `agent-next/polymarket-paper-trader` (MIT) — pinned via `UPSTREAM_PAPER_TRADER_SHA` build-arg

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services",
    "packages"
  ]
}
```

**External deps:** `agent-next/polymarket-paper-trader` (MIT, pinned commit), `fastapi`, `uvicorn`, `pydantic`.

## Public Surface

- `Dockerfile` — multi-stage. `base` is the runtime image; `test` runs pytest under a stubbed `pm_trader.Engine` as a build-blocker. `UPSTREAM_PAPER_TRADER_SHA` build-arg pins the upstream commit (current: `8a0a3ee2` = upstream v0.1.6).
- `server.py` — FastAPI app: `/healthz`, `/readyz`, `/version`, `POST /place-order`, `POST /orders/{id}/cancel`, `GET /orders/{id}`. Single global `threading.Lock` serializes Engine access. Daemon thread polls `engine.check_orders()` every `PAPER_CHECK_ORDERS_INTERVAL_SECONDS` (default 30s, aligns with cogni reconciler's 60s tick).
- `tests/test_sidecar_smoke.py` — 12 tests, ~0.4s. Stubs `pm_trader.engine` via `sys.modules`. Wired into `.github/workflows/build-poly-paper-sidecar.yml` as a CI build-blocker (red ⇒ no image push).

## HTTP contract (consumed by `PaperAdapter`)

| Method + Path                    | Purpose                      | Success                                  | Error                          |
| -------------------------------- | ---------------------------- | ---------------------------------------- | ------------------------------ |
| `GET /healthz`                   | Liveness probe               | `200 {status}`                           | —                              |
| `GET /readyz`                    | Readiness (fill loop alive)  | `200 {status}`                           | `503` if fill loop dead        |
| `GET /version`                   | Pinned build + upstream SHAs | `200 {buildSha, upstreamPaperTraderSha}` | —                              |
| `POST /place-order`              | Submit a paper limit order   | `200 OrderReceipt`                       | `502` per upstream cause       |
| `POST /orders/{order_id}/cancel` | Idempotent cancel            | `204`                                    | `404` swallowed by adapter     |
| `GET /orders/{order_id}`         | Status lookup                | `200 OrderReceipt`                       | `404` → `not_found` in adapter |

Response shape on `200`: matches `OrderReceiptSchema` from `@cogni/poly-market-provider`. **v0 fill-amount convention:** when upstream reports `status="filled"`, sidecar sets `filled_size_usdc = intent.size_usdc` (full-fill assumption). Partial-fill fidelity is a documented limitation; the realized-cost/fee keys on the upstream check_orders dict aren't stable enough yet to lift safely.

## Market identity translation

Cogni `market_id` is shaped `"prediction-market:polymarket:<conditionId>"` (per `polymarket.normalize-fill.ts:79`). Upstream `Engine.place_limit_order(slug_or_id, ...)` accepts either a Polymarket slug or a conditionId. The sidecar strips the cogni prefix and passes the bare conditionId; falls back to `attributes.condition_id` if the prefix is absent.

## Responsibilities

- This directory **does**: build a Python sidecar image; expose the HTTP contract above; map cogni request/response shapes to upstream's; run a background fill-poll loop; **vendor + locally patch** the upstream `agent-next/polymarket-paper-trader` source under `vendor/pm_trader/`.
- This directory **does not**: implement fill logic, fee math, queue-position modelling, or any other simulation behaviour from scratch. All of that lives in the vendored package. Local patches on top of the vendored copy (e.g. the maker-fill branch from `bug.5005`) are tracked in `vendor/pm_trader/PROVENANCE.md`'s diff log.

## Bumping the vendored upstream

1. Pull the new upstream commit into `/tmp/pm_trader_src/` (see the step-by-step in `vendor/pm_trader/PROVENANCE.md`).
2. Audit the diff — focus on `engine.py` (method signatures + `check_orders` shape), `orders.py` (LimitOrder dataclass fields), `orderbook.py` (`simulate_*_fill` return shape), and the fee formula (`bps/10000 × min(p, 1-p) × shares`).
3. Verify `Engine.place_limit_order`, `cancel_limit_order`, `check_orders` signatures match what `server.py` calls. If a signature changes, update `server.py` + tests in the same commit.
4. Port-forward any local diff (see `vendor/pm_trader/PROVENANCE.md`'s diff log) onto the new upstream.
5. Update `UPSTREAM_PAPER_TRADER_SHA` in the `Dockerfile` `ARG` line — note that this value is now **metadata-only** (surfaced on `/version.upstreamPaperTraderSha` for provenance); the actual installed code is the vendored copy.
6. Re-run the in-image pytest. CI's `pr-build` matrix runs it automatically via `infra/catalog/poly.yaml`'s `build.test_target: test` whenever files under `path_prefix: nodes/poly/sidecars/paper-trader/` change.
7. The sidecar smoke at `tests/test_sidecar_smoke.py` uses a stubbed Engine via `sys.modules`, so it'll pass any API-shape regression. A real fee/fill-fidelity smoke against a recorded book fixture is still pending (project roadmap PR3 follow-up).

## Notes

- v0 ships **ephemeral SQLite** at `${PM_TRADER_DATA_DIR}/${PM_TRADER_ACCOUNT}/`. Pod restart wipes open paper orders; the cogni reconciler treats orphan `pending` rows the same as a CLOB outage (closes after grace window). Add a PVC only if/when preview's redeploy cadence produces visible fill-rate friction.
- Account starting balance is `PM_TRADER_STARTING_BALANCE_USDC=1000000` (1M). Upstream cap-rejection never fires; cogni's own cap-enforcement code is the real gate. Don't tune balance for paper-PnL bookkeeping — use cogni Postgres `poly_copy_trade_fills WHERE mode='paper'` for that.
- This image is consumed **only** as a pod-loopback sidecar. Must never be exposed to a Service or Ingress — `PaperAdapter`'s base URL defaults to `http://localhost:9100` and is only constructor-injected, never DNS-resolved.
- Logging: JSON-ish single-line to stdout, with `event=…` keys + `client_order_id=…` for cross-service joins in Grafana/Loki.

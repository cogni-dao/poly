# poly-paper-sidecar · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Python sidecar wrapping [`agent-next/polymarket-paper-trader`](https://github.com/agent-next/polymarket-paper-trader) (MIT) behind an HTTP API. The app-side `PaperTradingClient` in `app/src/adapters/server/paper-trading` speaks HTTP to this sidecar over pod-loopback. Together they provide the internal paper-trading backend for always-paper `candidate-a` / `preview` deployments.

## Pointers

- [Guide](../../docs/guides/paper-trading-sidecar.md) — node/operator split for sidecar deployment
- [App client](../../app/src/adapters/server/paper-trading/paper-trading.client.ts)
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
- `tests/test_sidecar_smoke.py` — stubs `pm_trader.engine` via `sys.modules`. Wired into `.github/workflows/ci.yaml` through the Docker `test` stage as a CI build-blocker (red ⇒ no merge).

## HTTP contract (consumed by `PaperTradingClient`)

| Method + Path                    | Purpose                      | Success                                  | Error                          |
| -------------------------------- | ---------------------------- | ---------------------------------------- | ------------------------------ |
| `GET /healthz`                   | Liveness probe               | `200 {status}`                           | —                              |
| `GET /readyz`                    | Readiness (fill loop alive)  | `200 {status}`                           | `503` if fill loop dead        |
| `GET /version`                   | Pinned build + upstream SHAs | `200 {buildSha, upstreamPaperTraderSha}` | —                              |
| `POST /place-order`              | Submit a paper limit order   | `200 OrderReceipt`                       | `502` per upstream cause       |
| `POST /orders/{order_id}/cancel` | Idempotent cancel            | `204`                                    | `404` swallowed by adapter     |
| `GET /orders/{order_id}`         | Status lookup                | `200 OrderReceipt`                       | `404` → `not_found` in adapter |

Response shape on `200`: matches `PaperOrderReceiptSchema` from the app client. Realized fill fields are populated only after upstream reports `action="filled"` from `check_orders()`.

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
6. Re-run the in-image pytest: `docker build --target test -t poly-paper-trader:test sidecars/paper-trader`.
7. The sidecar smoke at `tests/test_sidecar_smoke.py` uses a stubbed Engine via `sys.modules`. The Docker `test` stage also runs the vendored maker-fill test against the real Engine.

## Notes

- v0 ships **ephemeral SQLite** at `${PM_TRADER_DATA_DIR}/${PM_TRADER_ACCOUNT}/`. Pod restart wipes open paper orders. Add a PVC only if/when preview's redeploy cadence produces visible fill-rate friction.
- Account starting balance is `PM_TRADER_STARTING_BALANCE_USDC=1000000` (1M). Upstream cap-rejection is not the safety gate; app-side trading code must enforce its own caps.
- This image is consumed **only** as a pod-loopback sidecar. Must never be exposed to a Service or Ingress — the app client default is `http://127.0.0.1:9100` through `PAPER_SIDECAR_URL`.
- Runtime binds uvicorn to `127.0.0.1`, not `0.0.0.0`. Kubernetes probes must use `exec` against loopback.
- Logging: JSON-ish single-line to stdout, with `event=…` keys + `client_order_id=…` for cross-service joins in Grafana/Loki.

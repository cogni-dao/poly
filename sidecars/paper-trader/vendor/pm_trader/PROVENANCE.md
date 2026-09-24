# Vendored: agent-next/polymarket-paper-trader

This directory is a vendored copy of the upstream Python package `polymarket-paper-trader`.

| Field            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream         | https://github.com/agent-next/polymarket-paper-trader                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Pinned SHA       | `8a0a3ee265cfd375c172626b0c63be72c07beaee`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Upstream version | `0.1.6`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| License          | MIT (see `LICENSE`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Vendored on      | 2026-05-17                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Rationale        | The upstream `Engine.check_orders()` simulates only **limit-as-taker** fills against a snapshot orderbook (`pm_trader/engine.py:476-493`). Cogni copy-trades **limit-maker** targets (swisstony, RN1) whose entry fills consume the offered liquidity, so paper orders placed at the target's price never fill on the snapshot model. We vendor the source so we can land a parallel `limit-as-maker-matched-by-takers` code path that scans trade prints between polls. See `bug.5005` in this repo's work-items API for the full diagnosis. |
| Promotion plan   | If the local diff grows large, or upstream becomes responsive to PRs, promote this vendor to `Cogni-DAO/polymarket-paper-trader` (a soft fork on GitHub) and pin the Dockerfile to that fork's SHA. Migration is trivial: this directory becomes the root of the fork.                                                                                                                                                                                                                                                                        |

## What's here vs what's not

Included from upstream@8a0a3ee2:

- `pm_trader/` — the Python package
- `tests/` — upstream's regression tests (kept for port-forward safety; **not wired into CI** — our sidecar test stage exercises `nodes/poly/sidecars/paper-trader/tests/` only)
- `pyproject.toml` — preserved verbatim except for the `readme = "README.md"` line, which is commented out so README.md doesn't need to live in-tree (see diff log)
- `LICENSE`

Deliberately excluded:

- `README.md`, `CHANGELOG.md` — root-level prettier `format:check` reformats them; rather than carry an in-repo `.prettierignore` rule for vendor (which trips `single-node-scope` as a root-config edit), we keep upstream URLs in this PROVENANCE.md for anyone who needs the canonical copy.
- `docs/`, `examples/`, `skill/`, `.github/`, `CLAUDE.md`, `server.json` — upstream-internal artifacts not needed at runtime.

## Bumping the pinned upstream SHA

When upstream releases a new version we want to track:

1. `cd /tmp && rm -rf pm_trader_src && git clone https://github.com/agent-next/polymarket-paper-trader pm_trader_src && cd pm_trader_src && git checkout <new-sha>`
2. `diff -ur nodes/poly/sidecars/paper-trader/vendor/pm_trader/pm_trader/ /tmp/pm_trader_src/pm_trader/` — review the upstream delta carefully, especially for changes near `Engine.check_orders()` and `simulate_buy_fill`/`simulate_sell_fill` shape.
3. Port our local diff forward (the maker-fill branch in `engine.py` per bug.5005).
4. `rsync -a --delete --exclude tests/ /tmp/pm_trader_src/pm_trader/ nodes/poly/sidecars/paper-trader/vendor/pm_trader/pm_trader/` (then re-apply local diff).
5. Update this file's "Pinned SHA" + "Upstream version" + "Vendored on" rows.
6. Update `UPSTREAM_PAPER_TRADER_SHA` in `nodes/poly/sidecars/paper-trader/Dockerfile` (it's now metadata-only, surfaced via `/version`'s `upstreamPaperTraderSha` field).
7. Standard PR → pr-build rebuilds the sidecar with the test_target gate → flight → `/validate-candidate`.

## Local diff log

Track every patch applied locally so port-forward is auditable.

| When       | What                                                                                                                                                                                      | Why                                                                                                                                              | Commit / bug ref |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 2026-05-17 | Vendor relocation (no behavior change)                                                                                                                                                    | Substrate for the maker-fill fix                                                                                                                 | bug.5005 Phase 1 |
| 2026-05-17 | `pyproject.toml`: comment out `readme = "README.md"`                                                                                                                                      | README.md not vendored; pip install still works                                                                                                  | bug.5005 Phase 1 |
| 2026-05-19 | `engine.py`: maker-fill pre-pass + snapshot pass synthesize 1-level book at `order.limit_price` (was `t_price` / observed best level)                                                     | Paper must clear at the resting limit, not at the taker's price; eliminates phantom price improvement                                            | bug.5016         |
| 2026-05-19 | `engine.py`: `_execute_limit_buy/sell` return the inserted Trade; `check_orders` result entries carry a `fill` dict (`avg_price`/`total_shares`/`fee`/`amount_usd`) on `action="filled"`. | Sidecar wire (server.py) needs realized fill data to populate OrderReceipt.fill_price/total_shares/fees_usdc without a separate /history lookup. | bug.5018         |

# task: research read models — tick-written per-wallet rollups replace per-request full-fills aggregation

- type: task
- status: needs_design
- filed: 2026-09-28 (brussels dev-manager; hub work-item POST returns 405 — filing on disk)
- interim: branch `fix/research-route-caching` (SWR cache + trader-comparison time budget)

## Evidence (measured on prod build 08cedd2, wallet RN1 0x2005d16a…, 2026-09-28)

| route | measured |
|---|---|
| `GET /api/v1/poly/wallets/[addr]?include=snapshot` | 26.5s |
| `…include=benchmark` | 28.1s |
| `GET /api/v1/poly/research/target-overlap` | 25.0s |
| `GET /api/v1/poly/research/trader-comparison` | 520 @ ~31s (origin exceeds edge budget) |
| `…include=distributions` (per wallet, ×N on the comparison tab) | 2.1s |
| `…include=balance` | 1.8s |

All one failure class: **per-request SQL aggregation over the full `poly_trader_fills` history** (millions of rows post-backfill) on a small pod, uncached. Distinct from the three classes fixed in the 2026-09-26 audit (V8 hydration, N+1, duplicate/uncached fetches — PRs #47–#58). "SQL-aggregated" per the data-research skill is necessary but not sufficient; the skill's 200ms-EXPLAIN gate was deferred at merge time and would have caught this.

## Design direction

Per-(wallet, interval-bucket) rollup tables written **incrementally by the trader-observation tick** (same pattern as `poly_trader_user_pnl_points`): snapshot metrics, benchmark market rows, overlap volumes, trade-size-pnl buckets. Request path reads O(1)–O(bounded) rows. Requirements:

1. Design doc citing these measurements + row-count evidence from prod.
2. Parity oracle vs the live aggregation (data-research skill § 5), boundary cases included.
3. EXPLAIN ANALYZE + **authed** route timings on candidate BEFORE merge — the gate that was skipped last time. Target <1s per route.
4. Backfill path for existing history; incremental update on each tick thereafter.
5. Interim SWR caches demoted/removed once rollups serve the routes.

## Related
- bug.5283/#65, bug.5284/#67, #69 (Data-API 429 discipline) — rollup writer must respect the process-wide limiter.
- bug.5275 (operator): 0.2→1.4s pre-app edge tail, separate layer.

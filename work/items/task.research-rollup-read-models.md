# task: research read models — tick-written per-wallet rollups replace per-request full-fills aggregation

- type: task
- status: in_review (design + implementation on branch `feat/research-rollup-read-models`)
- filed: 2026-09-28 (brussels dev-manager; hub work-item POST returns 405 — filing on disk)
- interim: branch `fix/research-route-caching` (SWR cache + trader-comparison time budget) — now demoted to cheap-hit cache, see § Design

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

## Design (as built, branch `feat/research-rollup-read-models`)

### What the four reads actually aggregate

| service | full-history aggregation (pre-rollup) | shape |
|---|---|---|
| `wallet-analysis-service.getSnapshotSlice` | per-(condition, token) buy/sell USDC+shares sums, first-BUY ts, last ts over ALL fills; plus a 30d count FILTERed with **no WHERE bound** (full scan) | per-token cumulative |
| `copy-target-benchmark-service` | per-(condition, token) windowed `SUM(size_usdc)`, `SUM(shares)`, VWAP for two wallets; two scalar `COUNT(*)` subselects over the window | per-token windowed |
| `target-overlap-service` | windowed `SUM(size_usdc)` per bucket via a fills join on the two wallets' active condition set | per-condition windowed |
| `trader-comparison-service` | windowed counts/notional/`COUNT(DISTINCT condition)`; and for size-P/L: per-fill rank bucketing over windowed BUYs + **full-history** per-token flows + per-(condition, token) BUY costs | mixed: per-fill ranks + per-token cumulative |

Every aggregation except trader-comparison's rank bucketing is a sum/count/min/max over (wallet, condition, token) groups, optionally time-windowed. That drives the decision:

### Decision: ONE rollup table, day-grained, plus a per-wallet watermark

**`poly_trader_fill_rollups_daily`** — PK `(trader_wallet_id, condition_id, token_id, day)` where `day` = UTC day of `observed_at`. Columns: `fill_count, buy_count, sell_count, buy_usdc, sell_usdc, buy_shares, sell_shares` (additive), `first_buy_observed_at, first_observed_at, last_observed_at` (monotone LEAST/GREATEST), `updated_at`. Indexes from the read queries: PK prefix serves wallet- and (wallet, condition)-led scans; `(trader_wallet_id, day)` serves windowed range scans; `(trader_wallet_id, token_id)` serves comparison token flows. No RLS (no tenant FK — matches sibling `poly_trader_*` observation tables). Numeric sums are exact (`numeric(20,8)` addition), so rollup-derived sums are bit-identical to summing raw fills in any order.

Day grain (not cumulative-only) is what lets ONE table serve both cumulative reads (snapshot, comparison token flows: sum all days) and windowed reads (benchmark/overlap/summary 1D/1W/1M/1Y/YTD: range-scan `day >= boundary`). Row-count reduction on prod-shaped data: unique (wallet, token, day) vs fills ≈ 100-1000x fewer rows (per-token fills cluster within days).

**`poly_trader_fill_rollup_cursors`** — PK `trader_wallet_id`; watermark `(last_created_at, last_fill_id)` = the **insertion key** of the last rolled fill (zero-UUID default keeps tuple comparisons NULL-free), plus `rolled_fill_count` for observability.

### Exact-window reads: rollup + boundary + tail (`windowedFillFlowsSelect`)

Window starts are `now - 24h` etc. — not day-aligned — and rollups lag the tick by up to one batch budget. Serving day buckets alone would change outputs at the boundary day and during lag, breaking the parity contract. Every rollup-backed reader therefore composes, in ONE SQL statement (single snapshot):

1. **rolled full days**: `rollups.day >= rollupFromDay` (first UTC day fully inside the window);
2. **boundary fragment**: fills with `observed_at ∈ [windowStart, rollupFromIso)` read live regardless of rolled status (≤ 1 day of fills via the `(wallet, observed_at)` index; empty when the window starts at UTC midnight — including epoch/ALL);
3. **unrolled tail**: fills with `(created_at, id) >` the wallet watermark and `observed_at >= rollupFromIso` (≤ one tick of fills once backfilled; the whole history for a never-backfilled wallet — graceful degradation, not wrongness).

The three parts are disjoint and complete, so rollup-backed output is **exactly** the legacy full-scan output at all times — the property the parity suite enforces. This is why the readers work correctly even before the backfill finishes.

### Watermark + idempotency semantics (writer)

- Each accumulate batch is ONE SQL statement: `FOR UPDATE` on the cursor row → select the next ≤ N fills ordered by `(created_at, id)` → `INSERT ... ON CONFLICT DO UPDATE` accumulate (`+=` sums, `LEAST/GREATEST` bounds) → advance the watermark. Statement atomicity means a fill is folded exactly once or the batch rolls back — re-processing a window cannot double-count. Tested: same-window-twice, multi-batch vs single-batch, backfill-half + ticks vs backfill-all.
- The watermark tuple never round-trips through JS: a JS `Date` truncates Postgres microseconds, which would re-admit the boundary row on the next batch (double-count). It moves only inside the batch statement.
- **Why `created_at` (insertion time), not `observed_at`**: the ingestion cursor's `observed_at` watermark can be leapfrogged by historical backfills (fills inserted later with older `observed_at` would be silently skipped forever). Insertion order is the true "new to this DB" signal; any future fills backfill is swept automatically.
- Soundness precondition (documented invariant `FILLS_WRITERS_SERIALIZED_PER_WALLET`): per-wallet fills writers are serialized — true today because the trader-observation tick is the only fills writer, leader-elected (task.5016), guard held until abandoned writers settle (bug.5297). Serialized writers make `created_at` (= insert-txn start) monotone per wallet across commits, so "max visible insertion key" can never skip a not-yet-visible fill. Concurrent **accumulators** (boot backfill vs tick) are serialized by the cursor row lock; the tick passes `NOWAIT` and skips instead of stalling.

### Writer placement + backfill

- **Incremental**: `runTraderObservationTick` → per wallet, after the fills upsert (`ROLLUPS_FOLLOW_FILLS`), `accumulateFillRollups(maxBatches=4, batchSize=5000, skipIfLocked)`. DB-only — the process-wide Data-API limiter (#67/#69) is not involved (verified: no upstream client imports anywhere in `fill-rollup-service.ts`).
- **Backfill**: one-shot boot walker `startFillRollupBackfill` (jobs seam, leader-only, `pLimit(1)`, gated by `POLY_FILL_ROLLUP_BACKFILL_ENABLED`, default true) reusing the same accumulate function; resumable at the watermark. Even if it never runs, the tick's per-wallet budget (4x5k per 30s tick ≈ 100k+ fills/5min across wallets) drains history; RN1-scale (5.2M) ≈ tens of minutes either way.

### Which services moved where (and why)

| read | disposition |
|---|---|
| snapshot position aggregates | rollup+tail (cumulative flows) |
| snapshot 30d activity count | rollup+boundary+tail count (legacy had an unbounded full scan); `latestTs` = index MAX |
| snapshot dailyCounts (14d) | unchanged live SQL — already bounded by the `(wallet, observed_at)` index |
| benchmark market VWAP rows | rollup+tail windowed flows (`size = buy+sell`, `shares = buy+sell`, same VWAP expression) |
| benchmark windowed trade counts | rollup+tail counts (replaces two full-scan scalar subselects) |
| benchmark positions/gaps/hedge | unchanged — already bounded on `poly_trader_current_positions` |
| overlap volumes CTE | rollup+tail flows joined to the active-condition set |
| comparison summary | rollup+tail (counts, notional, `COUNT(DISTINCT condition)` over flow rows) |
| comparison `token_flows` / `condition_token_costs` | rollup+tail cumulative flows — the 100-1000x smaller derived table |
| comparison `windowed_buys` (rank bucketing) | **stays live SQL over fills, by design** — see below |

**Why rank bucketing cannot be rollup-served**: `floor((i/n)*20)` buckets by RANK over the window's BUY fills sorted by size (ties by `observed_at, id`). Bucket membership depends on the window (n and every rank change when the window changes), so pre-bucketed rollups are impossible; and per-bucket `min/max/sum` need individual fill sizes, so any fixed-resolution size histogram loses bit-exactness against the preserved JS oracle. The irreducible per-fill cost is one index-driven window scan + sort *inside Postgres* (≤20 rows reach V8); everything around it (per-token P/L flows, hedge costs — the dominant full-history scans) is rollup-backed. If candidate EXPLAIN shows the ALL-window sort still breaching budget, the escalation path is a `(trader_wallet_id, side, observed_at) INCLUDE (size_usdc, ...)` partial index or a materialized per-window cache — not pre-bucketing.

### Rejected alternatives

1. **Per-(wallet, token) cumulative-only rollup (no day grain)** — serves snapshot + comparison flows but cannot serve any window other than ALL; benchmark/overlap/summary would still full-scan on 1D/1W/1M. Rejected: day grain costs ~row-count x days-active and buys every window.
2. **Pre-bucketed trade-size/P-L rollups** — bit-exact float8 rank bucketing is window-dependent (above). Rejected as impossible without changing the contract.
3. **`observed_at`-watermarked writer driven by the ingestion cursor** — leapfrogged by historical backfills; silently drops late-inserted old fills. Rejected for the insertion-key watermark.
4. **Day-bucket-only reads (accept boundary-day drift)** — breaks the parity oracle and makes 1D windows mostly-wrong (a 24h window spans ≤ 2 partial days). Rejected for rollup+boundary+tail composition.
5. **Postgres materialized views + REFRESH** — full recompute per refresh (the 25-60s scan, on a schedule), no incrementality, and REFRESH CONCURRENTLY still rereads everything. Rejected.
6. **Bigger pod / longer budgets / more caching** — the #71 SWR cache already showed the ceiling: every cold compute and SWR refresh still costs 25-60s of DB time. Band-aid class per data-research skill § 8.

### Interim-cache disposition (#71)

`research-read-cache.ts` SWR wrappers stay as cheap-hit caches (request coalescing + burst absorption) — `INTERIM_ONLY` invariant replaced by `CHEAP_HIT_CACHE`. The boot prewarm job is demoted to a first-paint nicety and marked candidate-for-deletion once candidate timings confirm sub-second rollup reads.

### Parity coverage (component lane, testcontainers)

- Writer: accumulate == direct `GROUP BY` truth (incl. exact-midnight and midnight±1ms day bucketing); same-window-twice idempotency; multi-batch == single-batch; backfill-half + incremental == backfill-all; `maxBatches` resume; full walker to caught-up. (`fill-rollup-writer.int.test.ts`)
- Readers: every rollup-backed reader vs the preserved legacy full-scan SQL oracle (`tests/_fixtures/poly/research-live-scan-oracles.ts`) and the legacy JS trade-size/P-L reducer, across rollup states {cold, partial, warm, warm+unrolled-tail} x windows {epoch/ALL, UTC-midnight-aligned, mid-day (boundary fragment)} x both wallets, with fixtures at the window-start equality point, 1ms before it, exact midnight, and a SELL-only token. (`fill-rollup-read-parity.int.test.ts`)
- Pre-existing bug.5008 suite (`trader-comparison-sql-parity.int.test.ts`) still passes against the rewritten `readTradeSizePnl` (cold-state coverage with boundary-heavy fixtures).

### Deferred to candidate (requirement 3 of this item — NOT yet done)

`EXPLAIN ANALYZE` + authed route timings at prod scale (RN1 5.2M fills) must run on a flighted candidate BEFORE merge to prod promotion — local testcontainers cannot reproduce the plans. Explicit checklist: plans for each rollup-backed statement attached to the PR; each route < 1s; verify the one-time `CREATE INDEX poly_trader_fills_trader_created_idx` migration cost on the multi-million-row fills table (blocking writes for the build duration on the migrate initContainer) is acceptable, and watch the first backfill drain (`poly.fill_rollup.backfill_*` log events).

## Related
- bug.5283/#65, bug.5284/#67, #69 (Data-API 429 discipline) — rollup writer must respect the process-wide limiter.
- bug.5275 (operator): 0.2→1.4s pre-app edge tail, separate layer.

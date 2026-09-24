# Recipe — Copy-target pXX calibration

> Load when: the hardcoded `TOP_TARGET_SIZE_SNAPSHOTS` in `app/src/bootstrap/jobs/copy-trade-mirror.job.ts` looks stale, or someone asks "is our copy-target sizing config still right?", or a target wallet's trading volume has changed significantly. Also: when designing a config change to `sizing_min_target_usdc` / `sizing_max_target_usdc` / `DEFAULT_CONVICTION_FILTER_PERCENTILE`.
>
> Canonical example of running this loop: PR #83 + task.5045 — full record at [`docs/research/poly/copy-target-north-star-2026-05-16.md`](../../../docs/research/poly/copy-target-north-star-2026-05-16.md) and reproducible queries at [`docs/research/poly/queries/`](../../../docs/research/poly/queries/).

## The mental model (read before running queries)

The algorithm in `plan-mirror.ts:104-138` (`target_percentile_scaled` policy):

```
ratio = clamp((target_cost - min_target_usdc) / (max_target_usdc - min_target_usdc), 0, 1)
our_size = floor + (max_usdc_per_condition - floor) × ratio
```

`target_cost` = `targetTokenCostUsdc` per fill — the **cumulative cost on the specific token of that fill**. So:

- The **dominance gate** (`target_dominant_other_side`, `min_target_side_fraction=0.2`) runs first and **skips minority/hedge fills**.
- Sizing pXX applies only to **dominant-side decisions** → calibrate to the **primary-only** token-position distribution.
- `min_target_usdc = snapshot.percentiles[DEFAULT_CONVICTION_FILTER_PERCENTILE]` (default 75).
- `max_target_usdc = snapshot.percentiles[99]`.

**Common failure mode**: snapshotting over ALL token positions (including hedges) deflates p50/p75/p90 by 2-3× because hedge tokens have much smaller costs than primaries. The p99 is roughly accurate either way because it's tail-dominated by primaries.

## Step-by-step

### 1. Confirm the target wallet's recent activity is in the DB

Most copy-target wallets have continuous live-tick observations in prod. For a fresh calibration, the past 30 days of prod fills is usually enough — no backfill needed.

```bash
./scripts/grafana-postgres-query.sh "select trader_wallet_id, min(observed_at) as earliest, max(observed_at) as latest, count(*) as fills from poly_trader_fills where trader_wallet_id = '<id>' and observed_at >= now() - interval '30 days' group by 1" <operator-provided-poly-postgres-datasource>
```

If past-30d fills < ~5,000: percentiles will be noisy. Either pick a larger window or backfill earlier history via `scripts/experiments/poly-backfill/walk-windows.sh + load.ts` (spike.5024). See [`docs/guides/poly-target-backfill.md`](../../../docs/guides/poly-target-backfill.md).

### 2. Compute primary-side pXX (the one query that matters)

This is the canonical query. Returns one row per (wallet, role) with p50/p75/p90/p95/p99:

```sql
with token_cost as (
  select trader_wallet_id, condition_id, token_id, sum(size_usdc) as cost
  from poly_trader_fills
  where trader_wallet_id in ('<id1>', '<id2>')
    and observed_at >= now() - interval '30 days'
  group by 1, 2, 3
  having sum(size_usdc) > 0
),
classified as (
  select tc.trader_wallet_id, tc.cost,
    case
      when count(*) over (partition by tc.trader_wallet_id, tc.condition_id) = 1 then 'single'
      when tc.cost = max(tc.cost) over (partition by tc.trader_wallet_id, tc.condition_id) then 'primary'
      else 'hedge'
    end as role
  from token_cost tc
)
select w.label, c.role, count(*) as positions,
       percentile_cont(0.50) within group (order by c.cost)::numeric(10,2) as p50,
       percentile_cont(0.75) within group (order by c.cost)::numeric(10,2) as p75,
       percentile_cont(0.90) within group (order by c.cost)::numeric(10,2) as p90,
       percentile_cont(0.95) within group (order by c.cost)::numeric(10,2) as p95,
       percentile_cont(0.99) within group (order by c.cost)::numeric(10,2) as p99
from classified c
join poly_trader_wallets w on w.id = c.trader_wallet_id
group by 1, 2 order by 1, 2;
```

Use **only the `primary` row** for `TOP_TARGET_SIZE_SNAPSHOTS`. The `hedge` row is informational (you can compare it to current `min_target_hedge_ratio` / `max_hedge_fraction_of_position` defaults). The `single` row is also informational.

Reference query: [`q15-past-month-pXX-primary-vs-hedge.sql`](../../../docs/research/poly/queries/q15-past-month-pXX-primary-vs-hedge.sql).

### 3. Sanity-check stability — re-run at a different window

If 30d primary p75 disagrees with 14d primary p75 by more than ~10%: the wallet's behavior is in flux, hold off on the config change and watch another week.

Reference query for monthly trend: [`q16-pXX-primary-monthly-over-time.sql`](../../../docs/research/poly/queries/q16-pXX-primary-monthly-over-time.sql).

### 4. Write the config change

Edit `app/src/bootstrap/jobs/copy-trade-mirror.job.ts`:

```ts
const TOP_TARGET_SIZE_SNAPSHOTS: Record<string, WalletSizeSnapshot> = {
  [WALLET_ADDR]: {
    wallet: WALLET_ADDR,
    label: "<label>",
    captured_at: "<ISO timestamp>",
    sample_size: <primary positions count>,
    percentiles: { 50: ..., 75: ..., 90: ..., 95: ..., 99: ... },
  },
};
```

Update the four test expectations in `app/tests/unit/bootstrap/jobs/copy-trade-mirror-sizing.test.ts` if that test has been ported (`min_target_usdc` + `max_target_usdc` for each wallet x percentile combo). Run `pnpm check:fast`.

### 5. Save the run for reproducibility

Per the data-research skill's reproducibility protocol:

- Drop the SQL into `docs/research/poly/queries/qNN-<name>.sql` (start with `with` so the bash helper accepts it).
- Drop a `qNN-<name>.results.md` next to it with run-by-run results, sample size, and any sample-stability notes.
- Cite both from the PR description.

## Gotchas

- **Grafana datasource has a ~30s statement_timeout.** Window functions over millions of rows on a busy `poly_trader_fills` can hit the cap, especially with concurrent writes. Workaround: split by month (`observed_at >= 'YYYY-MM-01' and < 'YYYY-MM+1-01'`) or use a two-stage `GROUP BY` + `MAX()` instead of `case…over…partition by`.
- **`DEFAULT_CONVICTION_FILTER_PERCENTILE`** (currently 75) is a separate decision from the snapshot itself. Re-snapshotting widens the band but doesn't change the floor. If the new p75 skips edge-positive cost bands you measured via fill-level winner rate (see Q11/Q12/Q14 results), consider lowering the filter percentile to p50 — but track that as a separate config change.
- **Don't conflate condition-level total_cost with fill-level cost_after.** Condition-level (`Q06`-style, sum across all fills) is what you want for _position sizing_. Fill-level cost_after (`Q11`-style) is what the algorithm sees per decision — useful for picking edge boundaries (min/max), not for pXX snapshots.
- **The `captured_at` field in the snapshot is for humans + audit, not the algorithm.** Stale `captured_at` is the cheapest red flag — if it's been ≥ 60 days since you re-snapshotted and the wallet's been actively trading, it's almost certainly drifted.

## Confidence anchor

Past-30d and past-14d primary pXX should agree within ~1%. Q15 vs Q13 in the reference investigation confirmed this. If they don't, **don't push the config change** — there's something unstable about the wallet or the data.

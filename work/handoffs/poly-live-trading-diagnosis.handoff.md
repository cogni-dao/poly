---
work_item: (file a bug — "poly prod live copy-trade fires but no fills land")
branch: main @ 8f371a7 (deployed to prod, gen-4 lease)
status: prod live + executor UP; zero successful mirror fills; diagnosis below
author_context: prior session ran the prod-live bring-up; handing off low-on-context
---

# Handoff: poly prod live trading fires but no fills land — diagnose

## TL;DR
Prod is **live on `8f371a7`** (gen-4 akash lease, `/readyz` 200, executor UP). Derek's tenant
**`2aa53f4c`** (trading wallet `0x88fA0742Fd24Bf2e72C1087fc49b6e089Da40Fb8`, funded **1,132 pUSD**)
has **RN1 active** (P70→min, P100→max, **$20/trade, $200/day, P100-max $5**). The mirror poll IS
firing on RN1's fills, but **zero orders land** — every attempt skips or the CLOB rejects it.
**Two real problems + one UI gap. The copy-trade ALGORITHM is NOT the bug** (verified byte-identical
to the OG repo). Your job: nail the CLOB `placement_failed`, confirm the cap-vs-market-min story, and
determine whether current activity can surface in the dashboard.

## Ground truth — how to see it
Prod app logs via operator Loki proxy (node's own hub has NO logs surface; use operator):
```
KEY=$(grep '^COGNI_API_KEY=' /Users/derek/conductor/workspaces/poly/kyoto/.env.cogni | cut -d= -f2- | tr -d '"')
curl -sG "https://cognidao.org/api/v1/nodes/poly/observability/logs" -H "authorization: Bearer $KEY" \
  --data-urlencode "env=production" --data-urlencode 'query={service="app"} |~ "poly.mirror.decision"'
```
Decision outcome histogram observed 2026-09-26 ~23:00 UTC (mix of Derek's `2aa53f4c` + a stale tenant):
| count | reason |
|---|---|
| 41 | `executor_resolve_failed` — **NOT Derek**; stale tenant `207795de` (conn `49cfd0b4`), err `no active trading wallet`. Separate user; ignore for Derek's issue (but a real broken onboarding). |
| 27 | `below_target_percentile` — RN1 positions below P70 |
| 18 | `below_market_min` — sized order below the market floor |
| 10 | `vwap_floor_breach` — price moved past tolerance during mirror lag |
| 4 | `placement_failed` — **CLOB REJECTED** the order |

Killer line:
```
execute: rejected — PolymarketClobAdapter.placeOrder: CLOB rejected order
(error_code=unknown, response_keys=[error,status], reason="unknown")   size_usdc=3.597  target_position_usdc=59366.85
```

## Finding 1 — the algorithm is intact (do NOT chase a port regression)
`app/src/features/copy-trade/plan-mirror.ts` is **identical to the OG** (`/Users/derek/conductor/workspaces/cogni-poly/louisville/nodes/poly/app/src/features/copy-trade/plan-mirror.ts`) — both 1110 lines, same skip reasons. `applyMarketFloors` DOES clamp up: `size_usdc = min(max(desired, floorUsdc), maxUsdcPerCondition)`. So min-scaling works. The design deliberately **skips (never amplifies)** only in the `position_gap` below-floor branch (lines ~126-145, comment "do NOT clamp up"). Derek uses **`target_percentile_scaled`** (P70↔P100), which goes through `applyMarketFloors` (clamp-up path), lines ~160-192.

## Finding 2 — `below_market_min` (18×): $5 P100-max < market floor
`applyMarketFloors` returns `below_market_min` only when `size_usdc < floorUsdc` after `min(max(desired,floor), maxCap)` — i.e. **`maxCap ($5) < floorUsdc`**. RN1 ($59k positions) trades in markets whose **min order exceeds $5**, so Derek's cap can't meet them. **Likely fixed by raising per-trade / P100-max caps.** VERIFY: for the specific RN1 markets being skipped, what is `min_usdc_notional`/`min_shares×price`? (logs carry `getMarketConstraints` reads, `mirror-pipeline.ts:368-379`).

## Finding 3 — `placement_failed` (4×): CLOB reject on a $3.60 order, reason "unknown" — TOP PRIORITY
An order that PASSED our floor (so our `minUsdcNotional` said $3.60 OK) was **rejected by the live CLOB** with an unparseable error. $3.60 > Polymarket's ~$1 min, so this is **probably NOT size**. Suspects, in order:
1. **`POLY_CLOB_GEO_BLOCK_TOKEN` is UNSET on prod** (optional secret, never migrated — confirm). Poly CLOB order creds derivation / geo path may need it.
2. Tick-size / price-precision rejection (order price not on the market's tick grid).
3. neg-risk market SELL semantics, or a CLOB-creds/derivation problem for the new tenant wallet.
Our adapter logs `reason="unknown"` because it can't parse the CLOB response — **the raw CLOB response body is what you need.** Dig `PolymarketClobAdapter.placeOrder` (`packages/poly-market-provider/**` / `app/.../poly-trade-executor`) and log/inspect the actual `error`+`status` keys the CLOB returned. See skill `poly-market-data` (CLOB wire semantics, empty-reject, neg-risk).

## Finding 4 — dashboard shows no RN1/swisstony activity
- **No successful fills exist** (all skipped/rejected) → `poly_copy_trade_fills` empty → nothing for a fills-based view to show. Current SUCCESSFUL trades will appear once Findings 2+3 are fixed.
- **The live DECISION stream IS being produced** (`poly_copy_trade_decisions` + Loki `poly.mirror.decision`) but the UI does **not surface skip/reject reasons** — the real UX gap ("active" but no feedback on why nothing lands). Decide: should "My Runs" surface the decision stream? (`app/src/app/(app)/research/**`, `app/src/features/wallet-analysis/server/**`).
- **Historical** RN1/swisstony data is empty because the **Jun-19 prod DB restore is deferred** (`task.5007`) + derived tables (`poly_trader_position_snapshots`, `poly_market_metadata/outcomes/price_history`) unpopulated on prod. Separate operator-plane concern. wallet-watch IS collecting forward (`wallet-watch fetch: ok` for RN1 `0x2005d16a` + others).
- OPEN QUESTION Derek asked: "forget historical — is CURRENT data going to appear, or is that flawed?" → trace the "My Runs" data route to confirm whether it reads live `poly_copy_trade_{decisions,fills}` (current) or only the derived research tables (needs backfill). Not yet traced.

## Tenant map (I got this WRONG once — verify)
- **Derek = `2aa53f4c`** (wallet `0x88fa` → `poly.wallet.balances ba=2aa53f4c`). RN1 active. WORKING pipeline.
- `207795de` (conn `49cfd0b4`, user `a4933db5`) = a **different, broken** tenant (`no active trading wallet`) — NOT Derek. Its `/wallet/status` errors + `executor_resolve_failed` every 60s. Someone's onboarding is half-done; poly-auth-wallets to fix if it's a real user.

## Do next (recommended order)
1. **Findings 3** — pull the raw CLOB rejection body for the `placement_failed` orders; confirm/deny `POLY_CLOB_GEO_BLOCK_TOKEN` unset + tick-size. This is the true blocker to a first real fill.
2. **Finding 2** — with Derek, raise caps so orders clear RN1's market minimums; re-observe.
3. Then a controlled first live fill on RN1, verify `poly_copy_trade_fills` row + it shows in the dashboard.
4. Finding 4 — decide + file the UI decision-visibility gap.

## Guardrails
- REAL money now (live-CLOB, no paper stub). Caps in `poly_wallet_grant` are the safety — start small.
- Do NOT re-migrate secrets from `/Users/derek/dev/cogni-poly/.env.production` — it's `'`-escape corrupt (caused the prod outage 2026-09-26). Wallet secrets are operator-managed. `POLY_WALLET_AEAD_KEY_HEX` is substrate `source:agent` (403 self-serve is correct). See memory `poly-akash-secret-injection`.
- Node owns code/secret-shapes; operator owns deploy/secret-values. Validate on candidate-a before merge.
- Skills: `poly-dev-manager` (router) → `poly-market-data` (CLOB), `poly-copy-trading` (mirror), `poly-auth-wallets` (wallets/AEAD), `data-research` (dashboard/SQL).

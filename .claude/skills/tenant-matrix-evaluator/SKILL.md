---
name: tenant-matrix-evaluator
description: "Cross-policy A/B evaluator across every per-(env, tenant) paper-trading account in chr.poly-algo-tenant-matrix. Runs against one target wallet over a window, produces an HTML report with bar-chart graphs per metric + an LLM-authored top finding. Use when: 'evaluate the matrix', 'is position_gap beating tps?', 'tenant A/B for swisstony', '/tenant-matrix-evaluator', 'rank our policies on real target activity'. Sibling to /delta-minimizer (one market) and /paper-trade-diff-analysis (one twin × one prod)."
---

# Tenant Matrix Evaluator

> Zoom level: cross-policy A/B across every charter-listed tenant on ONE target wallet. **Tool emits graphs; agent emits ONE finding.**

> Operator-node note: tenant-matrix source/report artifacts can live here, but tenant env blocks, API keys, DB data sources, and candidate/preview/prod deployment state are operator-owned. Use explicit operator-provided env/config; never synthesize tenant credentials locally.

**Tool availability:** if `scripts/tenant-matrix-evaluator.ts` is absent in this node repo, the first task is to port that node-owned report tool source-traceably from legacy. Do not approximate the matrix from ad hoc queries and call it a completed evaluator run.

## Terminology — read this before reading the report

There is **ONE trust twin per validation contract**. It is the paper-side tenant in the flighted non-production environment whose sizing policy + config is a **1:1 match with live**. Its only job is to answer one question: _does the paper adapter produce the same orders + fills as the real Polymarket CLOB when fed the identical algorithm?_ Hold the algo constant; only paper-vs-live varies.

When live trading is disabled, **the trust twin question is irrelevant** — there is no live signal to compare against, so paper fidelity is untestable until live trading resumes. Q1 must say `NOT TESTABLE` and explain why.

**Other paper tenants are NOT trust twins**, regardless of what their env-block name says:

- Historical `TRUST_TWIN`-named env blocks may actually model swisstony's book size via a `position_gap` policy variant. That makes them **budget modelers** — paper variants whose sizing knobs are tuned to the target wallet's book scale, NOT trust twins. Classify by policy/config match, not by env-var label.
- Every other paper tenant (`GAP`, `VALIDATION`, candidate duplicates, etc.) is a **policy variant** — different policy, different cap, different filter. They're useful for Q2 (ranking which algo comes closest to swisstony's actual behavior), not Q1.

Practical rule: **only the policy-match-to-live tenant counts as a trust twin.** Q1 picks it by comparing each paper tenant's `(sizing_policy_kind, mirror_max_usdc_per_trade, target_range_max_usdc, mirror_max_alloc_per_condition_usdc, mirror_filter_percentile)` against the live row in `poly_copy_trade_targets`. If no exact match exists, Q1 = `NOT TESTABLE — no fidelity twin configured`.

## Discovery sources (what the tool sees)

- **Env-discovered tenants** — operator-provided `POLY_<env>_TENANT_<role>_{API_KEY,BILLING_ACCOUNT_ID}` pairs in process.env. Available for observation only in this skill.
- **DB-only tenants** — active rows in `poly_copy_trade_targets` (any env) whose billing_account_id has no matching env block. Available for observation through the operator-provided read path; NOT mutatable from this skill. These are tagged `(DB-only)` in the report and surfaced in the env-gap strip — they are NOT excluded from analysis.

## Required reading

- [`docs/spec/poly-tenant-matrix-evaluator.md`](../../../docs/spec/poly-tenant-matrix-evaluator.md) — spec, invariants, done condition
- [`work/charters/POLY_ALGO_TENANT_MATRIX.md`](../../../work/charters/POLY_ALGO_TENANT_MATRIX.md) — the matrix this tool consumes
- [`.claude/skills/delta-minimizer/SKILL.md`](../delta-minimizer/SKILL.md) — finding discipline (one primary, % confidence, file:line cite, charter class)
- [`work/charters/POLY_COPY_DELTA.md`](../../../work/charters/POLY_COPY_DELTA.md) — D-class taxonomy used in findings

## Outcome contract

A run is complete when ALL of these are true:

1. `report.html` rendered with the **structured Δ summary block above the takeaway** (three lines: closest-to-target, prod-twin fidelity, sample-size floor), the **🪞 prod-twin fidelity Δ section** with classification chip, the **🎯 distance-to-target leaderboard chart** sorted ascending, then the legacy Q1 + Q2 blocks + decisions reference.
2. `bundle.json` covers every operator-provided tenant block (no `half-block detected` errors at startup). Charter-active tenants without env blocks emit `::warning::matrix gap: ...` and appear in `env_gap_warnings` — they do NOT block the run, but they DO require a follow-up.
3. Target-wallet fills appear in the bundle (>0 markets, plausible volume) OR the tool failed fast with the verbatim `::error::target-wallet has no fills in DS=<uid> for window; check DS config — wallet-watch is NOT the suspect…` message. Silent-zero behavior is not allowed. Low-sample rows (resolved markets < 50) appear in `sample_floor_warnings[]` and 🟡 in the structured summary.
4. The `<!-- TAKEAWAY:START -->` block carries **ONE sentence, ≤20 words**, in **bold**, of the most decision-changing signal. Hard cap. Optional muted-text postfix: `% confidence · cause · next-fix · see appendix`. NO paragraphs, NO multi-claim findings, NO code blocks, NO inline reasoning. **All supporting reasoning goes in an `<details>` appendix block** below the chart area. The takeaway is for humans who don't read; the appendix is for humans who do.
5. `findings.json` mirrors the TAKEAWAY: `primary_class` (D1–D8 or `null`+reason), `primary_confidence` (0–1), `primary_one_liner` (≤20 words, machine-readable mirror of the bold sentence), `pareto_next_fix` (≤20 words), `evidence.code_path` (file:line), `authored_at`. AND the four structured Δ fields the tool pre-fills: `closest_to_target_role`, `closest_to_target_distance`, `prod_twin_fidelity_pct`, `prod_twin_fidelity_class`. The LLM is forbidden from claiming a paper policy beats the target on PnL when `prod_twin_fidelity_class` is `red` — that result is gated.
6. Zero `POST/PATCH/DELETE` lines against `poly-*.cognidao.org` in stderr — the tool is GET-only by construction; if anything else appears, that's a regression to file.
7. **Final-step human handoff (MANDATORY).** The agent's last message MUST contain exactly two lines: (a) the absolute file path to `report.html` so the human can `open` it, (b) the bold one-liner takeaway verbatim. Anything else the human wants they can pull from the report. Do NOT re-narrate the bundle in chat.

## Workflow

```bash
# Operator-provided tenant/read env must be present.
pnpm tsx scripts/tenant-matrix-evaluator.ts \
  0x204f72f35326db932158cba6adff0b9a1da95e14 \
  [--since 2026-05-17T00:00:00Z] [--until 2026-05-18T00:00:00Z] \
  [--control-tenant-role POLY_PREVIEW_TENANT_TRUST_TWIN] \
  [--target-ds-uid cogni-preview-poly-postgres] \
  [--out path]
```

**Default control axis: the target wallet itself.** No paper-tenant control unless `--control-tenant-role` is set explicitly. Default window: last 24h. Output dir: `research/tenant-matrix/<iso>/`.

**Target DS resolution.** The tool probes every unique env DS (`cogni-<env>-poly-postgres`) for the target wallet's `poly_trader_fills` hourly buckets and picks the env with the most non-zero buckets. If every env returns 0, the tool fails fast with `::error::target-wallet has no fills in DS=<uid> for window; check DS config — wallet-watch is NOT the suspect, the data is in poly_trader_fills in every env's poly DB.` That message is the punchline: when the previous tool version silently produced empty matrices for weeks, the cause was a Grafana DS pointed at the wrong DB, not a wallet-watch backfill gap. Wallet-watch is fine in every env.

1. **Run the tool.** It auto-discovers tenants from operator-provided `POLY_<ENV>_TENANT_<ROLE>_*` env vars; fails fast on half-blocks. Charter-active tenants without env blocks emit `::warning::matrix gap` lines — they're listed in `env_gap_warnings[]`. File a follow-up to wire the env block through the operator flow; do not paper over with a synthesized role.
2. **Read the Δ summary block first.** Three lines above the takeaway: closest-to-target, prod-twin fidelity, sample-size floor. The leaderboard chart sorts paper policies by aggregate distance to swisstony ascending — first row is the promotion candidate. If prod-twin fidelity is 🔴, the leaderboard is GATED — do not promote anything.
3. **Cross-reference code BEFORE claiming.** Skip-reason or sizing claim → cite `app/src/features/copy-trade/plan-mirror.ts:<line>`. Volume / mode mismatch claim → cite `app/src/bootstrap/jobs/copy-trade-mirror.job.ts` or `target-source.ts`. No file:line = not done.
4. **Author the TAKEAWAY + appendix + findings.json.** One bold ≤20-word sentence in the TAKEAWAY block. Full reasoning in a `<details><summary>🔎 Finding detail</summary>…</details>` appendix above the existing chart appendices. `findings.json` mirrors with `primary_one_liner` (≤20 words), `primary_confidence`, `primary_class` (D1–D8 or `null`+reason), `pareto_next_fix` (≤20 words), `evidence.code_path`.
5. **Reframe instruments, don't rename them.** If a matrix row falsifies its own assumption (e.g. a "trust twin" reveals paper isn't trustworthy), that's the instrument working — the right call is to heed it, not to rename it. Take care to distinguish "the experiment failed" from "the question was wrong."
6. **Commit the timestamped dir.** History matters.
7. **Hand off to the human.** Two-line final message: `open <abs-path-to-report.html>` and the bold one-liner verbatim. Stop there.

## What the tool does (so you don't redo it)

- Globs `process.env` for `POLY_<ENV>_TENANT_<ROLE>_{API_KEY,BILLING_ACCOUNT_ID}` pairs.
- Per tenant: `GET /api/v1/poly/research/copy-trade-pnl` → filtered to target_wallet client-side → fills aggregate.
- Per tenant: Grafana Postgres SELECT on `poly_copy_trade_decisions` filtered by `(billing_account_id, target_id, window)` → outcome + skip-reason aggregate.
- A/B compare each non-control tenant against the control on 6 axes.
- Renders inline-SVG bar charts (no JS), A/B Δ-table, TAKEAWAY stub, bundle, findings stub.

## What the tool does NOT do (yet)

- **VWAP, realized PnL, winrate** — require `poly_market_outcomes` + `poly_trader_position_snapshots` joins; v0-deferred. Bundle carries `null` for those metrics; finding MUST NOT claim VWAP-delta until the joins land.
- **Per-tenant timeline chart** — also v0-deferred. Bars only.
- **Charter mutation** — strictly read-only. If your finding implies a charter edit, do it surgically per `/delta-minimizer`'s charter-edit rules.

## Finding discipline (mirrors /delta-minimizer)

- **One primary finding.** Two max if you can prove different root causes.
- **% confidence mandatory.** ≥85% needs code-path read + decision-count verification. Don't write findings under 60%.
- **Cite file:line** for any algorithmic claim.
- **Sample-size honesty.** Decisions < 50 or resolved markets < 3 → 🟡; finding must acknowledge the floor. "Insufficient sample, re-run after N hours" is a valid finding.
- **Charter class.** Pick from `work/charters/POLY_COPY_DELTA.md` D1–D8, or set `primary_class: null` with reason. Do not invent a new D-row without explicit user approval in-turn.

## Meta loop — improving the matrix itself

Each invocation is also an opportunity to ask "is the matrix or the tool the bottleneck?" Capture these in the finding's secondary slot or as a follow-up `bug.*` / `task.*` via the poly work-items API:

- **Data-analysis efficiency:** decisions query slow / OOM-risk over wide windows → file a `data-research`-skill task to migrate to SQL-only aggregation per the bug.5012 pattern. Don't band-aid with `LIMIT`.
- **Algorithm tuning:** if the matrix surfaces a stable signal (e.g. swiss-gap consistently under-fills minority side by X%), the next move is a planner change in `plan-mirror.ts` or `copy-trade-mirror.job.ts` — propose the smallest concrete edit, link the report.
- **Matrix gaps:** charter lists a row but the env has no key, or the env has a key but the charter has no row → file a charter follow-up. Do not paper over with hard-coded fallbacks.

## Pointers

- Tool: `scripts/tenant-matrix-evaluator.ts`
- Spec: `docs/spec/poly-tenant-matrix-evaluator.md`
- Charter: `work/charters/POLY_ALGO_TENANT_MATRIX.md`
- Output dir: `research/tenant-matrix/<iso>/`
- Sibling skills: [`/delta-minimizer`](../delta-minimizer/SKILL.md), [`/paper-trade-diff-analysis`](../paper-trade-diff-analysis/SKILL.md)
- Planner cheat-sheet: `app/src/features/copy-trade/plan-mirror.ts`
- Postgres helper: `scripts/grafana-postgres-query.sh` (matches the tool's per-env datasource UID convention `cogni-<env>-poly-postgres`)

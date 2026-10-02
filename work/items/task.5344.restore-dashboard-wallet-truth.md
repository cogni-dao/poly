---
id: task.5344
type: task
title: Restore trading-wallet positions value and P/L truth
status: in_progress
actor: ai
priority: 1
rank: 15
estimate: 3
summary: "Fix the signer-EOA versus funder-wallet identity split, then prove open positions, wallet total, execution live count, and P/L against independent ground truth."
outcome: "For each V2 tenant wallet, observation and every dashboard read use funder_address ?? address; missing read-model data is explicit and can never appear as zero positions or a cash-only Total."
spec_refs:
  - docs/porting/poly-port-policy.json
  - app/src/features/wallet-analysis/server/trader-observation-service.ts
  - app/src/features/wallet-analysis/server/current-position-read-model.ts
  - app/src/app/api/v1/poly/wallet/overview/route.ts
  - app/src/app/api/v1/poly/wallet/execution/route.ts
assignees: []
credit: null
project: null
parent: story.5000
branch: derekg1729/overnight-trading-loss-audit
pr: 109
reviewer: null
revision: 0
blocked_by: null
deploy_verified: false
created: 2026-10-02
updated: 2026-10-02
labels:
  - parity
  - dashboard
  - wallet-analysis
  - blocker
external_refs:
  - "commit:66a4ce549a1b13fdd6719684275a116526b54a42"
node: poly
---

# Restore trading-wallet positions value and P/L truth

Before: production observes the Privy signer EOA, while balance/position routes ask for the actual Polymarket funder wallet. The read model therefore reports the wallet as missing. The overview then presents cash alone as `Total`, and the UI reports no positions despite real holdings.

After: the observer and all readers share one canonical address resolver: `funder_address ?? address`. Stale signer-only observer rows are retired safely. A missing/lagging position snapshot yields an explicit unavailable state, never numeric zero and never a cash-only total labeled as total.

Owns: wallet observation enrollment, current-position/P&L identity resolution, overview/execution response semantics, focused tests, and deployed proof.

Do not touch: mirror sizing, cash-reserve gates, order placement, work-item APIs, or the port-ledger generator.

Active checkpoint: PR #109 at `derekg1729/overnight-trading-loss-audit@a5f85ca` centralizes trading-address resolution in the wallet port and fixes observer enrollment with focused coverage. Review/extend that branch rather than duplicating its files.

Acceptance audit: address resolution is necessary but not sufficient. `task.5346` is implemented in stacked PR #110 at `da738a8`: unknown totals, missing P/L, and false zero-position UI states.

Gate: on candidate, the dashboard and its overview/execution APIs for `0x8ca45685c5827f7ACFdd890214180C4EA9d0Bf58` must match a timestamped independent Polygon/Polymarket oracle for free cash, open-position count, position mark-to-market, and total within a documented tolerance. P/L must distinguish unavailable from true zero. Capture API output and a screenshot before production promotion.

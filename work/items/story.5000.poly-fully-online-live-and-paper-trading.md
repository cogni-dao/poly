---
id: story.5000
type: story
title: Prove P0/P1 legacy parity end to end
status: needs_implement
actor: either
priority: 1
rank: 1
estimate: 21
summary: "Resolve and prove every P0/P1 legacy divergence without disrupting live trading; exact, upgraded, or retired only."
outcome: |-
  done =
  1. All 28 P0 and 51 P1 legacy files resolve as exact, upgraded, or retired with pinned hashes, file modes, rationale, behavior expectation, and proof references.
  2. Hub, dashboard, wallet, trading, provider, and research behaviors are observable end to end; unavailable or stale data never collapses to false zero.
  3. Candidate proves exact-SHA deployability, contracts, failure semantics, UI, and feature-specific logs; production proves the existing user/algo path through passive observation.
  4. The deterministic scanner rejects missing, unresolved, duplicate, orphaned, or stale approvals and emits the complete file table; P2/P3 remain visibly queued.
  5. No funding, strategy/config, or manual-order changes. This definition of done is immutable and may not be weakened.
spec_refs:
  - docs/porting/poly-port-policy.json
  - docs/porting/poly-port-inventory.json
  - https://github.com/cogni-dao/poly/pull/114
assignees: []
credit: null
project: null
branch: null
pr: null
reviewer: null
revision: 1
blocked_by: null
deploy_verified: false
created: 2026-06-28
updated: 2026-10-02
labels:
  - parity
  - dev-manager
  - dashboard
  - trading
  - p0
  - p1
external_refs: null
node: poly
---

# Prove P0/P1 legacy parity end to end

The outcome above mirrors the canonical Hub story and is immutable. The scanner pins every legacy source path and keeps P2/P3 visible, but this delivery closes the 28 P0 and 51 P1 divergences first.

## Pareto delivery ladder

1. **Hub control-plane proof:** prove the eight P0 paths delivered by merged PRs #111 and #114 through create, patch, claim/heartbeat, read/UI, delete, and restart persistence. This is a proof and classification step, not another product-code PR.
2. **Parity scanner v2:** enforce the immutable contract, complete inventory, delivery-group ownership, structured resolution evidence, and P0/P1 completion gate.
3. **Saved-read reliability (PR #113):** own only `trading-wallet-overview-service.ts`, `wallet-analysis-service.ts`, and their focused tests. The observer and current-position read model already delivered by PR #110 are evidence classifications, not edits in PR #113.
4. **Dashboard behavior closure:** resolve the two PR #110 files using fresh evidence, then prove the wallet APIs, hooks, cards, and contracts without presenting unavailable or stale data as zero.
5. **Visible P0 parity:** restore or explicitly upgrade the remaining dashboard, wallet-analysis, credits, and layout surfaces with authenticated desktop and mobile evidence.
6. **P1 provider foundation:** resolve the market-provider package and adapters plus its assigned configuration and contract-index files.
7. **P1 execution and wallet:** resolve copy-trade, sync, wallet, executor, ledger, schema, and chain-source paths without changing live strategy or funding.
8. **P1 research and reads:** resolve research routes and analysis services using bounded saved-fact reads and explicit partial-failure warnings.
9. **Closure:** require all 79 P0/P1 rows to be terminal with current proofs while P2/P3 remain visibly queued.

## Proof boundary

Candidate proves the asserted build SHA, startup/readiness, contracts, failure semantics, authenticated UI behavior, and feature-specific logs. Production proves the promoted SHA and the existing user's wallet/algo flow through passive API, UI, oracle, and log observation. Production proof must not fund a wallet, alter strategy/configuration, or place a manual order. If natural activity has not exercised a required path, the evidence remains incomplete rather than weakening the success criterion.

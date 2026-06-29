---
id: task.5009
type: task
title: Restore Poly research visible shell
status: in_progress
actor: ai
priority: 1
rank: 55
estimate: 2
summary: "Restore the authenticated /research route family, Poly shell identity, and sidebar navigation so candidate-a has a visible Poly research surface backed by the read-only runtime APIs."
outcome: "Candidate-a shows a Poly Research page with runtime/wallet/target status, wallet search, leaderboard empty state, and per-wallet drill-in route at the deployed PR SHA."
spec_refs:
  - app/src/app/(app)/research/page.tsx
  - app/src/app/(app)/research/view.tsx
  - app/src/app/(app)/research/w/[addr]/page.tsx
  - app/src/features/layout/components/AppSidebar.tsx
assignees:
  - codex
credit: null
project: null
parent: task.5006
branch: agent/task-5006-poly-visible-parity
pr: null
reviewer: null
revision: 0
blocked_by: task.5008
deploy_verified: false
created: 2026-06-29
updated: 2026-06-29
labels:
  - poly-launch
  - ui
  - research
  - candidate
external_refs: null
node: poly
---

# Restore Poly research visible shell

First visible parity slice after the read-only Poly runtime routes. This does not claim DB-backed research data, full wallet-analysis parity, graphs, live trading, or paper trading.

Gate: typecheck, PR CI, candidate-a flight, browser smoke for `/research` and `/research/w/<addr>`.

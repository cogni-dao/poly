---
id: task.5007
type: task
title: Restore selective data then enable paper trading last
status: needs_design
actor: ai
priority: 1
rank: 70
estimate: 8
summary: "After non-paper app parity, selectively restore owner trade history, copy targets, fills/decisions, wallet grants/connections, and market metadata; then port sidecars/paper-trader with candidate/preview-only gates."
outcome: "Forward-looking app data is restored safely, paper trading runs in candidate/preview only, and production remains live-only with no paper environment."
spec_refs:
  - .context/db-restore/RESULTS.md
  - sidecars/paper-trader
assignees: []
credit: null
project: null
parent: story.5000
branch: null
pr: null
reviewer: null
revision: 0
blocked_by: task.5006
deploy_verified: false
created: 2026-06-28
updated: 2026-06-28
labels:
  - poly-launch
  - data-restore
  - paper-trading
external_refs: null
node: poly
---

# Restore selective data then enable paper trading last

Owns: data restore runbook/artifacts and `nodes/poly/sidecars/paper-trader` port after parity.

Do not touch: production paper env, operator infra unless separately authorized and only after node PRs prove need, live trading behavior from previous tasks.

Shared seam: depends on candidate-proven app parity and stable schema.

Gate: target DB snapshot, writer stop plan, row-count evidence, paper sidecar image build/publish, candidate/preview-only enablement, and production live-only verification.

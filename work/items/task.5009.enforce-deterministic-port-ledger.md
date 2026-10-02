---
id: task.5009
type: task
title: Enforce deterministic file and behavioral parity ledger
status: in_progress
actor: ai
priority: 1
rank: 5
estimate: 3
summary: "Maintain the pinned one-to-one legacy file map, deterministic port queue, and explicit runtime behavior gates for accepted adaptations."
outcome: "No source file or user-visible semantic divergence can be called ported without exact bytes or a reviewed, reproducible proof record."
spec_refs:
  - docs/porting/poly-port-policy.json
  - docs/porting/poly-port-inventory.json
  - docs/porting/poly-port-inventory.md
  - scripts/poly-port-inventory.mjs
assignees: []
credit: null
project: null
parent: story.5000
branch: derekg1729/poly-port-inventory
pr: 108
reviewer: null
revision: 0
blocked_by: null
deploy_verified: false
created: 2026-10-02
updated: 2026-10-02
labels:
  - parity
  - inventory
  - dev-manager
external_refs: null
node: poly
---

# Enforce deterministic file and behavioral parity ledger

Owns: `docs/porting/**`, `scripts/poly-port-inventory.mjs`, package-script wiring for the ledger, and manager status in `work/items/**` while the hub command plane is unavailable.

Do not touch: application product code, migrations, trading execution, or the active dashboard-fix branch.

Gate: every file at the pinned legacy commit has one deterministic target and state; stale approvals fail closed; queue ordering is deterministic; P0 behavior gates cover dashboard wallet identity/positions/total/P&L and hub Dolt CRUD. The generated report and JSON agree with the current worktree. No full repository check is permitted for this checkpoint per user instruction.

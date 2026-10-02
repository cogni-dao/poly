---
id: story.5000
type: story
title: Restore strict legacy-to-node Poly product parity
status: in_progress
actor: either
priority: 1
rank: 10
estimate: 21
summary: "Held vision: deterministically account for every legacy Poly file and prove user-visible behavior against legacy plus independent ground truth, allowing only explicit hash-pinned improvements."
outcome: "Every legacy source file is exact, explicitly adapted, or explicitly retired; all P0 behavioral gates pass on candidate and production, including trading-wallet positions/value/P&L and Dolt-backed work-item CRUD."
spec_refs:
  - .context/attachments/8nwVYX/pasted_text_2026-06-28_00-46-56.txt
  - docs/spec/node-ci-cd-contract.md
assignees: []
credit: null
project: null
branch: null
pr: null
reviewer: null
revision: 0
blocked_by: null
deploy_verified: false
created: 2026-06-28
updated: 2026-10-02
labels:
  - poly-launch
  - port
  - trading
  - paper-trading
  - dev-manager
  - parity
external_refs: null
node: poly
---

# Restore strict legacy-to-node Poly product parity

This is the canonical story for the legacy-to-node port. Source is pinned by commit and every source path maps to one current path in `docs/porting/poly-port-inventory.json`. A difference is unfinished until it is either ported exactly or recorded as a hash-pinned adaptation/retirement with proof.

File parity alone is not completion. The behavioral gates in `docs/porting/poly-port-policy.json` are mandatory and currently put dashboard wallet truth and hub work-item persistence first. Candidate proof must compare the deployed dashboard with an independent Polygon/Polymarket oracle for the same funder wallet. Paper trading remains last.

While deployed hub writes are unavailable, the dev manager may maintain these repository Markdown items as an explicitly authorized temporary fallback. They must be recreated/imported into the Dolt-backed hub when `task.5001` passes; runtime Markdown is not the target architecture.

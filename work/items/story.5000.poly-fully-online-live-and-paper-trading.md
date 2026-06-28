---
id: story.5000
type: story
title: Poly is fully online with live trading restored and paper trading safely gated
status: needs_design
actor: either
priority: 1
rank: 10
estimate: 21
summary: "Held vision: port the real legacy Poly product into the new node repo without rewriting it; restore schema, packages, runtime APIs/jobs, UI/graphs, selective data, and paper trading in dependency order."
outcome: "Poly production stays healthy, live trading paths work, candidate/preview prove app parity, and paper trading runs only after non-paper parity with clear environment gates."
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
updated: 2026-06-28
labels:
  - poly-launch
  - port
  - trading
  - paper-trading
  - dev-manager
external_refs: null
node: poly
---

# Poly is fully online with live trading restored and paper trading safely gated

This is a port, not a rewrite. Source-traceable slices come from `/Users/derek/conductor/workspaces/cogni-poly/louisville/nodes/poly`; the new node repo keeps its spawned platform surfaces: repo spec, cognition bootstrap, admin/EDO/knowledge wiring, deploy contract, and Dolt remote.

Paper trading is last. It is enabled only after non-paper app parity has passed candidate proof, and it remains candidate/preview-only unless explicitly approved.

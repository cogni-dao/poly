---
id: task.5006
type: task
title: Port Poly UI graphs and candidate proof loop
status: needs_design
actor: ai
priority: 1
rank: 60
estimate: 5
summary: "Port dashboard tables/controls, credits/trading wallet components, research routes, graph catalog/tests, then flight candidate and prove UI/API behavior at the deployed PR SHA."
outcome: "Candidate shows real Poly product surfaces, key pages match legacy intent, /version and /readyz are verified, smoke checks pass, and /validate-candidate scorecard is posted."
spec_refs:
  - app/src/features/AGENTS.md
  - graphs/package.json
  - docs/guides/candidate-auth-bootstrap.md
assignees: []
credit: null
project: null
parent: story.5000
branch: null
pr: null
reviewer: null
revision: 0
blocked_by: task.5005
deploy_verified: false
created: 2026-06-28
updated: 2026-06-28
labels:
  - poly-launch
  - ui
  - graphs
  - candidate
external_refs: null
node: poly
---

# Port Poly UI graphs and candidate proof loop

Owns: Poly UI routes/components, graph catalog/tests, candidate smoke proof artifacts.

Do not touch: migrations, package internals except API type consumption, server trading logic except client-facing contract fixes, operator infra.

Shared seam: consumes task.5005 APIs and posts live proof.

Gate: screenshot comparison against legacy, CI green, candidate flight, `/version.buildSha`, `/readyz`, at least one feature route, Loki request evidence, and `/validate-candidate`.

## PR / Links

- Handoff: [handoff](../handoffs/task.5006.handoff.md)

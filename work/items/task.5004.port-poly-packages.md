---
id: task.5004
type: task
title: Port Poly domain packages from legacy
status: needs_design
actor: ai
priority: 1
rank: 40
estimate: 5
summary: "Port @cogni/poly-market-provider, poly-wallet, poly-node-contracts, poly-ai-tools, poly-knowledge, and poly-doltgres-schema source-traceably while preserving spawned shared packages unless proven unused."
outcome: "The node repo has the legacy Poly package surface needed by runtime, APIs, UI, graphs, and trading flows, with builds/tests passing and no broad identity-damaging search replace."
spec_refs:
  - package.json
  - packages/*/AGENTS.md
assignees: []
credit: null
project: null
parent: story.5000
branch: null
pr: null
reviewer: null
revision: 0
blocked_by: task.5002
deploy_verified: false
created: 2026-06-28
updated: 2026-06-28
labels:
  - poly-launch
  - packages
external_refs: null
node: poly
---

# Port Poly domain packages from legacy

Owns: new/ported Poly package directories, workspace dependency entries, lockfile changes required by those packages.

Do not touch: app runtime routes/features except minimal compile integration, schema migration history, UI pages, operator infra.

Shared seam: package exports must be stable for runtime/API and UI/graph tasks.

Gate: package builds/tests, dependency-cruiser/typecheck where applicable, and no `any` expansion beyond source-preserved legacy code with explicit notes.

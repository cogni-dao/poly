---
id: task.5001
type: task
title: Restore node work-item write and coordination endpoints
status: needs_closeout
actor: ai
priority: 1
rank: 10
estimate: 3
summary: "Before agents can coordinate through the hub, POST/PATCH/claim/heartbeat/link endpoints must work on https://poly.cognidao.org/api/v1/work/items. Current evidence: GET works; POST returns HTTP 405 on 2026-06-28."
outcome: "Local implementation complete: POST/PATCH, claim/release, heartbeat, and coordination read endpoints are implemented with focused tests. Needs PR, CI, candidate flight, and live hub verification before marking done."
spec_refs:
  - packages/node-contracts/src/work.items.create.v1.contract.ts
  - packages/node-contracts/src/work.items.patch.v1.contract.ts
  - app/src/app/api/v1/work/items/route.ts
  - app/src/app/api/v1/work/items/[id]/route.ts
assignees: []
credit: null
project: null
parent: story.5000
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
  - coordination
  - blocker
external_refs: null
node: poly
---

# Restore node work-item write and coordination endpoints

Owns: work-item HTTP routes, facades, contracts, and tests.

Do not touch: legacy Poly product port files, db migration history, trading features, operator infra.

Gate: authenticated curl can create a story, create a child task, patch status/summary, claim/heartbeat/link a PR, and read coordination state from the live Poly node.

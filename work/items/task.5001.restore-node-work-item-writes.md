---
id: task.5001
type: task
title: Restore node work-item write and coordination endpoints
status: needs_implement
actor: ai
priority: 1
rank: 10
estimate: 3
summary: "Before agents can coordinate through the hub, POST/PATCH/claim/heartbeat/link endpoints must work on https://poly.cognidao.org/api/v1/work/items. Current evidence: production GET works and pre-PR POST returned HTTP 405 on 2026-06-28; candidate-a at 670d6ad authenticated with a candidate-issued agent key but POST returned HTTP 500 because the runtime image did not ship/writable-mount work/items."
outcome: "Local routes/facades/tests are implemented, and candidate-a proved build/read/auth at 670d6ad. Follow-up in this task: ship work/items into the runner image, chown /app/work for the non-root runtime, re-flight candidate-a, and prove create/patch/claim/heartbeat/coordination over HTTP before marking done."
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

Gate: authenticated candidate-a curl can list seeded story/task IDs, create a story, create a child task, patch status/summary, claim/heartbeat/link a PR, and read coordination state from the live Poly node. Then repeat on production after merge/promote.

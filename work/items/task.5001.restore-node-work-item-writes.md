---
id: task.5001
type: task
title: Restore node work-item write and coordination endpoints
status: needs_implement
actor: ai
priority: 1
rank: 10
estimate: 3
summary: "Restore the legacy Dolt-backed work-item command plane removed by node-template merge #32; production currently exposes GET only and returns HTTP 405 for POST."
outcome: "Authenticated create/patch/delete/claim/heartbeat/coordination use Doltgres, survive a pod restart, and never depend on a writable runtime Markdown directory."
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
updated: 2026-10-02
labels:
  - poly-launch
  - coordination
  - blocker
external_refs: null
node: poly
---

# Restore node work-item write and coordination endpoints

Owns: work-item HTTP routes, facade, Doltgres adapter/port/container wiring, contracts, and tests.

Do not touch: legacy Poly product port files, db migration history, trading features, operator infra.

Root cause: commit `d685fc8` (`chore: merge node-template upstream (#32)`) replaced the legacy collection POST and item PATCH/DELETE seams and removed concrete Dolt adapter wiring. The current container wires `MarkdownWorkItemAdapter`; merely restoring POST would write an ephemeral runtime filesystem and does not repair the hub.

Gate: authenticated candidate curl can create a story and child task, patch status/summary, claim/heartbeat/link a PR, delete a disposable test item, and read coordination state. Direct Dolt evidence must show the same rows, and they must remain after a pod restart. Repeat on production after merge/promote. Repository Markdown is only the user-authorized temporary manager fallback.

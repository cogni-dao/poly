---
id: task.5003
type: task
title: Port legacy Poly schema and migrations without drift
status: needs_closeout
actor: ai
priority: 1
rank: 30
estimate: 5
summary: "Highest-risk port slice: preserve legacy migration history through 0058, resolve spawned template 0027/0028 conflicts by reintroducing newer template fixes as 0059+, and rehearse forward migration against restored backup state."
outcome: "Local implementation complete: legacy app migrations 0027..0058 restored, template fixes moved to 0059/0060, Poly schema slices exported, and local schema checks pass. Needs disposable/prod-clone migration rehearsal before done."
spec_refs:
  - packages/db-schema/AGENTS.md
  - packages/doltgres-schema/AGENTS.md
  - scripts/db/migrate.mjs
  - scripts/db/verify-doltgres-schema.mjs
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
  - schema
  - migrations
external_refs: null
node: poly
---

# Port legacy Poly schema and migrations without drift

Owns: `packages/db-schema`, `packages/doltgres-schema`, app migration files, and schema verification tests/scripts.

Do not touch: runtime feature code, UI, graphs, paper trader, operator infra, plaintext secrets.

Shared seam: produces typed schema exports and migration state consumed by runtime/API agents.

Gate: local migration check, restored-backup rehearsal, package build/tests, and documented no-drift evidence.

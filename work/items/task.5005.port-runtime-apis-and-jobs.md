---
id: task.5005
type: task
title: Port Poly runtime APIs jobs and trading services
status: needs_design
actor: ai
priority: 1
rank: 50
estimate: 8
summary: "Port copy-trade, redeem, trading, wallet-analysis, wallet-watch, core redeem, ports, server adapters, bootstrap capabilities, jobs, and /api/v1/poly/** routes, excluding paper sidecar route until final phase."
outcome: "Read-only research/wallet endpoints and live trading service paths work against available data; /api/v1/poly/internal/sync-health reports useful state."
spec_refs:
  - app/src/AGENTS.md
  - app/src/app/api/AGENTS.md
  - app/src/bootstrap/AGENTS.md
  - app/src/ports/AGENTS.md
assignees: []
credit: null
project: null
parent: story.5000
branch: null
pr: null
reviewer: null
revision: 0
blocked_by: task.5003
deploy_verified: false
created: 2026-06-28
updated: 2026-06-28
labels:
  - poly-launch
  - runtime
  - trading
external_refs: null
node: poly
---

# Port Poly runtime APIs jobs and trading services

Owns: `app/src/app/api/v1/poly/**`, Poly features/core/ports/server adapters/bootstrap jobs, and tests for those paths.

Do not touch: package internals except requested typed fixes, UI/graphs except API client type adjustments, schema migration history, paper-trader sidecar.

Shared seam: consumes task.5003 schema and task.5004 package exports; exposes API contract consumed by UI/graph task.

Gate: unit/component/API tests ported with code; sync-health works; live-trading paths are environment-gated and fail fast when required secret shapes are absent.

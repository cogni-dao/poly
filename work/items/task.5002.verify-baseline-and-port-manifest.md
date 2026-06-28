---
id: task.5002
type: task
title: Verify launch baseline and source-traceable port manifest
status: done
actor: ai
priority: 1
rank: 20
estimate: 2
summary: "Confirm origin/main freshness, current branch ancestry, prod/preview/candidate /readyz and /version, PR #2 homepage-port precedent, and produce the exact source-to-target port manifest for follow-on agents."
outcome: "Done 2026-06-28: branch equals origin/main at 9635d78e58455cac65dea626cc49930b341911f8; test/preview/prod readyz and version return 200 at build b53af9f9215635dadb2d2d9fae325351e3d1d200; source-to-target manifest captured by Ohm."
spec_refs:
  - .context/attachments/8nwVYX/pasted_text_2026-06-28_00-46-56.txt
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
  - baseline
external_refs: null
node: poly
---

# Verify launch baseline and source-traceable port manifest

Owns: `.context/poly-launch-baseline.md` and `.context/poly-port-agent-map.md` only.

Do not touch: app/package source, migrations, operator repo, secrets.

Gate: manifest references concrete legacy paths and target paths; health checks include exact dates, URLs, and build SHAs.

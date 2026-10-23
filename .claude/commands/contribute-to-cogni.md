---
description: Continue the bound node work item through shared hub lifecycle guidance.
---

Continue the owned work item: #$ITEM. Read root AGENTS.md and the bound node's
current item and coordination first. If no item is supplied, reuse the owned
item or select and claim one through that node's discovered work API. Work-item
and node-owned knowledge reads/writes stay on that node with its node credential.

Read the complete shared delivery guide using the saved operator account:

```bash
set -euo pipefail
set -a
source "$(git rev-parse --show-toplevel)/.env.cogni"
set +a
: "${COGNI_OPERATOR_API_KEY:?saved operator credential required}"
body=$(curl -fsS --max-time 20 --retry 1 \
  -H "Authorization: Bearer $COGNI_OPERATOR_API_KEY" \
  "https://cognidao.org/api/v1/knowledge/cicd-e2e-required-sequence")
printf '%s\n' "$body" | jq -er '.content | select(type == "string" and length > 0)'
```

| status | invoke |
| --- | --- |
| needs_triage | /triage |
| needs_research | /research |
| needs_design | /design, then /review-design |
| needs_implement | /implement |
| needs_merge | /review-implementation |
| needs_closeout | /closeout |

Read the chosen command's hub procedure and every required dependency in full.
Never forward the sovereign node bearer to operator guidance. A failed source,
credential or body stops the stage: record and repair the retrieval gate before
acting. Do not reconstruct it from an index or retired repository procedure.

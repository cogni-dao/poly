---
description: Decide whether and how to preserve reusable node knowledge.
---

Read the node-template-owned [knowledge-contribution-flow](https://node-template.cognidao.org/knowledge/knowledge-contribution-flow) with your saved node-template key (on node-template itself, `COGNI_NODE_API_KEY`):

```bash
set -o pipefail
: "${COGNI_NODE_TEMPLATE_API_KEY:=${COGNI_NODE_API_KEY:-}}"
: "${COGNI_NODE_TEMPLATE_API_KEY:?Load your saved node-template Cogni API key}"
curl -fsS --max-time 30 \
  -H "Authorization: Bearer $COGNI_NODE_TEMPLATE_API_KEY" \
  https://node-template.cognidao.org/api/v1/knowledge/knowledge-contribution-flow \
  | jq -er '.content | select(type == "string" and length > 0)'
```

Read `content`; stop if the fetch fails and report it. Prefer silence or refinement over a new entry. Never include secret values or private user data.

---
description: Add a node-owned secret declaration and typed code consumption.
---

Read the operator-owned [node-self-serve-secrets](https://cognidao.org/knowledge/node-self-serve-secrets) guide with your saved operator-issued key, then implement only the node-repo half it describes:

```bash
set -o pipefail
: "${COGNI_OPERATOR_NODE_API_KEY:?Load your saved operator Cogni API key}"
curl -fsS --max-time 30 \
  -H "Authorization: Bearer $COGNI_OPERATOR_NODE_API_KEY" \
  https://cognidao.org/api/v1/knowledge/node-self-serve-secrets \
  | jq -er '.content | select(type == "string" and length > 0)'
```

Read `content`; stop if the fetch fails and report it. Never write a secret value, and never edit operator deploy overlays, pod specs, or ExternalSecret resources.

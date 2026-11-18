---
name: contribute-knowledge-to-cogni
description: Contribute durable knowledge to a Cogni node hub. Use when context may compound beyond this session and must pass the syntropy bar, route to the right domain, and enter a reviewed contribution inbox.
---

# contribute-knowledge-to-cogni

This file is only the trigger. The node-template hub hosts the authoritative, refinable method.

Read these node-template-owned entries with `COGNI_NODE_TEMPLATE_API_KEY` (on node-template itself, `COGNI_NODE_API_KEY`), then follow them:
- `GET https://node-template.cognidao.org/api/v1/knowledge/knowledge-contribution-flow`
- `GET https://node-template.cognidao.org/api/v1/knowledge/knowledge-syntropy-protocol`

No key yet? Register once with `POST https://node-template.cognidao.org/api/v1/agent/register` and `{"name":"<agent name>"}`, then save the key in the gitignored `.env.cogni`.

Contribute to this node's own hub with its `COGNI_NODE_API_KEY`: list its shelves with `GET /api/v1/knowledge/domains`, then write through `/api/v1/knowledge/contributions`. Improve the shared method itself through an inbox on the node-template hub.

Do not reconstruct or preserve a fallback copy in this repository.

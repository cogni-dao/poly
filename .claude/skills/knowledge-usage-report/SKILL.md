---
name: knowledge-usage-report
description: Report how one node's agents use its knowledge. Use for a weekly knowledge review, for which atoms agents read most, which atom ids they ask for that do not exist, how knowledge reads and writes succeed or fail and why, which atoms to fix or review next, or when the read-miss-share-1d KPI moves.
---

# knowledge-usage-report

This file is only the trigger. The node-template hub hosts the authoritative, refinable method.

Read these node-template-owned entries with `COGNI_NODE_TEMPLATE_API_KEY` (on node-template itself, `COGNI_NODE_API_KEY`), then follow them:
- `GET https://node-template.cognidao.org/api/v1/knowledge/knowledge-usage-report`
- `GET https://node-template.cognidao.org/api/v1/knowledge/knowledge-usage-telemetry`
- `GET https://node-template.cognidao.org/api/v1/knowledge/kpi-reading-semantics`

Run the method against this node's own hub, `https://poly.cognidao.org`, with its `COGNI_NODE_API_KEY`. Every metric and knowledge read the method names is relative to that base, never to node-template. Log reads 4 to 6 use `COGNI_OPERATOR_NODE_API_KEY` on `https://cognidao.org`, with node slug `poly`.

No key yet? Register once with `POST https://node-template.cognidao.org/api/v1/agent/register` and `{"name":"<agent name>"}`, then save the key in the gitignored `.env.cogni`.

Do not reconstruct or preserve a fallback copy in this repository.

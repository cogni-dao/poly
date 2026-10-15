---
name: dolt-human-visuals
description: Use when authoring a Cogni knowledge entry whose primary consumer is a HUMAN reviewing it visually (design diagram, scorecard, roadmap, status surface, PR-review summary). Routes you to entryType html instead of text-heavy prose. Trigger when a /design run produces its human-facing design, or when posting to /api/v1/knowledge/contributions for human review.
---

# dolt-human-visuals

This file is only the trigger. The knowledge hub is the authoritative, refinable contract.

Read this operator-owned entry with the separate `COGNI_OPERATOR_NODE_API_KEY`, then follow it:
- `GET https://cognidao.org/api/v1/knowledge/knowledge-human-visuals`

Do not reconstruct or preserve a fallback copy in this repository.

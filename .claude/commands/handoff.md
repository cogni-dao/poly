It's time to hand this project off to a new developer. Assume they have no context of the task you've been working on, but avoid over-prescribing implementation details. Focus on the mission, goals, functional requirements, validation proof, and pointers to documentation + important files + functions.

Persist the handoff into the dolt work item — not a repo file (`work/handoffs/` is retired). First make dolt accurate, then emit the copy/paste block below.

- `PATCH /api/v1/work/items/{id}` with `{set:{...}}`:
  - `outcome` = **Goal** + **E2E validation** + **Design / Implementation Target** + **Next Actions** as an ordered checklist — each rung marked proven (with evidence link) or pending. This is the next developer's plan.
  - `summary` = **Mission/Pickup** + **Current State** facts: branch, PRs, what is done, what is blocked, wrong turns already ruled out. Rewrite in place, don't append.
- If a hub design/knowledge entry was sharpened or disproven this session, refine it in place via your open contribution.

Rules:

- High signal, low noise; no pasted logs/transcripts
- Link to files/commits/PRs instead of copying code
- Use "New mission:" only when this is truly new work; otherwise use "Mission:" or "Pickup:" and state what the next developer owns now.
- **Goal** describes the desired end state and includes the clear E2E validation signal. If deploy behavior is in scope, explicitly say what candidate-a flight proof looks like, including the expected URL, `/version` field, SHA/ref match, workflow, or promoted lane evidence.
- **Design / Implementation Target** is numbered requirements, outcome-oriented: what must be true, what must not regress, and what boundaries must hold.

Example tone and structure (for the work item's `outcome`):

```text
Goal:
Node-template/resy/canary must not inherit operator lifecycle graphs. Operator owns PR Manager, GitHub lifecycle, deploy orchestration, and VCS-backed agent flows. Spawned node repos should have their own node-safe graph bundle at repo root and receive graph/template updates over time via fork/template pulls, not by sharing operator graph catalog discovery.

E2E validation:
Operator can still discover and run PR Manager. node-template/resy/canary cannot discover or route to PR Manager/operator lifecycle graphs. If this work changes deploy behavior, candidate-a proof must show the relevant workflow run, deployed lane URL, and `/version` SHA/ref match.

Design / implementation target:
1. Split graph discovery by runtime.
2. Add tests proving operator graph availability and node runtime graph absence.
3. Keep scope to graph/package isolation.
```

## Final output to the user

End with a fenced block the incoming developer can paste or read cold — no prose summary above it, no decorative headings. The block is the handoff. Include, in this order:

1. **Worktree** — absolute path (`pwd` output).
2. **Branch** — current branch (`git branch --show-current`) and upstream (`git rev-parse --abbrev-ref @{u}` if it exists).
3. **Pointers** — the primary briefing, each with a one-line why: the work item URL (`https://poly.cognidao.org/api/v1/work/items/{id}` — the plan is `outcome`), every open inbox contribution they must read (`https://poly.cognidao.org/knowledge/inbox/{contributionId}`), and the 2–3 critical docs/skills/files.
4. **Immediate next action** — always of the shape: _"Read the work item + <supporting docs>, then <the first concrete thing to do>, and from there you are in charge."_ The work item is the primary briefing; the next-action line is the bridge from "read the briefing" into "you own this now." If the immediate next action is blocked by something only a human can resolve (missing auth, revoked access, decision the agent cannot make), say what is blocking and who unblocks — do not hand the loop to the next agent only to have them bounce.

This is the high-leverage surface of the handoff — the incoming agent should know where they are, what the primary briefing is, and what to do within the first 10 seconds.

ARGUMENTS: $ARGUMENTS

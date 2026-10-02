It's time to hand this work off to a new agent. They arrive with ZERO chat context but WITH the auto-delivered orientation — so never restate the contract, the north star, or generic process. Hand off only what this session knows that the substrate doesn't yet.

**The handoff is not a document. It is (1) dolt brought current + (2) one copy/paste block.** A handoff that lives in a repo file or chat transcript is lost; `work/handoffs/` is retired — never write there.

## Step 1 — persist to dolt FIRST (progress only counts once persisted)

1. **Work item is the briefing.** `PATCH /api/v1/work/items/{id}`:
   - `outcome` = the ordered `done =` checklist, current: each rung marked proven (with its live evidence — URL, sha, log line) or pending. The next agent's plan IS this list.
   - `summary` = highest-signal state only: branch, PR, the one blocker, the wrong turns already ruled out (so they aren't repeated). High signal, low noise — delete stale text, don't append.
   - Link the PR. If the claim lease will expire, say so in `summary`.
2. **Designs, if cleanly applicable.** A design/knowledge entry this session proved wrong or sharpened → refine it in place via your open contribution (refine > new). Do NOT dump session narrative into the hub; only what clears the syntropy bar.
3. **Uncommitted evidence dies with you.** Findings that exist only in chat → into `outcome`/`summary`/contribution now, before writing the block.

## Step 2 — the copy/paste block (the ONLY user-facing output)

End with exactly one fenced block, ≤25 lines, nothing above or below it. No decorative headings, no prose summary. Shape:

```text
🎯 <e2e goal, ≤12 words — identical to the work item's>
done = <the measurable live proof>

state: <branch> · <PR #N + CI/flight status> · worktree <abs path>
Δ this session: <2-3 terse lines: proven rungs · ruled-out paths · the one blocker + who unblocks>

read first, in order:
1. work item: <https://poly.cognidao.org/api/v1/work/items/{id}>        — your plan lives in `outcome`
2. inbox: <https://poly.cognidao.org/knowledge/inbox/{contributionId}>  — open branch: <one-line what/why>
3. hub entry: <id + URL>                                                — <one-line why it matters here>
4. repo skill: <name>                                                   — <one-line why>

first action: <ONE concrete command/step bridging reading → owning>. From there you're in charge — `outcome` is the success criterion.
```

Rules:
- Enumerate EVERY open inbox contribution and work item the next agent must read — a pointer they don't get is work they redo.
- List only skills/entries load-bearing for THIS task (the orientation already routes everything else).
- `first action` must be executable cold. If it's human-blocked (grant, merge, decision), say what blocks and who unblocks — never hand off a bounce.
- Brevity is the contract: every line the next agent must read costs them context budget. When in doubt, move detail into the work item's `outcome` and point at it.

ARGUMENTS: $ARGUMENTS

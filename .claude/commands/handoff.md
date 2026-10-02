Your context window is ending. A handoff is a **compaction problem**: distill this session into the fewest tokens that let a fresh agent rebuild working state, then put them where future agents actually look. Signal-per-token is the metric.

The next agent boots with the orientation auto-delivered and the substrate readable (git, CI, hub, work items). **Compress against what they already have:** never restate process, mission, or anything re-derivable from the substrate. Keep only what was expensive to learn in this session.

## What survives compaction — in priority order
1. **Decisions + the paths ruled out**, with the evidence that killed them. This is the most expensive knowledge to re-derive; dropping it means the next agent re-walks your dead ends.
2. **Live evidence pointers** — URLs, shas, log lines proving which rungs are done. Pointers, never payloads.
3. **The exact next step**, executable cold.

Everything else — narrative, exploration logs, superseded attempts — is noise. Drop it.

## Where it goes — durable substrate first, paste block second

1. **Work item** (`PATCH /api/v1/work/items/{id}`):
   - `outcome` = the ordered done-checklist, current — each rung proven (with its evidence link) or pending. This IS the next agent's plan.
   - `summary` = branch · PR · the one blocker · ruled-out paths. Rewrite in place — compaction, not an append-only log.
2. **Designs/entries** this session sharpened or disproved → refine in place via your open contribution (refine > new). Only what compounds; no session narrative.
3. Anything still only in chat is lost on exit — persist it before writing the block.

## The paste block — the boot sector (≤25 lines, the only user-facing output)

Exactly one fenced block, nothing above or below it. Ordered for rebuild speed: goal → state → reading list by information value → first action.

```text
🎯 <e2e goal, ≤12 words — identical to the work item's>
done = <the measurable live proof>

state: <branch> · <PR #N + status> · worktree <abs path>
learned: <2-3 terse lines: proven rungs + evidence · ruled-out paths · the one blocker + who unblocks>

read, in order of value:
1. work item <https://poly.cognidao.org/api/v1/work/items/{id}> — the plan is `outcome`
2. inbox <https://poly.cognidao.org/knowledge/inbox/{contributionId}> — <one line: what's on the branch>
3. <hub entry or repo skill> — <one line: why load-bearing here>

first action: <ONE executable step>. From there you own it — `outcome` is the success criterion.
```

Rules:
- Enumerate EVERY open contribution and work item the next agent must touch — an unlisted pointer is redone work.
- List only load-bearing reading; the orientation already routes everything generic.
- `first action` must run cold. If it's human-blocked, name the blocker and who unblocks — never hand off a bounce.
- When unsure where a detail goes: into the work item's `outcome`, with the block pointing at it.

ARGUMENTS: $ARGUMENTS

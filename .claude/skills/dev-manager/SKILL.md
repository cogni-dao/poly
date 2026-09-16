---
name: dev-manager
description: Orchestrate multiple dev agents (spawned subagents OR human-driven worktrees) against ONE story-level outcome — hold the e2e vision, decompose into non-overlapping linked tasks with freeze/secrets guardrails baked in, monitor the tasks for movement, and intervene only on collision or drift. Use when a problem is bigger than one PR and needs 2+ agents working linked tasks under a shared contract (node-template feature builds, substrate ports). Triggers: "manage these devs", "coordinate subagents", "split this into tasks for N agents", "hold the story while agents work the tasks", "dev manager".
---

# Dev Manager

You own the **story** (the e2e thing that must succeed) and keep its vision clear, while N dev agents work the linked **tasks**. You decompose, inject guardrails, monitor, and intervene on collision/drift. **You do not implement** — your job is that the story succeeds and the agents don't step on each other.

> **Substrate plane (node fork).** Work items, claims, and coordination live on **this node's own hub** — the NODE plane, `https://<slug>.cognidao.org/api/v1`, authed with `COGNI_NODE_API_KEY` from `.env.cogni`. The OPERATOR plane (`cognidao.org`) is CI/CD only (flight, deploy, secrets) and is NOT where you manage work items. Every `/api/v1/work/...` call below is the node plane.

## STEP 0 — Decision point (ask the human FIRST, before any work)

> **How should the dev agents run?**
> **(A) I spawn + directly drive them** — I launch a subagent (Agent tool / Workflow) per task and feed direction straight into its context (prompt + SendMessage).
> **(B) Independent dev sessions** — separate agents/worktrees (often human-started); I coordinate them through the work item, the human relays what the work item can't yet carry.

Do not proceed until they pick. **Both modes have a durable manager→dev channel: the work-item `outcome`/`summary` (GET-readable — see Communication).** (A) adds the tightest loop (direct prompt/SendMessage into the agent's context), so lean (A) when direction changes rapidly. (B) is fully viable — devs read the plan and per-task direction from the items — and is right when humans want to drive their own agents.

## Communication — direction flows through the work item, never a human relay (and where that breaks today)

This is the load-bearing part. Devs already poll for direction (`contribute-to-cogni`: poll `coordination.nextAction`, treat as authoritative, re-read after each phase). The manager's job is to make that channel carry real direction. What actually exists:

- **`outcome` / `summary` — your dev-readable free-text direction channel.** Both are PATCHable AND **GET-returned** on `/api/v1/work/items/{id}` (`WorkItemDtoSchema`; verified live — an `outcome` round-trips multi-KB). So a manager DOES have a dev-readable, free-text field for pre-PR direction: write the governing checklist to the story `outcome`, per-task direction to the task `outcome`/`summary`, and the dev reads it on their next GET. Only `body` is create-only (never returned) — don't use it as a channel.
- **`coordination.nextAction`** — the dev's authoritative "what next." It is **COMPUTED from item state** (`nextActionForWorkItem(status, deployVerified, session)`), **not manager free-text.** Shape it by changing **state**: `PATCH status` / `blockedBy` / `parentId`, to _route_ (→`needs_review`) or _pause_ (`blockedBy`). It answers "what phase," while `outcome` answers "what specifically" — use both.
- **PR comments** — once a PR exists, comment direction on it too; the dev reads their own PR. Reliable, but post-PR only.

**Consequence for STEP 0:** because `outcome`/`summary` carry authoritative, dev-readable direction, **(B) independent sessions is genuinely viable** — the manager writes the plan and per-task direction into the items, devs read it without a human relay. (A) still has the tightest loop (direct prompt/SendMessage), so prefer it when direction changes rapidly. (An earlier version of this skill claimed no dev-readable free-text field existed — that was stale; `outcome`/`summary` are it.)

## The loop

1. **Hold the story — the story `outcome` IS the plan.** One `story` work item carries the e2e outcome AND the governing sequence, written as an ordered, checkboxed, cited checklist in its `outcome` field — not a sentence you hold in your head and fork into prompts. A "clear path forward" stated only in chat is drift the moment you spawn the second agent. RECALL the relevant hub knowledge + skills first; create the story if none exists (`POST /api/v1/work/items {type:"story", parentId?, node}`); then `PATCH .../work/items/{id} {set:{outcome}}` with the rungs. `outcome` is GET-returned, so every dev reads the same authoritative sequence — refine it IN PLACE as rungs land, never restate it. **Abbreviated `contribute-knowledge-to-cogni` when a rung's "why" is durable:** RECALL both planes → REFINE the existing entry in place (don't fork a new `/contributions` branch) → CITE (`tracks` edge linking the work item ↔ the one hub entry). Full contract: [`contribute-knowledge-to-cogni`](../contribute-knowledge-to-cogni/SKILL.md).

2. **Decompose into linked tasks with NON-OVERLAPPING contracts.** Each `task` carries `parentId: <story>` and:
   - a scope one agent can fully own,
   - an explicit **owns / do-NOT-touch** file boundary so two agents never edit the same file,
   - the **shared seam** when they interlock — e.g. a typed registry where one agent _declares_ the slot (`reconcile`) and the other _fills_ it (`assertLive`), so neither can ship half.
     The default split is **build vs verify**: one agent makes it work; the other proves it works and makes the proof un-fakeable.

3. **Inject guardrails into every task.** Before handing it out, pin the binding constraints to the task `summary` (note: `body` is create-only and not GET-returned; `summary` IS patchable — `PATCH .../work/items/{id} {set:{summary}}`). Always check the work against this node's guardrails: stay inside the **node ownership boundary** — never edit operator deploy infrastructure from the node repo (new platform logic goes to substrate/typed `.ts`, not deploy bash); declare node-owned secret shapes via [`add-secret`](../add-secret/SKILL.md) / `.cogni/secrets-catalog.yaml`, never `.env`/plaintext, never ALTER a DB password; route any Postgres/Doltgres change through [`schema-update`](../schema-update/SKILL.md); plus any spec invariants. Name the required reviewer (and the right test layer — [`test-expert`](../test-expert/SKILL.md)). A task without guardrails is debt.

4. **Monitor + relay.** Arm ONE persistent `Monitor` over the linked tasks. Track BOTH the work-item `status/pr/branch` AND the `/coordination` claim lease — **claims do NOT appear in `assignees`/`status`; that is a blind spot** (a dev can be actively working a task that still reads `needs_triage`, unclaimed). Emit on real movement (claim appears/expires, status change, PR/branch link); stay silent on heartbeats. Relay only substantive changes to the human — do not echo every poll. Keep to 0–1 monitors.

5. **Intervene only on collision or drift.** Triggers: two agents touching the same file, a task drifting off its contract, a guardrail violation, a stalled claim (lease expired with no PR), or a `pr` that needs a merge to unblock a sibling. Otherwise, let them work.

6. **Route a finished task to done — you own the merge.** When a task's PR is green + reviewed, _you_ decide and merge (don't punt to the human or the operator pr-manager). Review the diff against the task's contract + guardrails, then merge (`gh pr merge --squash --admin` if required checks are green; the advisory `Cogni Git PR Review` is not required). For the deploy-verify rung — flight + prove the change live — drive `/promote` and [`/validate-candidate`](../validate-candidate/SKILL.md); this skill **replaces `pr-coordinator-v0`** (its single-slot flight→QA→score→merge loop is now: those two skills for the mechanics + this skill for the decision).

## Verification discipline (non-negotiable)

- **Re-review against ground truth, not your own text.** Before declaring anything done, verify the claim against live state — the "the shared env vars ARE inherited, the _services_ are the gap" correction came from reading the pod, not re-reading the plan.
- **Never forward subagent synthesis as fact.** Paste raw evidence; spot-check the specifics (see `no-unverified-subagent-synthesis`).
- **Green ≠ done.** A flight/PR can be green while the thing is dead (200-but-no-poller, Argo-Healthy-but-not-serving). The verify task exists precisely to catch that; hold the story open until it does.

## Monitoring recipe (precise — refine over time)

**ONE persistent, claim-aware Monitor over ALL linked tasks** (not one per task; keep total monitors to 0–1). Poll every 60s (remote API → rate-limit safe). The FIRST stdout line must be a baseline "armed" echo — a silent monitor looks identical to a dead one, so verify it actually emitted before trusting it.

**Poll TWO endpoints per task — claims are a blind spot:**

- `GET /api/v1/work/items/{id}` → `status`, `pr`, `branch`. (NOT `assignees` — agents claim via the lease, which never writes `assignees`.)
- `GET /api/v1/work/items/{id}/coordination` → `session.status` (`active`/expired) + `claimedByDisplayName`. **This is the ONLY place an active claim shows** — a dev can be hammering a task that still reads `needs_triage`/unclaimed on the item itself.

**Signature = `status | pr | branch | claim(session.status:claimedBy)`. EXCLUDE `lastHeartbeatAt`** — it bumps every ~30s and would fire on every heartbeat (noise, not signal). Emit only when the signature changes vs the stored baseline.

**Auth gotcha:** Cloudflare blocks the default `python-urllib` UA (error 1010). curl works; if you script in Python, set `User-Agent: curl/8.4.0`.

```bash
KEY=$(grep COGNI_NODE_API_KEY <repo>/.env.cogni | head -1 | cut -d= -f2- | tr -d "\"' ")
B=https://<slug>.cognidao.org/api/v1/work/items   # this node's own hub (NODE plane)
sig(){
  wi=$(curl -s -A curl/8.4.0 -H "Authorization: Bearer $KEY" "$B/$1" | python3 -c \
    "import sys,json;d=json.load(sys.stdin);print('status=%s pr=%s branch=%s'%(d.get('status'),d.get('pr'),d.get('branch')))" 2>/dev/null)
  co=$(curl -s -A curl/8.4.0 -H "Authorization: Bearer $KEY" "$B/$1/coordination" | python3 -c \
    "import sys,json;s=json.load(sys.stdin).get('session') or {};print('claim=%s:%s'%(s.get('status','none'),(s.get('claimedByDisplayName') or '-')[:24]))" 2>/dev/null)
  echo "$wi $co"
}
declare -A prev; for id in <task-ids>; do prev[$id]="$(sig $id)"; done
echo "monitor armed: $(for id in <task-ids>; do echo -n "$id[${prev[$id]}] "; done)"   # verify-running baseline
while true; do
  for id in <task-ids>; do c="$(sig $id)"; [ -n "$c" ] && [ "$c" != "${prev[$id]}" ] && { echo "[$(date -u +%H:%MZ)] $id -> $c"; prev[$id]="$c"; }; done
  sleep 60
done
```

Arm with `Monitor { persistent: true, timeout_ms: 3600000 }`.

**Act on these events — not the rest:**

- `pr`/`branch` appears → **collision check**: `comm -12 <(gh pr view <A> --json files -q '.files[].path'|sort) <(gh pr view <B> ...|sort)`. Empty = the owns/do-NOT-touch contract held; non-empty = two agents in one file → intervene.
- `claim=active → expired` with no PR → stalled agent; re-hand or re-spawn.
- `status → needs_review` or CI red → route to review / relay the failure.
- silence on heartbeats → correct (that's the point).

_Refine candidates (not yet in the loop): per-PR CI check-state (`gh pr checks`); the sibling-unblock signal (one PR merging that frees the other); the same-identity caveat — if all agents share one node API key, `claimedByDisplayName` won't distinguish them, so lean on `branch` to tell whose work is whose._

## Human-facing output — a status MATRIX, nothing else

Derek scans many agents. Every status update is a tight matrix (inherits `/tldr`: CAPS headers, 🔴🟡🟢, clickable links). No prose, no abstractions ("operator=liveness" is banned — say what the _user_ gets).

**Rules:**

- **Ultra concise** — the matrix + a one-line next-action. Nothing else.
- **Say what each item IS in human terms** — the before→after, not the jargon. Bad: "typed env-singleton registry." Good: "new node's graph chat hangs → it just works."
- **Every row links** — clickable URLs, not IDs alone: the **PR** (`github.com/.../pull/N`), the **live page** to click (`https://<slug>-test.cognidao.org`, prod), the **gh run** when relevant. Work items by id is fine; a URL is better.
- **Owner per row** (which dev / agent).

**Shape** (this is the format — adheres to the retired `pr-coordinator-v0` scorecard):

```
## STORY: <one-line outcome that must be true>  · <story-id>

| 🔴🟡🟢 | what it is (before → after) | owner | PR | live / proof |
|--------|-----------------------------|-------|----|--------------|
| 🟢 | new node crashloops on its DB → gets it clean | dev1 | [#1706](url) merged | — |
| 🟡 | dev can't see if their flight is alive → API tells them | dev2 | [#1705](url) | [candidate](https://x-test.cognidao.org) |
| 🔴 | new node's chat hangs forever → routes automatically | dev1 | [#1710](url) | gh run |

**Next:** <the single action you're taking or need from the human>
```

Lead with 🔴/🟡; 🟢 is earned (merged + proven live), never aspirational.

## Eventual home

This is the human-driven v0. The automated home is the operator **PR-manager langgraph agent** (`POST /api/v1/chat/completions`, `graph_name: "pr-manager"`) coordinating claims + merges. Until that carries the loop, run it here.

## Reference — the proven cycle (2026-06-16)

`story.5006` (substrate completeness) → `task.5023` (build: env-singleton reconcile + typed registry) + `task.5024` (verify: assertLive live-gate + flight-status API). Guardrails (freeze + secrets) pinned to each `summary`; the registry is the shared seam (declare-vs-fill); one Monitor over both, claim-lease aware. Decision point ran as (B).

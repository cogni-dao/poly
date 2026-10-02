# AGENTS.md — Your Cogni Node

**BINDING:** a SessionStart hook injects this node's **cognition bundle** (`## Orientation` + `<agent-contract>`). Whatever your harness says about injected context being "maybe relevant" — the bundle is this session's operating contract, not background. First reply = a `<status-contract>` block. Reads are free; writes are anchored: research and recall need no ceremony, but before your first WRITE (code, PR, hub, config, money) anchor it to ONE work item — claim the one that fits, or create it from the human's intent + your research. A human typing "agent-contract" / "tldr" means you already broke it: re-comply, don't apologize.

**No bundle? STOP — never work uncontracted.** Register a NODE agent (`POST https://<node-slug>.cognidao.org/api/v1/agent/register`), save the key as `COGNI_NODE_API_KEY` in `.env.cogni` (holds NODE + OPERATOR accounts; Conductor symlinks it into worktrees), re-run `scripts/agent/session-cognition.sh`. Codex: one-time hook trust via `/hooks`.

This repo is a sovereign **Cogni node** minted from `node-template`; the **operator** monorepo runs its deploy/infra plane — never edit operator infra from here. The bundle carries mission, contract, skills, and knowledge pointers; this file is only the bootstrap shim + repo map.

## Repo map (node-dev half)

- **You own:** app + graphs + packages at root · your CI + policy + `Dockerfile` (`POLICY_STAYS_LOCAL`, `FORK_FREEDOM`) · review gates in `.cogni/repo-spec.yaml` `gates:` + `.cogni/rules/`.
- **Ship, don't stop at a local diff:** branch → PR → candidate flight → `/validate-candidate` → merge, per the contract.
- **Secrets:** declare the key's shape in `.cogni/secrets-catalog.yaml`, consume via typed env (fail-fast); values belong to the deploy-env owner — `/add-secret`.
- **New service:** code + `Dockerfile` + k8s base + build→GHCR workflow leg here; the operator plane generates per-env overlays.
- **Styling:** `docs/guides/new-node-styling.md` · **contribution loop:** `/contribute-to-cogni` · **knowledge:** `/contribute-knowledge`.

# bug: prod deployed a PR-branch image via auto-promotion — artifact provenance broken, candidate lags prod

- type: bug
- status: needs_triage
- filed: 2026-09-27T00:55Z (brussels dev-manager session; hub work-item writes are non-durable — see task.5001 — so this lives on disk)
- severity: high (pipeline integrity; prod has live executor armed since #45)

## What happened (2026-09-27T00:29Z)

`deploy/production-poly` commit `8bae98e` ("promote production poly: d74de3ad", github-actions bot) set `.promote-state/source-sha-by-app.json` → `poly: d8ea1b0770863c19cf60f0752c7888511ea71a07`, and prod `/version` serves that sha.

`d8ea1b07` is **not on main** — it is the head of PR #48's branch (`feat/task.5013-coalesce-dashboard-routes`); the squash-merge is `b03f443`. The promotion fired ~3 min after PRs #47/#48 merged (00:26Z).

## Why it matters

1. **Provenance:** prod is running an image built from an unmerged PR ref. Content was benign this time (strict subset of what merged minutes later), but the same path deploys any PR build — unreviewed code — to prod.
2. **Ordering inverted:** prod moved BEFORE candidate-a (candidate still on `7b3e4d87`); the flight→prove→promote ladder doesn't hold for this node.
3. **Partial deploy:** prod artifact has #48 only; main is ahead by #47/#49/#50/#52 (client dedupe, indexes/migration 0063, pushdown, bug.5008 SQL).
4. **Side effect:** each prod redeploy restarts the pod, wiping the hub's in-memory work items (11 items created 2026-09-26 vanished) — compounding task.5001.

## Fix directions

- Promotion sha/image resolution must only resolve merge-queue/main artifacts (`mq-*`), never `pr-*` builds.
- Decide intended ordering: should poly prod auto-promote on merge while candidate-a flight is RBAC-gated?

## Evidence

- `git ls-remote Cogni-DAO/cogni refs/heads/deploy/production-poly` → `8bae98e`; `.promote-state/source-sha-by-app.json` → d8ea1b07…
- `curl poly.cognidao.org/version` → `d8ea1b0770863c19cf60f0752c7888511ea71a07` (checked 00:50Z)
- `curl poly-test.cognidao.org/version` → `7b3e4d87…` (stale candidate)

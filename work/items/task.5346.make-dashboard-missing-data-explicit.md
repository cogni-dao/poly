---
id: task.5346
type: task
title: Make missing dashboard position and P/L data explicit
status: in_progress
actor: ai
priority: 1
rank: 16
estimate: 2
summary: "Complete dashboard truth after wallet identity repair: unknown positions/P&L must remain unavailable and must never render as a zero book or cash-only Total."
outcome: "Dashboard API and cards distinguish unavailable from true zero for total value, positions, execution live count, and P/L."
spec_refs:
  - docs/porting/poly-port-policy.json
  - app/src/app/api/v1/poly/wallet/_lib/cash-on-chain.ts
  - app/src/features/wallet-analysis/server/trading-wallet-overview-service.ts
  - app/src/app/(app)/dashboard/_components/TradingWalletCard.tsx
  - app/src/app/(app)/dashboard/_components/ExecutionActivityCard.tsx
assignees: []
credit: null
project: null
parent: task.5344
branch: fix/task.5346-dashboard-missing-state
pr: null
reviewer: null
revision: 0
blocked_by: task.5344
deploy_verified: false
created: 2026-10-02
updated: 2026-10-02
labels:
  - parity
  - dashboard
  - missing-data
  - blocker
external_refs:
  - "stacked-on:PR-109"
node: poly
---

# Make missing dashboard position and P/L data explicit

Before: `sumWalletTotal` turns missing positions into zero, P/L lookup returns an empty series when the observed wallet is absent, and the UI renders `Live(0)` plus “No open positions.” Those are assertions of zero, not an unavailable state.

After: total remains null unless cash and marked positions are both known; missing position/P&L read models carry an explicit warning/status; dashboard cards render unavailable/partial language. True zero remains a distinct valid result.

Owns: cash/total helper semantics, trading-wallet overview missing-data signaling, the two dashboard cards, and focused acceptance coverage.

Do not touch: PR #109 wallet adapter/observer files, mirror/trading algorithms, work-item APIs, or the port-ledger implementation.

Gate: focused API/component evidence covers both missing and true-zero cases. Candidate proof remains in parent `task.5344` and must compare the same funder wallet against an independent oracle.

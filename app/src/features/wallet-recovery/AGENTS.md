# wallet-recovery · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Purpose

Owner-scoped recovery orchestration for broken Poly trading-wallet connections.
The feature accepts a session-derived tenant context and talks only through
ports; HTTP, database, and Privy details remain outside this layer.

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["ports", "shared", "types", "packages"],
  "must_not_import": ["app", "adapters", "bootstrap", "contracts"]
}
```

## Public Surface

- `resetWalletConnection()` — fail-closed owner reset orchestration.
- `WalletResetResult`, `WalletResetBlockedReason` — internal result model.

## Invariants

- Tenant identity is supplied by the authenticated delivery edge; no account selector comes from request input.
- Any cash, native balance, position exposure, unsettled order, or unreadable balance blocks revoke.
- Active copy targets are disabled on the first call and require a later retry before revoke.
- The feature never moves funds or deletes wallet history.

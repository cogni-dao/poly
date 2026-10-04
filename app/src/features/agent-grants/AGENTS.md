# agent-grants · AGENTS.md

> Scope: this directory only.

## Purpose

Owner-managed, expiring capability delegation between authenticated human and
machine principals.

## Public Surface

- `resolvePerformanceRead(tx, input)` — owner-or-active-delegate read decision.
- `listOwnedAgentGrants`, `replaceOwnedAgentGrant`, `revokeOwnedAgentGrant` —
  owner lifecycle operations that run inside an app-role tenant transaction.

## Invariants

- Story 1 consumes only `performance:read`.
- Missing, expired, revoked, and wrong-scope grants fail closed.
- Grant replacement is atomic and revocation is always a soft revoke.
- Callers use app-role transactions with `app.current_user_id` set; never use
  the service-role bypass.
